import { describe, expect, it } from "vitest";
import { buildReport, EXPORT_FORMAT, filterEvents, renderExport, renderJson, renderSobs, type JsonExport } from "../../src/export";
import { loadRecording, RECORDING_FORMAT } from "../../src/recording/sobs";
import { fixtureEvents, GENERATED_AT } from "./fixture";

const events = fixtureEvents();

describe("JSON export", () => {
    it("contains findings and metrics exactly as derived", () => {
        const report = buildReport({ events, generatedAt: GENERATED_AT });
        const parsed = JSON.parse(renderJson(report)) as JsonExport;
        expect(parsed.format).toBe(EXPORT_FORMAT);
        expect(parsed.generated_at).toBe("2026-09-26T12:00:00.000Z");
        expect(parsed.metrics).toEqual(JSON.parse(JSON.stringify(report.metrics)));
        expect(parsed.findings).toEqual(JSON.parse(JSON.stringify(report.findings)));
        expect(parsed.findings.every((f) => f.evidence.length === f.evidenceEventIds.length)).toBe(true);
        expect(parsed.source.exportedEvents).toBe(events.length);
        expect(Object.keys(parsed)).toEqual(["format", "title", "generated_at", "source", "metrics", "findings"]);
    });

    it("is deterministic for a fixed stamp", () => {
        const a = renderExport("json", { events, generatedAt: GENERATED_AT }).content;
        const b = renderExport("json", { events, generatedAt: GENERATED_AT }).content;
        expect(a).toBe(b);
        expect(a.endsWith("}\n")).toBe(true);
    });
});

describe(".sobs export round-trip", () => {
    const cases = [
        { name: "full session", range: {} },
        { name: "error class", range: { cls: "error" as const } },
        { name: "text filter", range: { text: "agent" } },
        { name: "time window", range: { fromNs: events[100]!.mono_ns, toNs: events[300]!.mono_ns } },
    ];

    for (const c of cases) {
        it(`round-trips the ${c.name}`, () => {
            const selected = filterEvents(events, c.range);
            expect(selected.length).toBeGreaterThan(0);
            const text = renderSobs(events, c.range, GENERATED_AT);
            const loaded = loadRecording(text);
            expect(loaded.rejected).toEqual([]);
            expect(loaded.manifest?.format).toBe(RECORDING_FORMAT);
            expect(loaded.manifest?.event_count).toBe(selected.length);
            expect(loaded.manifest?.created_at).toBe("2026-09-26T12:00:00.000Z");
            expect(loaded.events).toEqual(selected);
            // Re-serialising the loaded events (with the manifest's carried capture policy) is byte-identical.
            expect(renderSobs(loaded.events, {}, GENERATED_AT, { capturePolicy: loaded.manifest!.capture_policy })).toBe(text);
        });
    }

    it("keeps the full session byte-for-byte after the manifest line", () => {
        const text = renderExport("sobs", { events, generatedAt: GENERATED_AT }).content;
        const lines = text.trimEnd().split("\n");
        expect(lines).toHaveLength(events.length + 1);
        expect(lines.slice(1).map((l) => JSON.parse(l))).toEqual(events);
        expect(loadRecording(text).manifest?.complete).toBe(true);
    });
});
