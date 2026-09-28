import { describe, expect, it } from "vitest";
import { requestFacts } from "../src/compare/summary";
import type { ObservatoryEvent } from "../src/protocol/events";
import { deriveMetrics } from "../src/query/metrics";
import { tokenCardModel } from "../src/renderer/tokenCard";
import { at } from "./helpers";

/**
 * Token metrics against the shapes Sonder-Inference actually emits for a
 * backend-streamed (Ollama) request: `inference.token.generated` events are
 * visible output CHUNKS (`unit: "chunk"`, no token count; hidden thinking
 * tokens produce no chunk at all), and the authoritative counts arrive on
 * `request.completed` (`completion_tokens` with `token_counts_from_backend`)
 * and `inference.decode.completed` (`backend_eval_ms`).
 */
const SAMPLED = { level: "standard" as const, sampled: true };

function chunk(ms: number, rid: string, index: number): ObservatoryEvent {
    return at(ms, "inference.token.generated", {
        request_id: rid,
        event_id: `chunk_${rid}_${index}`,
        sampling: SAMPLED,
        attributes: { index, bytes: 12, elapsed_ms: ms, unit: "chunk" },
    });
}

function token(ms: number, rid: string | null, index: number): ObservatoryEvent {
    return at(ms, "inference.token.generated", {
        ...(rid ? { request_id: rid } : {}),
        event_id: `tok_${rid ?? "none"}_${index}`,
        sampling: SAMPLED,
        attributes: { index, unit: "token", count: 1, token_id: 100 + index, probability: 0.5 },
    });
}

interface OllamaRequestOptions {
    rid?: string;
    startMs?: number;
    ttftMs?: number;
    totalMs?: number;
    chunks?: number;
    completion?: number;
    backendEvalMs?: number | null;
    complete?: boolean;
}

/** One qwen3-style request: long hidden thinking, then 15 visible chunks, 463 backend tokens. */
function ollamaRequest(o: OllamaRequestOptions = {}): ObservatoryEvent[] {
    const rid = o.rid ?? "req-1";
    const start = o.startMs ?? 0;
    const ttft = o.ttftMs ?? 9000;
    const total = o.totalMs ?? 10000;
    const n = o.chunks ?? 15;
    const events: ObservatoryEvent[] = [at(start, "request.started", { request_id: rid, event_id: `start_${rid}` })];
    for (let i = 0; i < n; i += 1) {
        events.push(chunk(start + ttft + (i * (total - ttft - 100)) / Math.max(1, n - 1), rid, i));
    }
    if (o.complete === false) {
        return events;
    }
    const completion = o.completion ?? 463;
    const evalMs = o.backendEvalMs === undefined ? 9500 : o.backendEvalMs;
    events.push(
        at(start + total - 50, "inference.decode.completed", {
            request_id: rid,
            event_id: `dec_${rid}`,
            attributes: {
                completion_tokens: completion,
                chunks: n,
                decode_wall_ms: total - ttft,
                ...(evalMs !== null ? { backend_eval_ms: evalMs, backend_tokens_per_sec: (completion * 1000) / evalMs } : {}),
            },
        }),
        at(start + total, "request.completed", {
            request_id: rid,
            event_id: `done_${rid}`,
            attributes: {
                outcome: "completed",
                prompt_tokens: 2483,
                completion_tokens: completion,
                chunks: n,
                token_counts_from_backend: true,
                ttft_ms: ttft,
                total_ms: total,
            },
        }),
    );
    return events;
}

describe("token metrics: chunks are not tokens", () => {
    it("never counts a chunk event as a token; the backend count is the total", () => {
        const m = deriveMetrics(ollamaRequest());
        expect(m.tokens.total).toBe(463);
        expect(m.tokens.provenance).toBe("backend-reported");
        expect(m.tokens.fromBackend).toBe(463);
        expect(m.tokens.fromEvents).toBe(0);
        expect(m.tokens.chunks).toBe(15);
        const span = m.requests[0]!;
        expect(span.tokens).toBe(0);
        expect(span.chunks).toBe(15);
        expect(span.backendTokens).toBe(463);
        // TTFT still comes from the first visible output event.
        expect(m.timeToFirstToken.p50Ms).toBe(9000);
    });

    it("does not count a live chunk stream with no count yet, and says so", () => {
        const m = deriveMetrics(ollamaRequest({ complete: false }));
        expect(m.tokens.total).toBe(0);
        expect(m.tokens.provenance).toBe("unavailable");
        expect(m.tokens.chunks).toBe(15);
        expect(m.tokens.uncountedRequests).toBe(1);
        expect(m.tokens.overallRate).toBeNull();
        expect(m.tokens.recentRate).toBeNull();
    });

    it("ignores any non-token unit", () => {
        const m = deriveMetrics([
            at(0, "inference.token.generated", { attributes: { unit: "bytes", count: 40 } }),
            at(10, "inference.token.generated", { attributes: { unit: "chunk", count: 3 } }),
        ]);
        expect(m.tokens.total).toBe(0);
        expect(m.tokens.chunks).toBe(2);
    });

    it("counts per-token events (unit token, sampled envelope) and events with no unit", () => {
        const m = deriveMetrics([
            at(0, "request.started", { request_id: "r" }),
            token(100, "r", 0),
            token(200, "r", 1),
            at(300, "inference.token.generated", { request_id: "r", attributes: {} }),
            at(400, "request.completed", { request_id: "r" }),
        ]);
        expect(m.tokens.total).toBe(3);
        expect(m.tokens.provenance).toBe("derived");
        expect(m.requests[0]!.tokens).toBe(3);
    });

    it("prefers the backend count over per-token events of the same request (no double count)", () => {
        const events = [
            at(0, "request.started", { request_id: "r" }),
            token(100, "r", 0),
            token(200, "r", 1),
            at(300, "request.completed", { request_id: "r", attributes: { completion_tokens: 7, token_counts_from_backend: true } }),
        ];
        const m = deriveMetrics(events);
        expect(m.tokens.total).toBe(7);
        expect(m.tokens.provenance).toBe("backend-reported");
    });

    it("mixes backend counts and per-token producers and labels the total as mixed", () => {
        const events = [
            ...ollamaRequest({ rid: "a" }),
            at(20_000, "request.started", { request_id: "b" }),
            token(20_100, "b", 0),
            token(20_200, "b", 1),
            token(20_300, "b", 2),
            at(20_400, "request.completed", { request_id: "b" }),
        ];
        const m = deriveMetrics(events);
        expect(m.tokens.total).toBe(466);
        expect(m.tokens.fromBackend).toBe(463);
        expect(m.tokens.fromEvents).toBe(3);
        expect(m.tokens.provenance).toBe("mixed");
    });
});

