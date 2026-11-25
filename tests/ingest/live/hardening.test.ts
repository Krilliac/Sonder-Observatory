import { afterEach, describe, expect, it, vi } from "vitest";
import { Backoff } from "../../../src/ingest/live/backoff";
import { BoundedBuffer } from "../../../src/ingest/live/buffer";
import { LiveIngestClient, MAX_SERVER_RETRY_MS } from "../../../src/ingest/live/client";
import { LineSplitter, MAX_LINE_CHARS, MAX_SSE_FIELD_CHARS, SseParser, type SseMessage } from "../../../src/ingest/live/sse";
import {
    isValidHttpHeaderValue,
    parseRetryAfterMs,
    parseSseControlComment,
} from "../../../src/ingest/live/transports";
import type { RejectedLine } from "../../../src/recording/ndjson";
import { LiveConnection } from "../../../src/transport/live";
import { makeEvent } from "../../helpers";

const clients: LiveIngestClient[] = [];

afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.stop()));
    vi.useRealTimers();
});

describe("Backoff numeric hardening", () => {
    it("sanitizes NaN/Infinity/negative options and never produces NaN even at huge attempt counts", () => {
        const weird = new Backoff({
            initialMs: Number.NaN,
            maxMs: Number.POSITIVE_INFINITY,
            factor: Number.NaN,
            jitter: Number.NaN,
            random: () => Number.NaN,
        });
        const first = weird.next();
        expect(Number.isFinite(first)).toBe(true);
        expect(first).toBeGreaterThanOrEqual(0);

        // 0 * 2^1024 would be 0 * Infinity === NaN without guarding initialMs === 0.
        const zero = new Backoff({ initialMs: 0, maxMs: 5000, factor: 2, jitter: 0 });
        zero.attempt = 2000;
        expect(zero.next()).toBe(0);

        const huge = new Backoff({ initialMs: 250, maxMs: 10_000, factor: 2, jitter: 0 });
        huge.attempt = 2000;
        expect(huge.next()).toBe(10_000);

        // Clamps out-of-range random() outputs into [0, 1].
        const clampedHi = new Backoff({ initialMs: 1000, jitter: 0.5, random: () => 99 });
        const clampedLo = new Backoff({ initialMs: 1000, jitter: 0.5, random: () => -5 });
        expect(clampedHi.next()).toBe(1000);
        expect(clampedLo.next()).toBe(500);
    });
});

describe("BoundedBuffer NaN and overflow resilience", () => {
    it("drops non-finite item sizes without poisoning totalBytes and handles drain(NaN)", () => {
        const buf = new BoundedBuffer<string>(10, "drop-oldest", {
            maxBytes: 100,
            sizeOf: (s) => (s === "poison" ? Number.NaN : s === "inf" ? Number.POSITIVE_INFINITY : s.length),
        });
        expect(buf.push("ok")).toBe(true);
        expect(buf.push("poison")).toBe(false);
        expect(buf.push("inf")).toBe(false);
        expect(buf.bytes).toBe(2);
        expect(buf.dropped).toBe(2);
        expect(buf.drain(Number.NaN)).toEqual([]);
        expect(buf.drain(-5)).toEqual([]);
        expect(buf.drain()).toEqual(["ok"]);
        expect(buf.bytes).toBe(0);
    });
});

