import { afterEach, describe, expect, it } from "vitest";
import { LiveIngestClient, MAX_SERVER_RETRY_MS } from "../../../src/ingest/live/client";
import { LineSplitter, SseParser, type SseMessage } from "../../../src/ingest/live/sse";
import { openWebSocket, type TransportCallbacks } from "../../../src/ingest/live/transports";
import type { WebSocketLike } from "../../../src/transport/live";

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

    it("scans each chunk of a long partial line once", () => {
        const { p, messages } = parser();
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
        const s = new LineSplitter();
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
            onPayload: (text) => payloads.push(text),
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