describe("token metrics: rate over active generation time", () => {
    it("uses the backend eval window when reported", () => {
        const m = deriveMetrics(ollamaRequest());
        expect(m.requests[0]!.decode).toMatchObject({ source: "backend-eval", ns: 9500e6, tokens: 463 });
        expect(m.tokens.overallRate).toBeCloseTo(463 / 9.5, 6);
        expect(m.tokens.activeDecodeMs).toBeCloseTo(9500, 6);
    });

    it("falls back to total_ms - ttft_ms when no backend eval time is reported", () => {
        const m = deriveMetrics(ollamaRequest({ backendEvalMs: null }));
        expect(m.requests[0]!.decode).toMatchObject({ source: "reported-total-minus-ttft", ns: 1000e6, tokens: 462 });
        expect(m.tokens.overallRate).toBeCloseTo(462, 6);
    });

    it("is not diluted by idle time between requests or after them", () => {
        const events: ObservatoryEvent[] = [];
        for (const [rid, start] of [
            ["r1", 0],
            ["r2", 61_000],
        ] as const) {
            events.push(at(start, "request.started", { request_id: rid }));
            for (let i = 0; i <= 10; i += 1) {
                events.push(token(start + 100 + i * 100, rid, i));
            }
            events.push(at(start + 1100, "request.completed", { request_id: rid }));
        }
        events.push(at(120_000, "device.memory.sample", { attributes: { used_bytes: 1, total_bytes: 2 } }));
        const m = deriveMetrics(events);
        expect(m.tokens.total).toBe(22);
        // 10 tokens after the first, over 1.0 s of decode, per request: 10 tok/s, not 22 / 120 s.
        expect(m.tokens.overallRate).toBeCloseTo(10, 6);
        expect(m.tokens.recentRate).toBe(0);
    });

    it("spreads a backend count over its decode window for the trailing-window rate", () => {
        const m = deriveMetrics(ollamaRequest());
        // Window [5000, 10000] ms; decode window [450, 9950] ms; overlap 4950 ms of 9500.
        expect(m.tokens.recentRate).toBeCloseTo((463 * (4950 / 9500)) / 5, 6);
    });

    it("keeps the first-to-last token rate for token events without a request", () => {
        const events = [];
        for (let i = 0; i <= 10; i += 1) {
            events.push(token(i * 100, null, i));
        }
        const m = deriveMetrics(events);
        expect(m.tokens.total).toBe(11);
        // 10 intervals over 1.0 s (the first token opens the span).
        expect(m.tokens.overallRate).toBeCloseTo(10, 6);
    });
});

describe("token card", () => {
    it("labels a backend-reported total and the chunks it does not count", () => {
        const card = tokenCardModel(deriveMetrics(ollamaRequest()));
        expect(card.sub).toContain("463 tokens");
        expect(card.evidence).toMatch(/^backend-reported/);
        expect(card.evidence).toContain("15 output chunks not counted as tokens");
    });

    it("never presents chunk events as a token count", () => {
        const card = tokenCardModel(deriveMetrics(ollamaRequest({ complete: false })));
        expect(card.value).toBe("—");
        expect(card.sub).not.toMatch(/15 tokens/);
        expect(card.evidence).toMatch(/^unavailable/);
        expect(card.evidence).toContain("15 output chunks");
    });

    it("labels event-derived totals as derived", () => {
        const card = tokenCardModel(deriveMetrics([token(0, null, 0), token(100, null, 1)]));
        expect(card.evidence).toMatch(/^derived · 2 tokens from inference\.token\.generated/);
    });
});

describe("compare request facts", () => {
    it("does not count chunks as streamed tokens and uses the backend decode window", () => {
        const [r] = requestFacts(ollamaRequest({ backendEvalMs: null }));
        expect(r!.streamedTokens).toBe(0);
        expect(r!.completionTokens).toBe(463);
        expect(r!.decodeSource).toBe("derived");
        expect(r!.decodeTokPerSec).toBeCloseTo(462, 6);
    });
});