describe("HTTP Retry-After, header validation and SSE control comments", () => {
    it("parses delta-seconds and HTTP-date Retry-After headers", () => {
        const now = Date.UTC(2026, 10, 25, 12, 0, 0);
        expect(parseRetryAfterMs("5", now)).toBe(5000);
        expect(parseRetryAfterMs(" 0 ", now)).toBe(0);
        expect(parseRetryAfterMs("Wed, 25 Nov 2026 12:00:12 GMT", now)).toBe(12_000);
        expect(parseRetryAfterMs("Wed, 25 Nov 2026 11:59:00 GMT", now)).toBe(0);
        expect(parseRetryAfterMs("-5", now)).toBeNull();
        expect(parseRetryAfterMs("soon", now)).toBeNull();
        expect(parseRetryAfterMs("", now)).toBeNull();
        expect(parseRetryAfterMs(null, now)).toBeNull();
    });

    it("honors HTTP 429 Retry-After (clamped) and cancels error response bodies", async () => {
        vi.useFakeTimers();
        let bodyCancelled = 0;
        const retries: number[] = [];
        const client = new LiveIngestClient({
            url: "http://127.0.0.1:11437/v1/telemetry/sse",
            transport: "sse",
            discover: false,
            maxRetries: 2,
            backoff: { initialMs: 50, maxMs: 200, jitter: 0 },
            fetch: async () => {
                const body = new ReadableStream<Uint8Array>({
                    cancel() {
                        bodyCancelled += 1;
                    },
                });
                const retryAfter = retries.length === 0 ? "5" : "999999";
                return new Response(body, { status: 429, headers: { "Retry-After": retryAfter } });
            },
            sink: { append: () => undefined },
            onStatus: (s) => {
                if (s.retryInMs !== null) {
                    retries.push(s.retryInMs);
                }
            },
        });
        clients.push(client);
        client.start();
        await vi.advanceTimersByTimeAsync(70_000);
        expect(client.status.state).toBe("failed");
        expect(retries).toEqual([5000, MAX_SERVER_RETRY_MS]);
        expect(bodyCancelled).toBe(3);
    });

    it("falls back to ?last_event_id= when a cursor contains non-ByteString Unicode so fetch never throws TypeError", async () => {
        vi.useFakeTimers();
        expect(isValidHttpHeaderValue("tel-abc-123")).toBe(true);
        expect(isValidHttpHeaderValue("evt-\u2603-1")).toBe(false);
        expect(isValidHttpHeaderValue("bad\r\nid")).toBe(false);
        expect(isValidHttpHeaderValue("x".repeat(MAX_SSE_FIELD_CHARS + 1))).toBe(false);

        const unicodeId = "evt-\u2603-0";
        const calls: { url: string; header: string | null }[] = [];
        const event0 = makeEvent({ event_id: unicodeId, sequence: 0 });
        const client = new LiveIngestClient({
            url: "http://127.0.0.1:11437/v1/telemetry/ndjson",
            transport: "ndjson",
            discover: false,
            maxRetries: 0,
            backoff: { initialMs: 5, maxMs: 5, jitter: 0 },
            flushIntervalMs: 1,
            fetch: async (url, init) => {
                const headers = new Headers(init?.headers);
                calls.push({ url, header: headers.get("Last-Event-ID") });
                return new Response(calls.length === 1 ? `${JSON.stringify(event0)}\n` : "", {
                    status: 200,
                    headers: { "content-type": "application/x-ndjson" },
                });
            },
            sink: { append: () => undefined },
        });
        clients.push(client);
        client.start();
        await vi.advanceTimersByTimeAsync(50);
        expect(calls).toHaveLength(2);
        expect(calls[1]!.header).toBeNull();
        expect(new URL(calls[1]!.url).searchParams.get("last_event_id")).toBe(unicodeId);
    });

    it("parses and tracks SSE : resume-gap and : dropped control comments", async () => {
        expect(parseSseControlComment("resume-gap 10-25")).toEqual({ kind: "resume-gap", from: 10, to: 25 });
        expect(parseSseControlComment("resume-gap 25-10")).toBeNull();
        expect(parseSseControlComment("dropped 7")).toEqual({ kind: "dropped", count: 7 });
        expect(parseSseControlComment("dropped 0")).toBeNull();
        expect(parseSseControlComment("keepalive")).toBeNull();

        const ev = makeEvent({ event_id: "tel-1-26", sequence: 26 });
        const body = `: keepalive\n: resume-gap 10-25\n: dropped 4\nid: tel-1-26\ndata: ${JSON.stringify(ev)}\n\n: dropped 3\n\n`;
        const client = new LiveIngestClient({
            url: "http://127.0.0.1:11437/v1/telemetry/sse",
            transport: "sse",
            discover: false,
            reconnect: false,
            flushIntervalMs: 1,
            fetch: async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
            sink: { append: () => undefined },
        });
        clients.push(client);
        client.start();
        await expect.poll(() => client.status.state).toBe("closed");
        expect(client.status.received).toBe(1);
        expect(client.status.resumeGaps).toBe(1);
        expect(client.status.serverDropped).toBe(7);
    });
});

