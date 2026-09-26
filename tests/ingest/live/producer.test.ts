/**
 * Live ingest against scripts/fake-live-producer.mjs on a loopback port:
 * every transport, reconnect + resume, ordering and drops under load.
 */
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
    startFakeLiveProducer,
    type FakeLiveProducer,
    type FakeLiveProducerOptions,
} from "../../../scripts/fake-live-producer.mjs";
import { LiveIngestClient, type LiveIngestOptions } from "../../../src/ingest/live/client";
import type { TransportKind } from "../../../src/ingest/live/endpoint";
import { connectLiveSession } from "../../../src/ingest/live/session";
import type { ObservatoryEvent } from "../../../src/protocol/events";
import { compareEvents } from "../../../src/replay/order";
import { SessionStore } from "../../../src/replay/session";
import type { WebSocketLike } from "../../../src/transport/live";

const wsFactory = (url: string) => new WebSocket(url) as unknown as WebSocketLike;
const fastBackoff = { initialMs: 10, maxMs: 50, jitter: 0 };

const producers: FakeLiveProducer[] = [];
const clients: LiveIngestClient[] = [];

afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.stop()));
    await Promise.all(producers.splice(0).map((p) => p.close()));
});

async function producer(options: FakeLiveProducerOptions = {}): Promise<FakeLiveProducer> {
    const p = await startFakeLiveProducer(options);
    producers.push(p);
    return p;
}

function live(store: SessionStore, options: Omit<LiveIngestOptions, "sink">): LiveIngestClient {
    const client = connectLiveSession(store, { webSocketFactory: wsFactory, backoff: fastBackoff, ...options });
    clients.push(client);
    return client;
}

async function waitFor(check: () => boolean, timeoutMs = 10_000, what = "condition"): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await new Promise((r) => setTimeout(r, 5));
    }
}

function ids(events: readonly ObservatoryEvent[]): string[] {
    return events.map((e) => e.event_id);
}

function sortedFixtureIds(p: FakeLiveProducer): string[] {
    return ids([...(p.events as unknown as ObservatoryEvent[])].sort(compareEvents));
}

/** Contiguous, schema-valid synthetic events for load tests. */
function syntheticLoad(n: number): ObservatoryEvent[] {
    return Array.from({ length: n }, (_, i) => ({
        schema: "sonder.observatory.event/1" as const,
        event_id: `evt_load_${String(i).padStart(6, "0")}`,
        sequence: i,
        event_type: "load.tick",
        wall_time: new Date(Date.UTC(2026, 8, 26, 8, 0, 0) + i).toISOString(),
        mono_ns: 1_000_000_000 + i * 1000,
        session_id: "ses_load",
        producer: { name: "fake-live-producer-load", version: "0.0.0", node_id: "load", synthetic: true },
        attributes: { i },
    }));
}

const TRANSPORTS: TransportKind[] = ["websocket", "sse", "ndjson"];

