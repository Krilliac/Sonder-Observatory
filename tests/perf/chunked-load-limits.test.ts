import { describe, expect, it } from "vitest";
import { loadRecording } from "../../src/recording/sobs";
import {
    loadRecordingChunked,
    loadRecordingStream,
    MAX_RECORDING_BYTES,
    MAX_RECORDING_EVENTS,
    MAX_RECORDING_HEAP_BYTES,
} from "../../src/renderer/chunkedLoad";
import { SessionStore } from "../../src/replay/session";

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

    it("stops cleanly with a partial-recording indicator when maxEvents is reached", async () => {
        expect(MAX_RECORDING_EVENTS).toBeGreaterThanOrEqual(100_000);
        expect(MAX_RECORDING_HEAP_BYTES).toBeGreaterThanOrEqual(128 * 1024 * 1024);

        const text = Array.from({ length: 20 }, (_, i) => event(i + 1)).join("\n") + "\n";
        const sync = loadRecording(text, { maxEvents: 7 });
        expect(sync.events).toHaveLength(7);
        expect(sync.truncated).toMatchObject({ reason: "event-limit", limit: 7, loadedEvents: 7 });
        expect(sync.truncated?.message).toMatch(/Partial recording loaded/);

        const chunked = await loadRecordingChunked(text, { maxEvents: 7, chunkChars: 500, yieldToEventLoop: immediate });
        expect(chunked.events).toEqual(sync.events);
        expect(chunked.truncated).toEqual(sync.truncated);

        let pulls = 0;
        const endless = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulls += 1;
                controller.enqueue(new TextEncoder().encode(`${event(pulls)}\n`));
            },
        });
        const streamed = await loadRecordingStream(endless, { maxEvents: 5, yieldToEventLoop: immediate });
        expect(streamed.events).toHaveLength(5);
        expect(streamed.truncated).toMatchObject({ reason: "event-limit", limit: 5, loadedEvents: 5 });
        // Stream was cancelled immediately upon hitting the budget rather than reading indefinitely.
        expect(pulls).toBeLessThan(20);
    });

    it("stops cleanly with a partial-recording indicator when maxHeapBytes is reached", async () => {
        const bigEvent = (i: number) =>
            JSON.stringify({
                schema: "sonder.observatory.event/1",
                event_id: `big_${i}`,
                sequence: i,
                event_type: "test.event",
                wall_time: "2026-09-26T08:00:00.000Z",
                mono_ns: i * 1000,
                session_id: "ses",
                producer: { name: "p", version: "1", node_id: "n" },
                attributes: { payload: "p".repeat(1500) },
            });
        const text = Array.from({ length: 15 }, (_, i) => bigEvent(i + 1)).join("\n") + "\n";

        const sync = loadRecording(text, { maxHeapBytes: 15_000 });
        expect(sync.events.length).toBeGreaterThan(0);
        expect(sync.events.length).toBeLessThan(15);
        expect(sync.truncated).toMatchObject({ reason: "heap-budget", limit: 15_000, loadedEvents: sync.events.length });
        expect(sync.truncated?.message).toMatch(/Partial recording loaded.*memory budget/);

        const streamed = await loadRecordingStream(byteStream(new TextEncoder().encode(text), 512), {
            maxHeapBytes: 15_000,
            yieldToEventLoop: immediate,
        });
        expect(streamed.events).toEqual(sync.events);
        expect(streamed.truncated).toEqual(sync.truncated);

        // SessionStore also enforces file budgets and surfaces partialRecordingNotice.
        const store = new SessionStore({ maxRecordingEvents: 4, maxRecordingBytes: 50_000 });
        store.reset("file", "crafted.sobs");
        store.append(loadRecording(text).events);
        expect(store.events).toHaveLength(4);
        expect(store.truncatedRecording).toMatchObject({ reason: "event-limit", limit: 4, loadedEvents: 4 });
        expect(store.partialRecordingNotice).toMatch(/Partial recording loaded/);
    });
});
