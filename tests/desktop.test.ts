import { beforeEach, describe, expect, it, vi } from "vitest";

// The Tauri IPC layer is mocked: `invoke` is routed to per-test handlers and
// `isTauri` is switchable, so the bridge can be exercised without a webview.
const tauri = vi.hoisted(() => ({
    desktop: true,
    handlers: {} as Record<string, (args: Record<string, unknown>) => unknown>,
    calls: [] as { cmd: string; args: Record<string, unknown> | undefined }[],
}));

vi.mock("@tauri-apps/api/core", () => ({
    isTauri: () => tauri.desktop,
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        tauri.calls.push({ cmd, args });
        const handler = tauri.handlers[cmd];
        if (!handler) {
            throw new Error(`unexpected command ${cmd}`);
        }
        return handler(args ?? {});
    }),
}));

const desktop = await import("../src/integrations/desktop");

const CHUNK = 16 * 1024 * 1024;
const encode = (s: string) => new TextEncoder().encode(s);
const bytes = (u8: Uint8Array) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

beforeEach(() => {
    tauri.desktop = true;
    tauri.handlers = {};
    tauri.calls = [];
});

describe("desktop bridge (browser)", () => {
    it("is inert outside the Tauri shell", async () => {
        tauri.desktop = false;
        expect(desktop.isDesktop()).toBe(false);
        expect(await desktop.getLaunchInfo()).toBeNull();
        expect(await desktop.openRecordingNative()).toBeNull();
        expect(await desktop.listRecentRecordings()).toEqual([]);
        await desktop.clearRecentRecordings();
        expect(tauri.calls).toEqual([]);
    });
});

describe("desktop bridge (Tauri mocked)", () => {
    it("reads launch info", async () => {
        const info = { connect: "ws://127.0.0.1:7070", session: null, capability: null, open: null, warnings: ["x"] };
        tauri.handlers.get_launch_args = () => info;
        expect(desktop.isDesktop()).toBe(true);
        expect(await desktop.getLaunchInfo()).toEqual(info);
    });

    it("reads entries in 16 MiB chunks and joins them", async () => {
        const total = CHUNK + 5;
        const source = new Uint8Array(total);
        source[0] = 1;
        source[CHUNK] = 2;
        source[total - 1] = 3;
        tauri.handlers.read_recording_entry = ({ offset, maxBytes }) =>
            bytes(source.subarray(offset as number, Math.min(total, (offset as number) + (maxBytes as number))));
        const out = await desktop.readRecordingEntry("rec-1");
        expect(out.byteLength).toBe(total);
        expect([out[0], out[CHUNK], out[total - 1]]).toEqual([1, 2, 3]);
        expect(tauri.calls.map((c) => c.args?.offset)).toEqual([0, CHUNK]);
        expect(tauri.calls[0]?.args).toMatchObject({ grant: "rec-1", entry: undefined, maxBytes: CHUNK });
    });

    it("opens a .sobs file through the native dialog", async () => {
        tauri.handlers.pick_recording = ({ folder }) => {
            expect(folder).toBe(false);
            return { id: "rec-1", name: "run.sobs", kind: "file" };
        };
        tauri.handlers.read_recording_entry = () => bytes(encode('{"format":"x"}\n'));
        expect(await desktop.openRecordingNative()).toEqual({ text: '{"format":"x"}\n', label: "run.sobs" });
    });

    it("returns null when the dialog is cancelled", async () => {
        tauri.handlers.pick_recording = () => null;
        expect(await desktop.openRecordingNative()).toBeNull();
        expect(tauri.calls.map((c) => c.cmd)).toEqual(["pick_recording"]);
    });

    it("reads the events entry of a session folder", async () => {
        tauri.handlers.list_recording_entries = () => [
            { path: "manifest.json", size: 2 },
            { path: "events.ndjson", size: 4 },
        ];
        tauri.handlers.read_recording_entry = ({ entry }) => {
            expect(entry).toBe("events.ndjson");
            return bytes(encode("{}\n"));
        };
        const opened = await desktop.readGrantText({ id: "rec-2", name: "session", kind: "folder" });
        expect(opened).toEqual({ text: "{}\n", label: "session (events.ndjson)" });
    });

    it("rejects a folder without events", async () => {
        tauri.handlers.list_recording_entries = () => [{ path: "manifest.json", size: 2 }];
        await expect(desktop.readGrantText({ id: "rec-3", name: "empty", kind: "folder" })).rejects.toThrow(/empty: no events/);
    });

    it("lists, re-opens and clears recent recordings", async () => {
        const recent = [{ id: "recent-00ab", name: "run.sobs", kind: "file", available: true }];
        tauri.handlers.list_recent_recordings = () => recent;
        tauri.handlers.open_recent_recording = ({ id }) => ({ id: "rec-9", name: `from ${String(id)}`, kind: "file" });
        tauri.handlers.read_recording_entry = () => bytes(encode("x"));
        tauri.handlers.clear_recent_recordings = () => null;
        expect(await desktop.listRecentRecordings()).toEqual(recent);
        expect(await desktop.openRecentRecordingText("recent-00ab")).toEqual({ text: "x", label: "from recent-00ab" });
        await desktop.clearRecentRecordings();
        expect(tauri.calls.map((c) => c.cmd)).toEqual([
            "list_recent_recordings",
            "open_recent_recording",
            "read_recording_entry",
            "clear_recent_recordings",
        ]);
    });

    it("surfaces command errors", async () => {
        tauri.handlers.pick_recording = () => {
            throw new Error("unknown recording grant");
        };
        await expect(desktop.openRecordingNative()).rejects.toThrow("unknown recording grant");
    });
});
