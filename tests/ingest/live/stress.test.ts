import { describe, expect, it } from "vitest";
import { startFakeLiveProducer } from "../../../scripts/fake-live-producer.mjs";
import { openHttpStream, type TransportCallbacks } from "../../../src/ingest/live/transports";
import { LiveIngestClient } from "../../../src/ingest/live/client";
import type { ObservatoryEvent } from "../../../src/protocol/events";
import { SessionStore } from "../../../src/replay/session";

/** Ordinary contiguous telemetry; finite streams leave no recordings or listeners behind. */
function events(count: number): ObservatoryEvent[] {
    return Array.from({ length: count }, (_, sequence) => ({
        schema: "sonder.observatory.event/1",
        event_id: `stress-${sequence}`,
        sequence,
        event_type: "stress.tick",
        wall_time: "2026-10-04T00:00:00.000Z",
        mono_ns: 1_000_000_000 + sequence * 1000,
        session_id: "stress",
        producer: { name: "synthetic-stress", version: "1", node_id: "local", synthetic: true },
        attributes: { sequence },
    }));
}

describe("live transport stress with bounded retention", () => {
    it.each(["sse", "ndjson"] as const)("resumes partial %s adapter fanout from the last complete producer cursor", async (transport) => {
        const source = events(8);
        const fanout = source.slice(1);
        const frame = (event: ObservatoryEvent) => transport === "sse"
            ? `id: producer-${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`
            : JSON.stringify(event) + "\n";
        let calls = 0;
        const resumes: (string | null)[] = [];
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => { release = resolve; });
        let hold = true;
        const store = new SessionStore();
        const client = new LiveIngestClient({
            url: `http://127.0.0.1:8766/${transport}`,
            fetch: async (_url, init) => {
                resumes.push(new Headers(init?.headers).get("Last-Event-ID"));
                const wire = (calls++ === 0 ? frame(source[0]!) : "") + frame(source[1]!);
                const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(wire)); } });
                return new Response(body, { headers: { "Content-Type": transport === "sse" ? "text/event-stream" : "application/x-ndjson" } });
            },
            adapter: (value) => (value as ObservatoryEvent).event_id === "stress-1" ? fanout : value,
            bufferCapacity: 4,
            batchSize: 2,
            flushIntervalMs: 1,
            sink: { append: async (batch) => {
                store.append(batch);
                if (hold && batch.some((event) => event.event_id === "stress-1")) {
                    await blocked;
                }
            } },
        });
        try {
            client.start();
            await expect.poll(() => store.events.length).toBe(2);
            expect(client.status.lastEventId).toBe(transport === "sse" ? "producer-0" : "stress-0");
            const stopped = client.stop();
            release();
            await stopped;
            hold = false;
            client.start();
            await expect.poll(() => store.events.length).toBe(source.length);
            await expect.poll(() => client.status.lastEventId).toBe(transport === "sse" ? "producer-1" : "stress-1");
            expect(resumes).toEqual([null, transport === "sse" ? "producer-0" : "stress-0"]);
            expect(store.events).toEqual(source);
            expect(store.duplicates).toBeGreaterThan(0);
            expect(client.status.dropped).toBe(0);
        } finally {
            release();
            await client.stop();
        }
    });

    it("keeps the prior NDJSON producer cursor when an adapter source has no envelope cursor", async () => {
        const source = events(8);
        const wire = JSON.stringify(source[0]) + "\n" + JSON.stringify({ batch: source.slice(1) }) + "\n";
        const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(wire)); } });
        const store = new SessionStore();
        const client = new LiveIngestClient({
            url: "http://127.0.0.1:8766/ndjson",
            fetch: async () => new Response(body, { headers: { "Content-Type": "application/x-ndjson" } }),
            adapter: (value) => (value as { batch?: unknown }).batch ?? value,
            bufferCapacity: 4,
            batchSize: 2,
            flushIntervalMs: 1,
            sink: { append: (batch) => { store.append(batch); } },
        });
        try {
            client.start();
            await expect.poll(() => store.events.length).toBe(source.length);
            expect(client.status.lastEventId).toBe("stress-0");
            expect(store.events).toEqual(source);
        } finally {
            await client.stop();
        }
    });

    it("cancels the HTTP body when an ordinary asynchronous consumer rejects", async () => {
        let cancelled = 0;
        let done!: () => void;
        const finished = new Promise<void>((resolve) => { done = resolve; });
        const body = new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(events(1)[0]) + "\n")); },
            cancel() { cancelled += 1; },
        });
        const callbacks: TransportCallbacks = {
            onOpen: () => {},
            onPayload: async () => { throw new Error("consumer unavailable"); },
            onInvalidFrame: () => {},
            onRetryHint: () => {},
            onClose: () => { done(); },
            waitForCapacity: async () => {},
        };
        const handle = openHttpStream({ url: "http://127.0.0.1:8766/ndjson", kind: "ndjson", lastEventId: null, resumeParam: "last_event_id" }, callbacks,
            async () => new Response(body, { headers: { "Content-Type": "application/x-ndjson" } }));
        try {
            await finished;
            expect(cancelled).toBe(1);
            expect(body.locked).toBe(false);
        } finally {
            handle.close();
        }
    });

    it.each(["sse", "ndjson"] as const)("pauses within one ordinary coalesced %s chunk before overflowing the queue", async (transport) => {
        const source = events(24);
        const wire = transport === "sse"
            ? source.map((event) => `id: ${event.event_id}\ndata: ${JSON.stringify(event)}\n\n`).join("")
            : source.map((event) => JSON.stringify(event)).join("\n") + "\n";
        const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(wire)); } });
        const store = new SessionStore();
        const client = new LiveIngestClient({
            url: `http://127.0.0.1:8766/${transport}`,
            fetch: async () => new Response(body, { headers: { "Content-Type": transport === "sse" ? "text/event-stream" : "application/x-ndjson" } }),
            bufferCapacity: 4,
            batchSize: 2,
            flushIntervalMs: 1,
            sink: { append: (batch) => { store.append(batch); } },
        });
        try {
            client.start();
            await expect.poll(() => client.status.appended + client.status.dropped).toBe(source.length);
            expect(client.status.dropped).toBe(0);
            expect(store.events).toEqual(source);
            expect(client.status.lastEventId).toBe("stress-23");
        } finally {
            await client.stop();
        }
    });

    it.each(["sse", "ndjson"] as const)("retains the live edge without transport loss across repeated %s resumes", async (transport) => {
        const count = 60_000;
        const producer = await startFakeLiveProducer({
            events: events(count) as unknown as Record<string, unknown>[],
            batch: 128,
            disconnectAfter: 15_000,
            retryMs: 10,
        });
        const store = new SessionStore({ maxLiveEvents: 4096 });
        store.reset("live", producer.urls[transport]);
        let maxBuffered = 0;
        const client = new LiveIngestClient({
            url: producer.urls[transport],
            bufferCapacity: 256,
            batchSize: 128,
            flushIntervalMs: 1,
            backoff: { initialMs: 10, maxMs: 20, jitter: 0 },
            onStatus: (status) => { maxBuffered = Math.max(maxBuffered, status.buffered); },
            sink: { append: (batch) => { store.append(batch); } },
        });
        try {
            client.start();
            await expect.poll(() => client.status.appended + client.status.dropped, { timeout: 25_000, interval: 20 }).toBe(count);
            expect(client.status.received).toBe(count);
            expect(client.status.dropped).toBe(0);
            expect(client.status.rejected).toBe(0);
            expect(maxBuffered).toBeLessThanOrEqual(256);
            expect(client.status.reconnects).toBeGreaterThanOrEqual(3);
            // The finite stream may reconnect once more at EOF while the final batch drains.
            expect(producer.stats.resumed.length).toBeGreaterThanOrEqual(3);
            expect(store.events.length).toBeLessThanOrEqual(4096);
            expect(store.droppedByRetention + store.events.length).toBe(count);
            expect(store.events.map((event) => event.sequence)).toEqual(
                Array.from({ length: store.events.length }, (_, index) => count - store.events.length + index),
            );
            expect(store.duplicates).toBe(0);
            expect(store.gaps).toEqual([]);
            expect(store.synthetic).toBe(true);
        } finally {
            await client.stop();
            await producer.close();
        }
        expect(client.status.state).toBe("closed");
        expect(client.status.buffered).toBe(0);
    }, 30_000);
});
