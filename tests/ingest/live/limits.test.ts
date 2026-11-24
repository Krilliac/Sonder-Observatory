import { afterEach, describe, expect, it } from "vitest";
import { BoundedBuffer } from "../../../src/ingest/live/buffer";
import { LiveIngestClient, MAX_SERVER_RETRY_MS } from "../../../src/ingest/live/client";
import { LineSplitter, MAX_LINE_CHARS, SseParser, type SseMessage } from "../../../src/ingest/live/sse";
import { openWebSocket, type TransportCallbacks } from "../../../src/ingest/live/transports";
import { MAX_REJECTED_RAW_CHARS } from "../../../src/protocol/size";
import type { RejectedLine } from "../../../src/recording/ndjson";
import type { WebSocketLike } from "../../../src/transport/live";
import { makeEvent } from "../../helpers";

/**
 * A connected producer controls how much text the viewer buffers: a line or
 * event that never ends must not grow without bound, and a long partial line
 * must not be rescanned from its start on every chunk.
 */
describe("SseParser limits", () => {
    function parser(maxLineChars?: number) {
        const messages: SseMessage[] = [];
        const oversize: string[] = [];
        const p = new SseParser(
            { onMessage: (m) => messages.push(m), onOversize: (reason) => oversize.push(reason) },
            maxLineChars,
        );
        return { p, messages, oversize };
    }

    it("drops a line longer than the limit, reports it, and resynchronises on the next event", () => {
        const { p, messages, oversize } = parser(64);
        p.feed("data: ok1\n\n");
        p.feed(`data: ${"x".repeat(40)}`);
        p.feed(`${"x".repeat(40)}`);
        p.feed("more\n\n");
        p.feed("data: ok2\n\n");
        expect(oversize).toHaveLength(1);
        expect(messages.map((m) => m.data)).toEqual(["ok1", "ok2"]);
        expect(p.bufferedChars).toBe(0);
    });

    it("drops an event whose data lines together exceed the limit", () => {
        const { p, messages, oversize } = parser(64);
        for (let i = 0; i < 10; i += 1) {
            p.feed(`data: ${"y".repeat(20)}\n`);
        }
        p.feed("\ndata: after\n\n");
        expect(oversize).toHaveLength(1);
        expect(messages.map((m) => m.data)).toEqual(["after"]);
    });

    it("enforces a tight 512 KiB default per-event line limit", () => {
        expect(MAX_LINE_CHARS).toBe(512 * 1024);
        const { p, messages, oversize } = parser();
        p.feed(`data: ${"x".repeat(MAX_LINE_CHARS + 1)}\n\n`);
        p.feed("data: ok\n\n");
        expect(oversize).toHaveLength(1);
        expect(messages.map((m) => m.data)).toEqual(["ok"]);
    });

    it("scans each chunk of a long partial line once", () => {
        const { p, messages } = parser(8 * 1024 * 1024);
        const chunk = "z".repeat(512);
        const started = performance.now();
        p.feed("data: ");
        for (let i = 0; i < 8000; i += 1) {
            p.feed(chunk);
        }
        p.feed("\n\n");
        const elapsed = performance.now() - started;
        expect(messages).toHaveLength(1);
        expect(messages[0]!.data.length).toBe(512 * 8000);
        // Rescanning the 4 MB partial line on every chunk is ~16e9 char reads (tens of seconds).
        expect(elapsed).toBeLessThan(2000);
    });
});

describe("LineSplitter limits", () => {
    it("drops an overlong line, reports it, and keeps the lines after it", () => {
        const oversize: string[] = [];
        const s = new LineSplitter({ maxLineChars: 32, onOversize: (r) => oversize.push(r) });
        expect(s.feed("a\n")).toEqual(["a"]);
        expect(s.feed("b".repeat(20))).toEqual([]);
        expect(s.feed("b".repeat(20))).toEqual([]);
        expect(s.bufferedChars).toBe(0);
        expect(s.feed("bbb\nc\n")).toEqual(["c"]);
        expect(oversize).toHaveLength(1);
        expect(s.flush()).toEqual([]);
    });

    it("drops an overlong line that arrives inside one chunk", () => {
        const oversize: string[] = [];
        const s = new LineSplitter({ maxLineChars: 8, onOversize: (r) => oversize.push(r) });
        expect(s.feed(`ok\n${"q".repeat(20)}\nfine\n`)).toEqual(["ok", "fine"]);
        expect(oversize).toHaveLength(1);
    });

    it("scans each chunk of a long partial line once", () => {
        const s = new LineSplitter({ maxLineChars: 8 * 1024 * 1024 });
        const chunk = "{".repeat(512);
        const started = performance.now();
        for (let i = 0; i < 8000; i += 1) {
            s.feed(chunk);
        }
        const lines = s.feed("\n");
        expect(lines).toHaveLength(1);
        expect(performance.now() - started).toBeLessThan(2000);
    });
});

