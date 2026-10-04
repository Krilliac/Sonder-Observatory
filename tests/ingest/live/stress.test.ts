import { describe, expect, it } from "vitest";
import { startFakeLiveProducer } from "../../../scripts/fake-live-producer.mjs";
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
