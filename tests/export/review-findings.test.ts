/**
 * Regression tests for the PR #23 review findings:
 *  1. filtered `.sobs` exports keep the source session's capture policy;
 *  2. exports carrying full text / tool payloads need an explicit acknowledgement;
 *  3. the markdown summary stays within its advertised 65 536-character budget.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ObservatoryEvent } from "../../src/protocol/events";

const tauri = vi.hoisted(() => ({
    desktop: false,
    calls: [] as { cmd: string; args: Record<string, unknown> | undefined }[],
}));

vi.mock("@tauri-apps/api/core", () => ({
    isTauri: () => tauri.desktop,
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        tauri.calls.push({ cmd, args });
        return { name: "chosen.html" };
    }),
}));

const exp = await import("../../src/export");
const { loadRecording } = await import("../../src/recording/sobs");
const { fixtureEvents, GENERATED_AT } = await import("./fixture");

type Mutable = { -readonly [K in keyof ObservatoryEvent]: ObservatoryEvent[K] };

/** Deep copy of the fixture with `edit` applied to every event. */
function variant(edit: (e: Mutable) => void): ObservatoryEvent[] {
    return fixtureEvents().map((e) => {
        const copy = structuredClone(e) as Mutable;
        edit(copy);
        return copy;
    });
}

function withTextCapture(policy: string): ObservatoryEvent[] {
    return variant((e) => {
        if (e.event_type === "session.started") {
            e.attributes = { ...e.attributes, text_capture: policy };
        }
    });
}

function fakeHost() {
    const blobs: Blob[] = [];
    const host: import("../../src/export/save").DownloadHost = {
        createObjectURL: (blob) => {
            blobs.push(blob);
            return "blob:fake/1";
        },
        revokeObjectURL: () => {},
        clickDownload: () => {},
        setTimeout: () => undefined,
    };
    return { host, blobs };
}

beforeEach(() => {
    tauri.desktop = false;
    tauri.calls = [];
});

describe("finding 1: filtered .sobs keeps the source capture policy", () => {
    const events = withTextCapture("full");
    for (const range of [{ cls: "error" as const }, { text: "tool" }, { fromNs: events[100]!.mono_ns, toNs: events[300]!.mono_ns }]) {
        it(`range ${JSON.stringify(range)}`, () => {
            const selected = exp.filterEvents(events, range);
            expect(selected.some((e) => e.event_type === "session.started")).toBe(false);
            const loaded = loadRecording(exp.renderSobs(events, range, GENERATED_AT));
            expect(loaded.manifest?.capture_policy).toBe("full");
            expect(loaded.events).toEqual(selected);
        });
    }

    it("still reports unspecified when the source declares nothing", () => {
        const events = variant((e) => {
            if (e.event_type === "session.started") {
                const rest = { ...e.attributes };
                delete rest.text_capture;
                e.attributes = rest;
            }
        });
        expect(loadRecording(exp.renderSobs(events, { cls: "error" }, GENERATED_AT)).manifest?.capture_policy).toBe("unspecified");
    });
});

