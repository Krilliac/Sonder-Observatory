import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveIngestClient, type LiveIngestOptions } from "../../../src/ingest/live/client";
import type { ObservatoryEvent } from "../../../src/protocol/events";
import type { WebSocketLike } from "../../../src/transport/live";

const clients: LiveIngestClient[] = [];
afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.stop()));
    vi.useRealTimers();
});
function source(sequence: number): ObservatoryEvent {
    return {
        schema: "sonder.observatory.event/1", event_id: `source-${sequence}`, sequence,
        event_type: "synthetic.cursor", wall_time: "2026-10-04T00:00:00.000Z", mono_ns: 1000 + sequence,
        session_id: "cursor-session", producer: { name: "synthetic-cursor", version: "1", node_id: "local", synthetic: true },
        attributes: {},
    };
}
function adapted(event: ObservatoryEvent, count = 2): ObservatoryEvent[] {
    return Array.from({ length: count }, (_, index) => ({
        ...event, event_id: `${event.event_id}:derived:${index}`, sequence: event.sequence * count + index,
    }));
}
type HttpKind = "sse" | "ndjson";
const contentType = (kind: HttpKind) => kind === "sse" ? "text/event-stream" : "application/x-ndjson";
const cursor = (kind: HttpKind, sequence: number) => kind === "sse" ? `wire-${sequence}` : `source-${sequence}`;
const frame = (kind: HttpKind, event: ObservatoryEvent) => kind === "sse"
    ? `id: ${cursor(kind, event.sequence)}\ndata: ${JSON.stringify(event)}\n\n` : JSON.stringify(event) + "\n";
function start(options: LiveIngestOptions): LiveIngestClient {
    const client = new LiveIngestClient(options);
    clients.push(client);
    client.start();
    return client;
}

