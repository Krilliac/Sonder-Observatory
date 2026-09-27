import { beforeEach, describe, expect, it, vi } from "vitest";

// Same Tauri IPC mock as desktop.test.ts.
const tauri = vi.hoisted(() => ({
    handlers: {} as Record<string, (args: Record<string, unknown>) => unknown>,
    calls: [] as { cmd: string; args: Record<string, unknown> | undefined }[],
}));

vi.mock("@tauri-apps/api/core", () => ({
    isTauri: () => true,
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
const bytes = (u8: Uint8Array) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
    const parts: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            return parts;
        }
        parts.push(value);
    }
}

beforeEach(() => {
    tauri.handlers = {};
    tauri.calls = [];
});

describe("desktop recording reads are bounded", () => {
    it("stops reading an entry once it passes the total size limit", async () => {
        const full = new Uint8Array(CHUNK);
        tauri.handlers.read_recording_entry = () => bytes(full); // never ends
        await expect(desktop.readRecordingEntry("rec-1", undefined, 2 * CHUNK)).rejects.toThrow(/limit/);
        expect(tauri.calls.length).toBeLessThanOrEqual(3);
    });

    it("streams an entry larger than one read instead of decoding it into one string", async () => {
        const total = CHUNK + 5;
        const source = new Uint8Array(total).fill(0x61);
        tauri.handlers.read_recording_entry = ({ offset, maxBytes }) =>
            bytes(source.subarray(offset as number, Math.min(total, (offset as number) + (maxBytes as number))));
        const opened = await desktop.readGrantText({ id: "rec-big", name: "big.sobs", kind: "file" });
        expect(opened.label).toBe("big.sobs");
        expect(opened.text).toBeUndefined();
        expect(opened.stream).toBeDefined();
        const parts = await drain(opened.stream!);
        expect(parts.reduce((n, p) => n + p.byteLength, 0)).toBe(total);
    });

    it("still returns small entries as text", async () => {
        tauri.handlers.read_recording_entry = () => bytes(new TextEncoder().encode("{}\n"));
        expect(await desktop.readGrantText({ id: "rec-small", name: "s.sobs", kind: "file" })).toEqual({ text: "{}\n", label: "s.sobs" });
    });
});
