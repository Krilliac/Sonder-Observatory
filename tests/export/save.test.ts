import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
    desktop: false,
    result: null as unknown,
    calls: [] as { cmd: string; args: Record<string, unknown> | undefined }[],
}));

vi.mock("@tauri-apps/api/core", () => ({
    isTauri: () => tauri.desktop,
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        tauri.calls.push({ cmd, args });
        if (cmd !== "save_export") {
            throw new Error(`unexpected command ${cmd}`);
        }
        return tauri.result;
    }),
}));

const exp = await import("../../src/export");
const { fixtureEvents, GENERATED_AT } = await import("./fixture");

function fakeHost() {
    const log: string[] = [];
    const blobs: Blob[] = [];
    const timers: (() => void)[] = [];
    const host: import("../../src/export").DownloadHost = {
        createObjectURL: (blob) => {
            blobs.push(blob);
            log.push("create");
            return "blob:fake/1";
        },
        revokeObjectURL: (url) => log.push(`revoke ${url}`),
        clickDownload: (href, name) => log.push(`click ${href} ${name}`),
        setTimeout: (fn) => timers.push(fn),
    };
    return { host, log, blobs, timers };
}

beforeEach(() => {
    tauri.desktop = false;
    tauri.result = null;
    tauri.calls = [];
});

describe("export file names", () => {
    it("builds safe, format-specific names", () => {
        expect(exp.suggestedFileName("html", "ses_1", GENERATED_AT)).toBe("observatory-ses_1-2026-09-26T12-00-00Z-report.html");
        expect(exp.suggestedFileName("markdown", "ses/../x y", GENERATED_AT)).toBe("observatory-ses_.._x_y-2026-09-26T12-00-00Z-summary.md");
        expect(exp.suggestedFileName("json", undefined, GENERATED_AT)).toBe("observatory-session-2026-09-26T12-00-00Z-findings.json");
        expect(exp.suggestedFileName("sobs", "ses_1", GENERATED_AT)).toBe("observatory-ses_1-2026-09-26T12-00-00Z.sobs");
    });
});

describe("saving in a browser", () => {
    it("downloads a Blob and revokes the object URL afterwards", async () => {
        const { host, log, blobs, timers } = fakeHost();
        const res = await exp.saveText("r.md", "# hi\n", "markdown", { host });
        expect(res).toEqual({ name: "r.md", via: "download" });
        expect(log).toEqual(["create", "click blob:fake/1 r.md"]);
        expect(blobs[0]!.type).toBe("text/markdown;charset=utf-8");
        expect(await blobs[0]!.text()).toBe("# hi\n");
        timers.forEach((t) => t());
        expect(log.at(-1)).toBe("revoke blob:fake/1");
        expect(tauri.calls).toEqual([]);
    });

    it("exportSession renders and downloads; nothing for an empty session", async () => {
        const { host, blobs } = fakeHost();
        const events = fixtureEvents();
        const res = await exp.exportSession("html", { events, generatedAt: GENERATED_AT }, { host });
        expect(res?.name).toBe("observatory-ses_synthetic_0001-2026-09-26T12-00-00Z-report.html");
        expect(blobs[0]!.type).toBe("text/html;charset=utf-8");
        expect(await blobs[0]!.text()).toBe(exp.renderExport("html", { events, generatedAt: GENERATED_AT }).content);
        expect(await exp.exportSession("html", { events: [] }, { host })).toBeNull();
    });
});

describe("saving on desktop (Tauri)", () => {
    it("calls save_export with the suggested name, content and filter", async () => {
        tauri.desktop = true;
        tauri.result = { name: "chosen.sobs" };
        const res = await exp.saveText("observatory.sobs", "{}\n", "sobs");
        expect(res).toEqual({ name: "chosen.sobs", via: "desktop" });
        expect(tauri.calls).toEqual([
            {
                cmd: "save_export",
                args: { suggestedName: "observatory.sobs", content: "{}\n", filterName: "Observatory recording (.sobs)", extensions: ["sobs"] },
            },
        ]);
    });

    it("returns null when the dialog is cancelled", async () => {
        tauri.desktop = true;
        tauri.result = null;
        const { host, log } = fakeHost();
        expect(await exp.saveText("a.json", "{}", "json", { host })).toBeNull();
        expect(log).toEqual([]); // no browser fallback
    });

    it("lists every format with its extension", () => {
        expect(exp.EXPORT_FORMAT_IDS).toEqual(["html", "markdown", "json", "sobs"]);
        expect(Object.values(exp.EXPORT_FORMATS).map((f) => f.extension)).toEqual(["html", "md", "json", "sobs"]);
    });
});
