import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveIngestClient, type LiveIngestOptions } from "../../../src/ingest/live/client";
import type { ObservatoryEvent } from "../../../src/protocol/events";
import { SessionStore } from "../../../src/replay/session";
import type { WebSocketLike } from "../../../src/transport/live";

const clients: LiveIngestClient[] = [];
afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.stop()));
    vi.useRealTimers();
});

const event: ObservatoryEvent = {
    schema: "sonder.observatory.event/1", event_id: "retry-event-0", sequence: 0,
    event_type: "retry.tick", wall_time: "2026-10-04T00:00:00.000Z", mono_ns: 1000,
    session_id: "retry-session", producer: { name: "synthetic-retry", version: "1", node_id: "local", synthetic: true },
    attributes: {},
};
const backoff = { initialMs: 5, maxMs: 20, jitter: 0 };
type HttpKind = "sse" | "ndjson";
const contentType = (kind: HttpKind) => kind === "sse" ? "text/event-stream" : "application/x-ndjson";
const frame = (kind: HttpKind) => kind === "sse"
    ? `id: producer-0\ndata: ${JSON.stringify(event)}\n\n` : JSON.stringify(event) + "\n";
const cursor = (kind: HttpKind) => kind === "sse" ? "producer-0" : event.event_id;
function client(options: LiveIngestOptions): LiveIngestClient {
    const value = new LiveIngestClient(options);
    clients.push(value);
    value.start();
    return value;
}

describe("retry budgets require event progress", () => {
    it.each(["sse", "ndjson"] as const)("bounds successful empty %s connections and heartbeats", async (kind) => {
        vi.useFakeTimers();
        let requests = 0;
        const delays = new Map<number, number>();
        const value = client({
            url: `http://127.0.0.1:8766/${kind}`, maxRetries: 2, backoff,
            fetch: async () => {
                requests += 1;
                // A normally opened stream can end after heartbeat-only traffic.
                return new Response(kind === "sse" ? ": heartbeat\n\n" : "\n", { headers: { "Content-Type": contentType(kind) } });
            },
            sink: { append: () => {} },
            onStatus: (status) => {
                if (status.retryInMs !== null) delays.set(status.attempts, status.retryInMs);
            },
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(value.status.state).toBe("failed");
        expect(requests).toBe(3);
        expect([...delays.values()]).toEqual([5, 10]);
        expect(value.status.received).toBe(0);
        expect(value.status.lastEventId).toBeNull();
        await vi.advanceTimersByTimeAsync(100);
        expect(requests).toBe(3);
    });

    it.each(["sse", "ndjson"] as const)("renews the %s budget on a valid event while preserving its producer cursor", async (kind) => {
        vi.useFakeTimers();
        const resumes: (string | null)[] = [];
        const store = new SessionStore();
        const value = client({
            url: `http://127.0.0.1:8766/${kind}`, maxRetries: 2, backoff, flushIntervalMs: 1,
            fetch: async (_url, init) => {
                resumes.push(new Headers(init?.headers).get("Last-Event-ID"));
                return new Response(resumes.length === 2 ? frame(kind) : "", { headers: { "Content-Type": contentType(kind) } });
            },
            sink: { append: (batch) => { store.append(batch); } },
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(value.status.state).toBe("failed");
        expect(resumes).toEqual([null, null, cursor(kind), cursor(kind), cursor(kind)]);
        expect(store.events).toEqual([event]);
        expect(value.status.lastEventId).toBe(cursor(kind));
        expect(value.status.dropped).toBe(0);
    });

    it.each(["sse", "ndjson"] as const)("gives an explicit %s restart a fresh retry budget", async (kind) => {
        vi.useFakeTimers();
        let requests = 0;
        const value = client({
            url: `http://127.0.0.1:8766/${kind}`, maxRetries: 2, backoff,
            fetch: async () => { requests += 1; return new Response("", { headers: { "Content-Type": contentType(kind) } }); },
            sink: { append: () => {} },
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(value.status.state).toBe("failed");
        value.start();
        await vi.advanceTimersByTimeAsync(100);
        expect(value.status.state).toBe("failed");
        expect(value.status.attempts).toBe(6);
        expect(requests).toBe(6);
    });

    it("bounds normally opened WebSocket connections that close without events", async () => {
        vi.useFakeTimers();
        let connections = 0;
        const value = client({
            url: "ws://127.0.0.1:8766/ws", maxRetries: 2, backoff, sink: { append: () => {} },
            webSocketFactory: () => {
                connections += 1;
                const socket: WebSocketLike = { readyState: 0, onopen: null, onclose: null, onerror: null, onmessage: null, close: () => {} };
                setTimeout(() => { socket.onopen?.({}); socket.onclose?.({ code: 1000, reason: "stream ended" }); }, 0);
                return socket;
            },
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(value.status.state).toBe("failed");
        expect(connections).toBe(3);
        expect(value.status.lastEventId).toBeNull();
    });
});

describe("bounded empty-stream reconnect stress on real HTTP", () => {
    it.each(["sse", "ndjson"] as const)("stops 32 concurrent %s clients across four restart cycles", async (kind) => {
        let requests = 0;
        const server = createServer((_request, response) => {
            requests += 1;
            response.writeHead(200, { "Content-Type": contentType(kind), Connection: "close" });
            response.end(kind === "sse" ? "retry: 1\n: heartbeat\n\n" : "\n");
        });
        await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("missing local peer address");
        const batch = Array.from({ length: 32 }, () => client({
            url: `http://127.0.0.1:${address.port}/${kind}`, maxRetries: 2,
            backoff: { initialMs: 1, maxMs: 2, jitter: 0 }, bufferCapacity: 4,
            sink: { append: () => { throw new Error("heartbeat-only peer must not append"); } },
        }));
        try {
            for (let cycle = 1; cycle <= 4; cycle += 1) {
                if (cycle > 1) batch.forEach((value) => value.start());
                await expect.poll(() => batch.every((value) => value.status.state === "failed"), { timeout: 5000 }).toBe(true);
                expect(requests).toBe(32 * 3 * cycle);
                expect(batch.every((value) => value.status.attempts === 3 * cycle && value.status.buffered === 0 && value.status.received === 0)).toBe(true);
            }
            await Promise.all(batch.map((value) => value.stop()));
            expect(batch.every((value) => value.status.state === "closed")).toBe(true);
        } finally {
            await Promise.all(batch.map((value) => value.stop()));
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
        }
    }, 10_000);
});