describe("WebSocket frame limit", () => {
    it("rejects a text frame larger than the line limit instead of parsing it", () => {
        const payloads: string[] = [];
        const invalid: string[] = [];
        let socket: WebSocketLike | null = null;
        const callbacks: TransportCallbacks = {
            onOpen: () => undefined,
            onPayload: (text) => { payloads.push(text); },
            onInvalidFrame: (reason) => invalid.push(reason),
            onRetryHint: () => undefined,
            onClose: () => undefined,
            waitForCapacity: () => Promise.resolve(),
        };
        openWebSocket({ url: "ws://127.0.0.1:1/events", kind: "websocket", lastEventId: null, resumeParam: "last_event_id" }, callbacks, () => {
            socket = { readyState: 0, onopen: null, onclose: null, onerror: null, onmessage: null, close: () => undefined };
            return socket;
        }, 16);
        socket!.onmessage?.({ data: "x".repeat(17) });
        socket!.onmessage?.({ data: "{}" });
        expect(invalid).toHaveLength(1);
        expect(payloads).toEqual(["{}"]);
    });
});

describe("server retry hint", () => {
    const clients: LiveIngestClient[] = [];
    afterEach(() => {
        for (const c of clients.splice(0)) {
            c.stop();
        }
    });

    it("clamps a huge retry: value instead of handing it to setTimeout", async () => {
        // setTimeout treats delays above 2^31-1 ms as 0: an immediate reconnect loop.
        const body = "retry: 99999999999999\n\n";
        const client = new LiveIngestClient({
            url: "http://127.0.0.1:1/events",
            transport: "sse",
            discover: false,
            fetch: async () =>
                new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
            sink: { append: () => undefined },
        });
        clients.push(client);
        client.start();
        const deadline = Date.now() + 5000;
        while (client.status.state !== "reconnecting" && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 5));
        }
        expect(client.status.state).toBe("reconnecting");
        expect(client.status.retryInMs).not.toBeNull();
        expect(client.status.retryInMs!).toBeLessThanOrEqual(MAX_SERVER_RETRY_MS);
        expect(client.status.retryInMs!).toBeGreaterThan(0);
    });
});

