import { describe, expect, it } from "vitest";
import { composeAdapters } from "../../../src/ingest/live/adapter";
import { Backoff } from "../../../src/ingest/live/backoff";
import { BoundedBuffer } from "../../../src/ingest/live/buffer";
import type { LiveIngestStatus } from "../../../src/ingest/live/client";
import { resolveEndpoint, withQueryParam } from "../../../src/ingest/live/endpoint";
import { LineSplitter, SseParser, type SseMessage } from "../../../src/ingest/live/sse";
import { describeStatus } from "../../../src/ingest/live/status";

describe("Backoff", () => {
    it("grows exponentially up to the cap and resets", () => {
        const b = new Backoff({ initialMs: 100, maxMs: 1000, factor: 2, jitter: 0 });
        expect([b.next(), b.next(), b.next(), b.next(), b.next(), b.next()]).toEqual([100, 200, 400, 800, 1000, 1000]);
        b.reset();
        expect(b.next()).toBe(100);
    });

    it("keeps jittered delays within [delay*(1-jitter), delay]", () => {
        const lo = new Backoff({ initialMs: 1000, jitter: 0.5, random: () => 0 });
        const hi = new Backoff({ initialMs: 1000, jitter: 0.5, random: () => 0.999999 });
        expect(lo.next()).toBe(500);
        expect(hi.next()).toBe(1000);
    });
});

describe("BoundedBuffer", () => {
    it("is FIFO and wraps around", () => {
        const b = new BoundedBuffer<number>(3);
        b.push(1);
        b.push(2);
        expect(b.drain(1)).toEqual([1]);
        b.push(3);
        b.push(4);
        expect(b.size).toBe(3);
        expect(b.drain()).toEqual([2, 3, 4]);
        expect(b.size).toBe(0);
        expect(b.dropped).toBe(0);
    });

    it("drop-oldest keeps the newest items and counts drops", () => {
        const b = new BoundedBuffer<number>(3, "drop-oldest");
        for (let i = 1; i <= 7; i += 1) {
            b.push(i);
        }
        expect(b.dropped).toBe(4);
        expect(b.drain()).toEqual([5, 6, 7]);
    });

    it("drop-newest keeps the oldest items and counts drops", () => {
        const b = new BoundedBuffer<number>(3, "drop-newest");
        for (let i = 1; i <= 7; i += 1) {
            expect(b.push(i)).toBe(i <= 3);
        }
        expect(b.dropped).toBe(4);
        expect(b.drain()).toEqual([1, 2, 3]);
    });

    it("rejects a non-positive capacity", () => {
        expect(() => new BoundedBuffer(0)).toThrow(RangeError);
    });
});

describe("SseParser", () => {
    function collect(chunks: string[]) {
        const messages: SseMessage[] = [];
        const retries: number[] = [];
        const p = new SseParser({ onMessage: (m) => messages.push(m), onRetry: (ms) => retries.push(ms) });
        for (const c of chunks) {
            p.feed(c);
        }
        return { messages, retries, parser: p };
    }

    it("parses ids, event names, multi-line data, comments and retry", () => {
        const { messages, retries } = collect([
            "\uFEFFretry: 250\n: comment\n\nid: a1\ndata: {\"x\":1}\n\n",
            "event: ping\ndata: one\ndata: two\n\ndata:nospace\n\n",
            "retry: soon\n\n",
        ]);
        expect(retries).toEqual([250]);
        expect(messages).toEqual([
            { event: "message", data: "{\"x\":1}", lastEventId: "a1" },
            { event: "ping", data: "one\ntwo", lastEventId: "a1" },
            { event: "message", data: "nospace", lastEventId: "a1" },
        ]);
    });

    it("handles CRLF / CR line endings split across chunks", () => {
        const text = "id: 7\r\ndata: hello\r\n\r\nid: 8\rdata: world\r\r";
        for (let split = 1; split < text.length; split += 1) {
            const { messages } = collect([text.slice(0, split), text.slice(split)]);
            expect(messages.map((m) => `${m.lastEventId}:${m.data}`)).toEqual(["7:hello", "8:world"]);
        }
    });

    it("does not dispatch an unterminated event and ignores ids with NUL", () => {
        const { messages, parser } = collect(["id: ok\ndata: 1\n\nid: bad\u0000\ndata: 2\n\ndata: partial"]);
        expect(messages.map((m) => m.lastEventId)).toEqual(["ok", "ok"]);
        expect(parser.currentLastEventId).toBe("ok");
    });
});