describe("live ingest against the fake producer", () => {
    it.each(TRANSPORTS)("streams the whole synthetic fixture in order over %s", async (kind) => {
        const p = await producer({ batch: 16 });
        const store = new SessionStore();
        const client = live(store, { url: p.urls[kind] });
        await waitFor(() => store.events.length === p.events.length, 10_000, "all events");
        const status = client.status;
        expect(status.state).toBe("open");
        expect(status.transport).toBe(kind);
        expect(status.received).toBe(p.events.length);
        expect(status.appended).toBe(p.events.length);
        expect(status.dropped).toBe(0);
        expect(status.rejected).toBe(0);
        expect(store.source).toBe("live");
        expect(store.sourceLabel).toBe(p.urls[kind]);
        expect(ids(store.events)).toEqual(sortedFixtureIds(p));
        expect(store.duplicates).toBe(0);
        expect(store.gaps).toEqual([]);
        expect(store.synthetic).toBe(true);
    }, 15_000);

    it.each(TRANSPORTS)("reconnects with backoff and resumes after the last event id over %s", async (kind) => {
        const p = await producer({ batch: 8, disconnectAfter: 100, retryMs: 10 });
        const store = new SessionStore();
        const states: string[] = [];
        const client = live(store, { url: p.urls[kind], onStatus: (s) => states.push(s.state) });
        await waitFor(() => store.events.length === p.events.length, 15_000, "all events after reconnects");
        const expectedDrops = Math.floor((p.events.length - 1) / 100);
        expect(client.status.reconnects).toBeGreaterThanOrEqual(expectedDrops);
        expect(p.stats.resumed.length).toBeGreaterThanOrEqual(expectedDrops);
        expect(client.status.resumeRequested).toBe(true);
        expect(states).toContain("reconnecting");
        // Resume means nothing was re-sent and nothing was lost.
        expect(store.duplicates).toBe(0);
        expect(store.gaps).toEqual([]);
        expect(ids(store.events)).toEqual(sortedFixtureIds(p));
        expect(client.status.received).toBe(p.events.length);
    }, 20_000);

    it("falls back to event_id dedupe when the producer cannot resume", async () => {
        const p = await producer({ pace: "timeline", speed: 40, batch: 64, resume: false });
        const store = new SessionStore();
        const client = live(store, { url: p.urls.websocket, flushIntervalMs: 5 });
        await waitFor(() => client.status.received >= 50, 10_000, "first events");
        p.dropConnections();
        await waitFor(() => client.status.reconnects >= 1, 10_000, "reconnect");
        await waitFor(() => store.events.length === p.events.length, 15_000, "full replay");
        expect(p.stats.resumed).toEqual([]);
        expect(store.duplicates).toBeGreaterThan(0);
        expect(ids(store.events)).toEqual(sortedFixtureIds(p));
    }, 25_000);

    it("orders events delivered out of order", async () => {
        const base = syntheticLoad(600);
        // Deterministic local shuffle inside windows of 25 events.
        const shuffled: ObservatoryEvent[] = [];
        for (let i = 0; i < base.length; i += 25) {
            const win = base.slice(i, i + 25);
            win.sort((a, b) => ((a.sequence * 7919) % 25) - ((b.sequence * 7919) % 25));
            shuffled.push(...win);
        }
        expect(ids(shuffled)).not.toEqual(ids(base));
        const p = await producer({ events: shuffled as unknown as Record<string, unknown>[], batch: 10 });
        const store = new SessionStore();
        live(store, { url: p.urls.sse, batchSize: 37 });
        await waitFor(() => store.events.length === base.length, 10_000, "all events");
        expect(ids(store.events)).toEqual(ids(base));
        expect(store.gaps).toEqual([]);
    }, 15_000);

    it("drops and accounts for events when a WebSocket outpaces the consumer", async () => {
        const n = 10_000;
        const load = syntheticLoad(n);
        const p = await producer({ events: load as unknown as Record<string, unknown>[], batch: 500 });
        const store = new SessionStore();
        const batches: string[][] = [];
        const client = new LiveIngestClient({
            url: p.urls.websocket,
            webSocketFactory: wsFactory,
            bufferCapacity: 500,
            batchSize: 50,
            flushIntervalMs: 10,
            sink: {
                // A deliberately slow consumer (~5 ms per batch).
                append: async (events) => {
                    batches.push(ids(events));
                    store.append(events);
                    await new Promise((r) => setTimeout(r, 5));
                },
            },
        });
        clients.push(client);
        client.start();
        await waitFor(() => client.status.received === n && client.status.buffered === 0, 20_000, "drain");
        const status = client.status;
        expect(status.dropped).toBeGreaterThan(0);
        expect(status.appended + status.dropped).toBe(n);
        expect(store.events.length).toBe(status.appended);
        // Batches respect the size limit and arrive in wire order.
        expect(Math.max(...batches.map((b) => b.length))).toBeLessThanOrEqual(50);
        const flat = batches.flat();
        expect(flat).toEqual([...flat].sort());
        // drop-oldest keeps the live edge, and the store surfaces the loss as gaps.
        expect(flat[flat.length - 1]).toBe(load[n - 1]!.event_id);
        expect(store.gaps.length).toBeGreaterThan(0);
    }, 30_000);

    it("pauses HTTP streams instead of dropping under the same load", async () => {
        const n = 10_000;
        const p = await producer({ events: syntheticLoad(n) as unknown as Record<string, unknown>[], batch: 500 });
        const store = new SessionStore();
        const client = new LiveIngestClient({
            url: p.urls.ndjson,
            bufferCapacity: 2000,
            batchSize: 500,
            flushIntervalMs: 2,
            sink: {
                append: async (events) => {
                    store.append(events);
                    await new Promise((r) => setTimeout(r, 2));
                },
            },
        });
        clients.push(client);
        client.start();
        await waitFor(() => client.status.appended === n, 20_000, "all events");
        expect(store.events.length).toBe(n);
        expect(client.status.dropped).toBe(0);
        expect(client.status.buffered).toBe(0);
        expect(store.gaps).toEqual([]);
    }, 30_000);

    it("ingests the Sonder-Inference fixture shape over SSE across a resume", async () => {
        const file = fileURLToPath(new URL("../../fixtures/sonder-inference-b2170c0.jsonl", import.meta.url));
        const p = await producer({ file, disconnectAfter: 7, retryMs: 10 });
        const store = new SessionStore();
        const client = live(store, { url: p.urls.sse });
        await waitFor(() => store.events.length === p.events.length, 10_000, "all Inference events");
        expect(client.status.rejected).toBe(0);
        expect(client.status.reconnects).toBeGreaterThanOrEqual(1);
        expect(store.duplicates).toBe(0);
        // One producer instance numbers all sessions from one counter: no false gaps.
        expect(store.gaps).toEqual([]);
        expect(ids(store.events)).toEqual(sortedFixtureIds(p));
    }, 15_000);

    it("passes each decoded value through the adapter hook", async () => {
        const events = syntheticLoad(20);
        const wire = [
            { control: "hello" },
            ...events.map((e) => ({ envelope: e })),
            { not: "an event" },
        ];
        const p = await producer({ events: wire as unknown as Record<string, unknown>[], batch: 4 });
        const store = new SessionStore();
        const client = live(store, {
            url: p.urls.websocket,
            adapter: (v) => {
                const o = v as { control?: string; envelope?: unknown };
                if (o.control) {
                    return null;
                }
                return o.envelope ?? v;
            },
        });
        await waitFor(() => store.events.length === 20 && store.rejected.length === 1, 10_000, "adapted events");
        expect(ids(store.events)).toEqual(ids(events));
        expect(client.status.rejected).toBe(1);
        expect(store.rejected[0]!.reason).toMatch(/schema/);
    }, 15_000);

    it("gives up after maxRetries when nothing is listening", async () => {
        const p = await producer();
        const url = p.urls.sse;
        await p.close();
        producers.length = 0;
        const store = new SessionStore();
        const client = live(store, { url, maxRetries: 2 });
        await waitFor(() => client.status.state === "failed", 10_000, "failed state");
        expect(client.status.attempts).toBe(3);
        expect(client.status.lastError).not.toBeNull();
    }, 15_000);

    it("stops cleanly and does not reconnect after stop()", async () => {
        const p = await producer({ pace: "timeline", speed: 5 });
        const store = new SessionStore();
        const client = live(store, { url: p.urls.websocket });
        await waitFor(() => client.status.state === "open", 5_000, "open");
        await client.stop();
        const connections = p.stats.connections;
        await new Promise((r) => setTimeout(r, 100));
        expect(client.status.state).toBe("closed");
        expect(p.stats.connections).toBe(connections);
    }, 10_000);
});