describe.each(["pause", "drop"] as const)("HTTP source cursors in %s mode", (mode) => {
    it.each(["sse", "ndjson"] as const)("resumes %s using producer identity after adapter fanout", async (kind) => {
        vi.useFakeTimers();
        const resumes: (string | null)[] = [];
        const appended: string[] = [];
        const client = start({
            url: `http://127.0.0.1:8766/${kind}`, httpBackpressure: mode,
            maxRetries: 0, backoff: { initialMs: 1, maxMs: 1, jitter: 0 }, bufferCapacity: 8, flushIntervalMs: 1,
            fetch: async (_url, init) => {
                resumes.push(new Headers(init?.headers).get("Last-Event-ID"));
                return new Response(resumes.length === 1 ? frame(kind, source(0)) + frame(kind, source(1)) : "", {
                    headers: { "Content-Type": contentType(kind) },
                });
            },
            adapter: (value) => adapted(value as ObservatoryEvent),
            sink: { append: (batch) => { appended.push(...batch.map((event) => event.event_id)); } },
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(appended).toEqual([...adapted(source(0)), ...adapted(source(1))].map((event) => event.event_id));
        expect(client.status.received).toBe(4);
        expect(client.status.dropped).toBe(0);
        expect(client.status.state).toBe("failed");
        expect(resumes).toEqual([null, cursor(kind, 1)]);
        expect(client.status.lastEventId).toBe(cursor(kind, 1));
    });

    it("keeps the prior NDJSON producer cursor for adapted sources without an envelope cursor", async () => {
        vi.useFakeTimers();
        const resumes: (string | null)[] = [];
        const appended: string[] = [];
        const client = start({
            url: "http://127.0.0.1:8766/ndjson", httpBackpressure: mode,
            maxRetries: 0, backoff: { initialMs: 1, maxMs: 1, jitter: 0 }, bufferCapacity: 8, flushIntervalMs: 1,
            fetch: async (_url, init) => {
                resumes.push(new Headers(init?.headers).get("Last-Event-ID"));
                return new Response(resumes.length === 1
                    ? JSON.stringify(source(0)) + "\n" + JSON.stringify({ batch: adapted(source(1)) }) + "\n" : "", {
                    headers: { "Content-Type": contentType("ndjson") },
                });
            },
            adapter: (value) => (value as { batch?: unknown }).batch ?? adapted(value as ObservatoryEvent),
            sink: { append: (batch) => { appended.push(...batch.map((event) => event.event_id)); } },
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(appended).toHaveLength(4);
        expect(client.status.received).toBe(4);
        expect(client.status.dropped).toBe(0);
        expect(client.status.state).toBe("failed");
        expect(resumes).toEqual([null, "source-0"]);
        expect(client.status.lastEventId).toBe("source-0");
    });
});

it("preserves the synchronous WebSocket adapted event-id cursor", async () => {
    vi.useFakeTimers();
    const resumes: (string | null)[] = [];
    const client = start({
        url: "ws://127.0.0.1:8766/ws", maxRetries: 0, backoff: { initialMs: 1, maxMs: 1, jitter: 0 },
        adapter: (value) => adapted(value as ObservatoryEvent), sink: { append: () => {} },
        webSocketFactory: (url) => {
            resumes.push(new URL(url).searchParams.get("last_event_id"));
            const first = resumes.length === 1;
            const socket: WebSocketLike = { readyState: 0, onopen: null, onclose: null, onerror: null, onmessage: null, close: () => {} };
            setTimeout(() => {
                socket.onopen?.({});
                if (first) socket.onmessage?.({ data: JSON.stringify(source(0)) });
                socket.onclose?.({ code: 1000, reason: "stream ended" });
            }, 0);
            return socket;
        },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(client.status.state).toBe("failed");
    expect(client.status.received).toBe(2);
    expect(resumes).toEqual([null, "source-0:derived:1"]);
});

describe("real HTTP drop-mode fanout stress", () => {
    it.each(["sse", "ndjson"] as const)("bounds 16 concurrent %s clients and resumes from completed producer cursors", async (kind) => {
        const count = 128;
        const fanout = 4;
        const wire = Array.from({ length: count }, (_, sequence) => frame(kind, source(sequence))).join("");
        const resumes: (string | null)[] = [];
        const server = createServer((request, response) => {
            const last = request.headers["last-event-id"];
            resumes.push(typeof last === "string" ? last : null);
            response.writeHead(200, { "Content-Type": contentType(kind), Connection: "close" });
            response.end(last ? "" : wire);
        });
        await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("missing local peer address");
        let maxBuffered = 0;
        const batch = Array.from({ length: 16 }, () => start({
            url: `http://127.0.0.1:${address.port}/${kind}`, httpBackpressure: "drop", bufferCapacity: 4, batchSize: 2,
            flushIntervalMs: 1, maxRetries: 0, backoff: { initialMs: 1, maxMs: 1, jitter: 0 },
            adapter: (value) => adapted(value as ObservatoryEvent, fanout),
            onStatus: (status) => { maxBuffered = Math.max(maxBuffered, status.buffered); },
            sink: { append: async () => { await new Promise((resolve) => { setTimeout(resolve, 2); }); } },
        }));
        try {
            await expect.poll(() => batch.every((client) => client.status.state === "failed"), { timeout: 5000 }).toBe(true);
            await Promise.all(batch.map((client) => client.stop()));
            expect(resumes.filter((value) => value === null)).toHaveLength(16);
            expect(resumes.filter((value) => value === cursor(kind, count - 1))).toHaveLength(16);
            expect(resumes).toHaveLength(32);
            expect(maxBuffered).toBeLessThanOrEqual(4);
            for (const client of batch) {
                expect(client.status.received).toBe(count * fanout);
                expect(client.status.appended + client.status.dropped).toBe(count * fanout);
                expect(client.status.dropped).toBeGreaterThan(0);
                expect(client.status.rejected).toBe(0);
                expect(client.status.lastEventId).toBe(cursor(kind, count - 1));
                expect(client.status.buffered).toBe(0);
                expect(client.status.state).toBe("closed");
            }
        } finally {
            await Promise.all(batch.map((client) => client.stop()));
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
        }
    }, 10_000);
});