describe("finding 2: sensitive exports require an explicit acknowledgement", () => {
    const fullText = withTextCapture("full");
    const toolPayload = variant((e) => {
        if (e.event_type === "tool.called") {
            e.attributes = { ...e.attributes, args: "cat ~/.ssh/config" };
        }
    });

    it("browser download: refuses a full-text session without acknowledgement and writes nothing", async () => {
        const { host, blobs } = fakeHost();
        await expect(exp.exportSession("html", { events: fullText, generatedAt: GENERATED_AT }, { host })).rejects.toThrow(/sensitive/i);
        expect(blobs).toHaveLength(0);
    });

    it("desktop save: refuses tool payloads without acknowledgement and never invokes save_export", async () => {
        tauri.desktop = true;
        await expect(exp.exportSession("sobs", { events: toolPayload, generatedAt: GENERATED_AT })).rejects.toThrow(/sensitive/i);
        expect(tauri.calls).toEqual([]);
    });

    it("writes once the warning has been acknowledged (browser and desktop)", async () => {
        const { host, blobs } = fakeHost();
        const res = await exp.exportSession("markdown", { events: fullText, generatedAt: GENERATED_AT }, { host, acknowledgeSensitive: true });
        expect(res?.via).toBe("download");
        expect(blobs).toHaveLength(1);
        tauri.desktop = true;
        const saved = await exp.exportSession("json", { events: toolPayload, generatedAt: GENERATED_AT }, { acknowledgeSensitive: true });
        expect(saved).toEqual({ name: "chosen.html", via: "desktop" });
        expect(tauri.calls).toHaveLength(1);
    });

    it("assesses policy and payloads; redacted fixture needs no warning", () => {
        expect(exp.assessExportSensitivity(fixtureEvents()).sensitive).toBe(false);
        const a = exp.assessExportSensitivity(fullText);
        expect(a).toMatchObject({ sensitive: true, fullText: true, toolPayloads: false });
        expect(exp.assessExportSensitivity(withTextCapture("on")).fullText).toBe(true); // Sonder-Inference vocabulary
        expect(exp.assessExportSensitivity(withTextCapture("redacted")).sensitive).toBe(false);
        const b = exp.assessExportSensitivity(toolPayload);
        expect(b).toMatchObject({ sensitive: true, fullText: false, toolPayloads: true });
        // Full-text policy is session-wide: a filtered range still counts.
        expect(exp.assessExportSensitivity(fullText, { cls: "error" }).fullText).toBe(true);
    });

    it("exportWithConfirmation asks only when sensitive and writes nothing when declined", async () => {
        const { host, blobs } = fakeHost();
        const confirm = vi.fn(async () => false);
        expect(await exp.exportWithConfirmation("html", { events: fullText, generatedAt: GENERATED_AT }, confirm, { host })).toBeNull();
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(blobs).toHaveLength(0);

        confirm.mockResolvedValue(true);
        expect((await exp.exportWithConfirmation("html", { events: fullText, generatedAt: GENERATED_AT }, confirm, { host }))?.via).toBe("download");
        expect(blobs).toHaveLength(1);

        confirm.mockClear();
        await exp.exportWithConfirmation("html", { events: fixtureEvents(), generatedAt: GENERATED_AT }, confirm, { host });
        expect(confirm).not.toHaveBeenCalled();
        expect(blobs).toHaveLength(2);
    });

    it("warning text names what is present", () => {
        const w = exp.sensitiveExportWarning(exp.assessExportSensitivity(toolPayload));
        expect(w.title).toMatch(/sensitive/i);
        expect(w.items.join(" ")).toMatch(/tool/i);
    });

    it("the public entry point does not expose the unguarded write primitives", () => {
        expect("saveText" in exp).toBe(false);
        expect("downloadText" in exp).toBe(false);
    });
});

describe("finding 3: markdown budget holds for producer-controlled strings", () => {
    it("bounds huge producer names, ids and summaries with a truncation marker", () => {
        const huge = "p".repeat(200_000);
        const events = variant((e) => {
            e.producer = { ...e.producer, name: huge };
        });
        const md = exp.renderMarkdown(exp.buildReport({ events, generatedAt: GENERATED_AT }));
        expect(md.length).toBeLessThanOrEqual(65_536);
        expect(md).toContain("…");
    });

    it("applies a final character budget even when every field is oversized", () => {
        const report = exp.buildReport({ events: fixtureEvents(), generatedAt: GENERATED_AT });
        const big = (n: number) => "x".repeat(n);
        report.title = big(100_000);
        report.source.producers = Array.from({ length: 5_000 }, (_, i) => `producer-${i}-${big(50)}`);
        report.source.sessionIds = Array.from({ length: 5_000 }, (_, i) => `ses-${i}-${big(50)}`);
        report.source.range = big(100_000);
        // 50 findings (the default cap) of maximal size: per-field clipping alone is not enough.
        report.findings = Array.from({ length: 50 }, (_, i) => structuredClone(report.findings[i % report.findings.length]!));
        for (const f of report.findings) {
            f.summary = big(20_000);
            f.id = big(20_000);
            (f as { kind: string }).kind = big(20_000); // producer-shaped string, wider than the union
            for (const ev of f.evidence) {
                ev.eventId = big(5_000);
                ev.eventType = big(5_000);
            }
        }
        const md = exp.renderMarkdown(report);
        expect(md.length).toBeLessThanOrEqual(65_536);
        expect(md).toMatch(/truncated/i);
        expect(md.startsWith("## ")).toBe(true);
        expect(md.split("<details>").length).toBe(md.split("</details>").length);
    });

    it("honours a smaller budget and closes an open <details> block", () => {
        const report = exp.buildReport({ events: fixtureEvents(), generatedAt: GENERATED_AT });
        const full = exp.renderMarkdown(report);
        const cutAt = full.indexOf("<details>") + 400;
        const md = exp.renderMarkdown(report, { maxChars: cutAt });
        expect(md.length).toBeLessThanOrEqual(cutAt);
        expect(md).toMatch(/truncated/i);
        expect(md.split("<details>").length).toBe(md.split("</details>").length);
        expect(exp.renderMarkdown(report, { maxChars: full.length })).toBe(full);
    });
});