describe("Malformed NDJSON/SSE resilience and memory bounds", () => {
    it("strips UTF-8 BOM and trailing CR on NDJSON LineSplitter streams", () => {
        const s = new LineSplitter();
        expect(s.feed("\uFEFF{\"a\":1}\r\n{\"b\":2}\r")).toEqual(["{\"a\":1}"]);
        expect(s.flush()).toEqual(["{\"b\":2}"]);
    });

    it("does not double-report or buffer subsequent lines inside an already-oversize SSE event", () => {
        const messages: SseMessage[] = [];
        const oversize: string[] = [];
        const p = new SseParser(
            { onMessage: (m) => messages.push(m), onOversize: (r) => oversize.push(r) },
            32,
        );
        p.feed(`data: ${"a".repeat(60)}\ndata: ${"b".repeat(60)}\ndata: ${"c".repeat(60)}\n\ndata: ok\n\n`);
        expect(oversize).toHaveLength(1);
        expect(p.bufferedChars).toBe(0);
        expect(messages.map((m) => m.data)).toEqual(["ok"]);
    });

    it("ignores oversized SSE id fields so Last-Event-ID stays bounded", () => {
        const messages: SseMessage[] = [];
        const p = new SseParser({ onMessage: (m) => messages.push(m) });
        p.feed(`id: good-1\ndata: one\n\nid: ${"x".repeat(MAX_SSE_FIELD_CHARS + 1)}\ndata: two\n\n`);
        expect(messages.map((m) => m.lastEventId)).toEqual(["good-1", "good-1"]);
        expect(p.currentLastEventId).toBe("good-1");
    });

    it("accepts multi-line pretty-printed JSON in SSE while still decoding batched NDJSON and skipping corrupt lines", async () => {
        const ev1 = makeEvent({ event_id: "tel-1-0", sequence: 0 });
        const ev2 = makeEvent({ event_id: "tel-1-1", sequence: 1 });
        const ev3 = makeEvent({ event_id: "tel-1-2", sequence: 2 });
        const prettyLines = JSON.stringify(ev1, null, 2)
            .split("\n")
            .map((line) => `data: ${line}`)
            .join("\n");
        const wire = [
            `id: tel-1-0\n${prettyLines}\n\n`,
            `id: bad\ndata: {not valid json\n\n`,
            `id: tel-1-2\ndata: ${JSON.stringify(ev2)}\ndata: ${JSON.stringify(ev3)}\n\n`,
        ].join("");
        const appended: string[] = [];
        const rejected: RejectedLine[] = [];
        const client = new LiveIngestClient({
            url: "http://127.0.0.1:11437/v1/telemetry/sse",
            transport: "sse",
            discover: false,
            reconnect: false,
            flushIntervalMs: 1,
            fetch: async () => new Response(wire, { status: 200, headers: { "content-type": "text/event-stream" } }),
            sink: {
                append: (batch) => {
                    appended.push(...batch.map((e) => e.event_id));
                },
                addRejected: (lines) => rejected.push(...lines),
            },
        });
        clients.push(client);
        client.start();
        await expect.poll(() => client.status.state).toBe("closed");
        await client.flush();
        expect(appended).toEqual(["tel-1-0", "tel-1-1", "tel-1-2"]);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]!.reason).toMatch(/invalid JSON/);
    });

    it("pauses HTTP streams before a large event overflows bufferMaxBytes (zero drops in pause mode)", async () => {
        const events = Array.from({ length: 4 }, (_, i) =>
            makeEvent({ event_id: `big-${i}`, sequence: i, attributes: { payload: "x".repeat(2500) } }),
        );
        // Each event is ~5.6 KiB estimated; maxBytes 8 KiB fits only 1 event at a time,
        // so highWaterBytes (6 KiB) alone wouldn't have paused before event #2!
        const wire = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
        const appended: string[] = [];
        const client = new LiveIngestClient({
            url: "http://127.0.0.1:11437/v1/telemetry/ndjson",
            transport: "ndjson",
            discover: false,
            reconnect: false,
            httpBackpressure: "pause",
            bufferCapacity: 100,
            bufferMaxBytes: 8_000,
            batchSize: 1,
            flushIntervalMs: 1,
            fetch: async () => new Response(wire, { status: 200, headers: { "content-type": "application/x-ndjson" } }),
            sink: {
                append: async (batch) => {
                    appended.push(...batch.map((e) => e.event_id));
                    await new Promise((r) => setTimeout(r, 2));
                },
            },
        });
        clients.push(client);
        client.start();
        await expect.poll(() => client.status.state).toBe("closed");
        await client.flush();
        expect(client.status.dropped).toBe(0);
        expect(appended).toEqual(["big-0", "big-1", "big-2", "big-3"]);
    });

    it("does not inflate appended counts when sink throws and immediately aborts discovery on stop()", async () => {
        const ev = makeEvent({ event_id: "e-0", sequence: 0 });
        const client = new LiveIngestClient({
            url: "http://127.0.0.1:11437/v1/telemetry/ndjson",
            transport: "ndjson",
            discover: false,
            reconnect: false,
            flushIntervalMs: 1,
            fetch: async () =>
                new Response(`{broken\n${JSON.stringify(ev)}\n`, {
                    status: 200,
                    headers: { "content-type": "application/x-ndjson" },
                }),
            sink: {
                append: () => {
                    throw new Error("disk full");
                },
                addRejected: () => {
                    throw new Error("rejected sink failed");
                },
            },
        });
        clients.push(client);
        client.start();
        await expect.poll(() => client.status.state).toBe("closed");
        expect(client.status.received).toBe(1);
        expect(client.status.appended).toBe(0);
        expect(client.status.batches).toBe(0);
        expect(client.status.lastError).toMatch(/sink error: disk full/);

        // stop() aborts an in-flight discovery fetch right away instead of hanging on timeout.
        let discoveryAborted = false;
        const slow = new LiveIngestClient({
            url: "http://127.0.0.1:11437",
            fetch: (_url, init) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => {
                        discoveryAborted = true;
                        reject(new DOMException("aborted", "AbortError"));
                    });
                }),
            sink: { append: () => undefined },
        });
        clients.push(slow);
        slow.start();
        await slow.stop();
        expect(discoveryAborted).toBe(true);
    });

    it("bounds frame line length in legacy LiveConnection.handleFrame", () => {
        const rejected: RejectedLine[] = [];
        const conn = new LiveConnection({
            onEvents: () => undefined,
            onRejected: (lines) => rejected.push(...lines),
        });
        conn.handleFrame("x".repeat(MAX_LINE_CHARS + 10));
        expect(conn.rejected).toBe(1);
        expect(rejected[0]!.reason).toMatch(/exceeds the .*limit/);
        expect(rejected[0]!.raw).toBe("");
    });
});
