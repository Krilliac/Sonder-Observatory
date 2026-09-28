import { describe, expect, it } from "vitest";
import { loadRecording } from "../../src/recording/sobs";
import { loadRecordingStream, MAX_RECORDING_BYTES } from "../../src/renderer/chunkedLoad";

const immediate = () => Promise.resolve();

function byteStream(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
    let pos = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (pos >= bytes.length) {
                controller.close();
                return;
            }
            controller.enqueue(bytes.slice(pos, pos + size));
            pos += size;
        },
    });
}

function event(i: number): string {
    return JSON.stringify({
        schema: "sonder.observatory.event/1",
        event_id: `evt_${i}`,
        sequence: i,
        event_type: "test.event",
        wall_time: "2026-09-26T08:00:00.000Z",
        mono_ns: i * 1000,
        session_id: "ses",
        producer: { name: "p", version: "1", node_id: "n" },
        attributes: {},
    });
}

describe("recording import limits", () => {
    it("has a total size limit of at least 1 GiB", () => {
        expect(MAX_RECORDING_BYTES).toBeGreaterThanOrEqual(1024 ** 3);
    });

    it("refuses a recording whose declared size is over the limit before reading it", async () => {
        let pulls = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulls += 1;
                controller.enqueue(new TextEncoder().encode(`${event(pulls)}\n`));
            },
        });
        await expect(loadRecordingStream(stream, { totalBytes: 2000, maxBytes: 1000, yieldToEventLoop: immediate })).rejects.toThrow(
            /larger than the 1000-byte limit/,
        );
        expect(pulls).toBeLessThanOrEqual(1);
    });

    it("stops reading a stream once it passes the limit", async () => {
        let pulls = 0;
        const endless = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulls += 1;
                controller.enqueue(new TextEncoder().encode(`${event(pulls)}\n`));
            },
        });
        await expect(loadRecordingStream(endless, { maxBytes: 10_000, yieldToEventLoop: immediate })).rejects.toThrow(
            /larger than the 10000-byte limit/,
        );
        expect(pulls).toBeLessThan(100);
    });

    it("rejects an overlong line without buffering it, keeping line numbers for the rest", async () => {
        const lines = [event(1), `{"pad":"${"x".repeat(5000)}"}`, event(2), event(3)];
        const text = `${lines.join("\n")}\n`;
        const got = await loadRecordingStream(byteStream(new TextEncoder().encode(text), 64), {
            maxLineChars: 1000,
            yieldToEventLoop: immediate,
        });
        expect(got.events.map((e) => e.event_id)).toEqual(["evt_1", "evt_2", "evt_3"]);
        expect(got.rejected).toHaveLength(1);
        expect(got.rejected[0]!.line).toBe(2);
        expect(got.rejected[0]!.reason).toMatch(/1000-character limit/);
        // Everything else matches the plain loader.
        const plain = loadRecording([event(1), "{}", event(2), event(3)].join("\n"));
        expect(got.events).toEqual(plain.events);
    });

    it("rejects an overlong unterminated last line", async () => {
        const text = `${event(1)}\n${"y".repeat(3000)}`;
        const got = await loadRecordingStream(byteStream(new TextEncoder().encode(text), 100), {
            maxLineChars: 1000,
            yieldToEventLoop: immediate,
        });
        expect(got.events).toHaveLength(1);
        expect(got.rejected.map((r) => r.line)).toEqual([2]);
    });
});