describe("LineSplitter", () => {
    it("reassembles lines across chunk boundaries", () => {
        const s = new LineSplitter();
        expect(s.feed("a\r\nb")).toEqual(["a"]);
        expect(s.feed("c\nd")).toEqual(["bc"]);
        expect(s.flush()).toEqual(["d"]);
        expect(s.flush()).toEqual([]);
    });
});

describe("resolveEndpoint", () => {
    it("picks the transport by URL", () => {
        expect(resolveEndpoint("ws://127.0.0.1:8766/ws")).toMatchObject({ ok: true, kind: "websocket", loopback: true });
        expect(resolveEndpoint("http://localhost:8766/sse")).toMatchObject({ ok: true, kind: "sse" });
        expect(resolveEndpoint("http://localhost:8766/ndjson")).toMatchObject({ ok: true, kind: "ndjson" });
        expect(resolveEndpoint("http://localhost/x?format=jsonl").kind).toBe("ndjson");
        expect(resolveEndpoint("https://example.com/events")).toMatchObject({ ok: true, kind: "sse", loopback: false });
        expect(resolveEndpoint("https://example.com/events").message).toMatch(/remote endpoint/);
    });

    it("honours an explicit preference and rejects mismatches", () => {
        expect(resolveEndpoint("http://127.0.0.1/sse", "ndjson").kind).toBe("ndjson");
        expect(resolveEndpoint("ws://127.0.0.1", "sse").ok).toBe(false);
        expect(resolveEndpoint("http://127.0.0.1", "websocket").ok).toBe(false);
        expect(resolveEndpoint("ftp://127.0.0.1").ok).toBe(false);
        expect(resolveEndpoint("nope").ok).toBe(false);
    });

    it("sets a resume query parameter", () => {
        expect(withQueryParam("ws://h:1/ws?a=1", "last_event_id", "e 1")).toBe("ws://h:1/ws?a=1&last_event_id=e+1");
    });
});

describe("composeAdapters", () => {
    it("chains adapters, expanding arrays and skipping null", () => {
        const unwrap = (v: unknown) => (v as { batch?: unknown[] }).batch ?? v;
        const dropControl = (v: unknown) => ((v as { control?: boolean }).control ? null : v);
        const adapt = composeAdapters(unwrap, dropControl);
        expect(adapt({ batch: [{ a: 1 }, { control: true }, { b: 2 }] })).toEqual([{ a: 1 }, { b: 2 }]);
    });
});

describe("describeStatus", () => {
    const base: LiveIngestStatus = {
        state: "open",
        url: "ws://127.0.0.1:8766/ws",
        transport: "websocket",
        loopback: true,
        warning: null,
        attempts: 1,
        reconnects: 0,
        retryInMs: null,
        lastEventId: null,
        resumeRequested: false,
        received: 10,
        appended: 10,
        dropped: 0,
        rejected: 0,
        buffered: 0,
        bufferCapacity: 100,
        batches: 1,
        lastError: null,
    };

    it("labels each state", () => {
        expect(describeStatus(base)).toMatchObject({ label: "live · ws", tone: "ok" });
        expect(describeStatus({ ...base, dropped: 3 })).toMatchObject({ label: "live · ws · 3 dropped", tone: "warn" });
        expect(describeStatus({ ...base, state: "reconnecting", retryInMs: 2000 }).label).toBe("reconnecting in 2.0 s");
        expect(describeStatus({ ...base, state: "failed", lastError: "HTTP 500" })).toMatchObject({ tone: "error" });
        expect(describeStatus({ ...base, state: "failed", lastError: "HTTP 500" }).detail).toMatch(/HTTP 500/);
        expect(describeStatus({ ...base, state: "idle" }).tone).toBe("idle");
    });
});