describe("live memory budgets and repeated-violation disconnect", () => {
    const clients: LiveIngestClient[] = [];
    afterEach(async () => {
        await Promise.all(clients.splice(0).map((c) => c.stop()));
    });

    it("enforces byte budgets in BoundedBuffer for drop-oldest and drop-newest", () => {
        const oldest = new BoundedBuffer<string>(100, "drop-oldest", { maxBytes: 10, sizeOf: (s) => s.length });
        oldest.push("aaaa"); // 4
        oldest.push("bbbb"); // 8
        expect(oldest.bytes).toBe(8);
        expect(oldest.push("ccccc")).toBe(false); // evicts "aaaa" -> 9 bytes
        expect(oldest.dropped).toBe(1);
        expect(oldest.bytes).toBe(9);
        expect(oldest.drain()).toEqual(["bbbb", "ccccc"]);
        expect(oldest.bytes).toBe(0);

        const newest = new BoundedBuffer<string>(100, "drop-newest", { maxBytes: 10, sizeOf: (s) => s.length });
        expect(newest.push("aaaa")).toBe(true);
        expect(newest.push("bbbb")).toBe(true);
        expect(newest.push("ccccc")).toBe(false);
        expect(newest.dropped).toBe(1);
        expect(newest.drain()).toEqual(["aaaa", "bbbb"]);

        // Single item larger than maxBytes is dropped without looping.
        expect(oldest.push("x".repeat(20))).toBe(false);
        expect(oldest.size).toBe(0);
    });

    it("retains only a bounded preview of rejected raw lines", async () => {
        const rejected: RejectedLine[] = [];
        const bigBadLine = `{"broken":"${"z".repeat(40_000)}"`; // invalid JSON, ~40 KiB
        const body = `data: ${bigBadLine}\n\n`;
        const client = new LiveIngestClient({
            url: "http://127.0.0.1:11437/events",
            transport: "sse",
            discover: false,
            reconnect: false,
            flushIntervalMs: 1,
            fetch: async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
            sink: {
                append: () => undefined,
                addRejected: (lines) => rejected.push(...lines),
            },
        });
        clients.push(client);
        client.start();
        await expect.poll(() => rejected.length).toBe(1);
        expect(rejected[0]!.raw.length).toBeLessThanOrEqual(MAX_REJECTED_RAW_CHARS);
        expect(rejected[0]!.raw.endsWith("…")).toBe(true);
    });

    it("disconnects a producer that repeatedly exceeds schema complexity limits without reconnecting", async () => {
        let fetches = 0;
        const deepObj = () => {
            let cur: Record<string, unknown> = { leaf: 1 };
            for (let i = 0; i < 10; i += 1) {
                cur = { nested: cur };
            }
            return cur;
        };
        const badEvent = JSON.stringify(makeEvent({ attributes: deepObj() }));
        const body = Array.from({ length: 5 }, () => `${badEvent}\n`).join("");
        const rejected: RejectedLine[] = [];
        const client = new LiveIngestClient({
            url: "http://127.0.0.1:11437/events",
            transport: "ndjson",
            discover: false,
            reconnect: true,
            maxLimitViolations: 3,
            flushIntervalMs: 1,
            fetch: async () => {
                fetches += 1;
                return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
            },
            sink: {
                append: () => undefined,
                addRejected: (lines) => rejected.push(...lines),
            },
        });
        clients.push(client);
        client.start();
        await expect.poll(() => client.status.state).toBe("failed");
        expect(client.status.lastError).toMatch(/disconnected producer after 3 telemetry limit violations/);
        expect(client.status.retryInMs).toBeNull();
        expect(fetches).toBe(1);
        await client.flush();
        expect(rejected.length).toBe(3);
    });

    it("disconnects a WebSocket producer that repeatedly sends oversize frames", async () => {
        let closed = false;
        let socket: WebSocketLike | null = null;
        const client = new LiveIngestClient({
            url: "ws://127.0.0.1:8765/ws",
            discover: false,
            reconnect: true,
            maxLimitViolations: 2,
            webSocketFactory: () => {
                socket = {
                    readyState: 1,
                    onopen: null,
                    onclose: null,
                    onerror: null,
                    onmessage: null,
                    close: () => {
                        closed = true;
                    },
                };
                return socket;
            },
            sink: { append: () => undefined },
        });
        clients.push(client);
        client.start();
        socket!.onopen?.({});
        const oversize = "x".repeat(MAX_LINE_CHARS + 1);
        socket!.onmessage?.({ data: oversize });
        expect(client.status.state).toBe("open");
        socket!.onmessage?.({ data: oversize });
        expect(client.status.state).toBe("failed");
        expect(client.status.lastError).toMatch(/disconnected producer after 2 telemetry limit violations/);
        expect(closed).toBe(true);
    });

    it("drops oldest events in a WebSocket queue when bufferMaxBytes is exceeded", async () => {
        let socket: WebSocketLike | null = null;
        const appended: string[] = [];
        const client = new LiveIngestClient({
            url: "ws://127.0.0.1:8765/ws",
            discover: false,
            reconnect: false,
            bufferCapacity: 1000,
            bufferMaxBytes: 12_000,
            flushIntervalMs: 500,
            webSocketFactory: () => {
                socket = {
                    readyState: 1,
                    onopen: null,
                    onclose: null,
                    onerror: null,
                    onmessage: null,
                    close: () => undefined,
                };
                return socket;
            },
            sink: {
                append: (batch) => {
                    appended.push(...batch.map((e) => e.event_id));
                },
            },
        });
        clients.push(client);
        client.start();
        socket!.onopen?.({});
        for (let i = 0; i < 6; i += 1) {
            socket!.onmessage?.({
                data: JSON.stringify(makeEvent({ event_id: `big-${i}`, sequence: i, attributes: { payload: "a".repeat(2000) } })),
            });
        }
        expect(client.status.dropped).toBeGreaterThan(0);
        await client.flush();
        expect(appended.at(-1)).toBe("big-5");
        expect(appended.length).toBeLessThan(6);
    });
});
