/**
 * Prompt-cache reuse, speculative-decoding acceptance and "model default"
 * sampler fields. The fixture is hand-built from Sonder-Inference's emitters
 * (Ollama timing helper on main a2aa72d; llamaserver backend of PR #32,
 * feat/llama-server-backend); it is not a recorded run.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ObservatoryEvent } from "../src/protocol/events";
import { promptCacheReport, samplerSettings, speculationReport } from "../src/query/attributes";
import { deriveMetrics, UNKNOWN_MODEL } from "../src/query/metrics";
import { MetricsIndex } from "../src/query/metricsIndex";
import { parseNdjson } from "../src/recording/ndjson";
import { orderEvents } from "../src/replay/order";
import { promptCacheCardModel, requestReuseRows, speculationCardModel } from "../src/renderer/reuseCards";
import { at } from "./helpers";

const text = readFileSync(new URL("./fixtures/sonder-inference-cache-spec.jsonl", import.meta.url), "utf8");

function load(): ObservatoryEvent[] {
    const parsed = parseNdjson(text);
    expect(parsed.rejected).toEqual([]);
    return orderEvents(parsed.events).events;
}

const attrs = (attributes: Record<string, unknown>) => at(1, "backend.timing.prefill", { attributes });

describe("attribute readers", () => {
    it("reads Ollama prompt_eval_cached_count as part of prompt_eval_count", () => {
        expect(promptCacheReport(attrs({ prompt_eval_count: 35, prompt_eval_cached_count: 34 }))).toEqual({
            promptTokens: 35,
            cachedTokens: 34,
            evaluatedTokens: 1,
            source: "prompt_eval_cached_count",
        });
        // Ollama 0.33.3+ always reports the field: 0 is a measured miss, not missing evidence.
        expect(promptCacheReport(attrs({ prompt_eval_count: 12, prompt_eval_cached_count: 0 }))).toEqual({
            promptTokens: 12,
            cachedTokens: 0,
            evaluatedTokens: 12,
            source: "prompt_eval_cached_count",
        });
        // An event without the field reports nothing (unknown), even with prompt_eval_count.
        expect(promptCacheReport(attrs({ prompt_eval_count: 12 }))).toBeNull();
    });

    it("reads llamaserver backend_cached_tokens against prompt_tokens, and raw cache_n / prompt_n", () => {
        expect(promptCacheReport(attrs({ prompt_tokens: 12, backend_cached_tokens: 5 }))).toMatchObject({ promptTokens: 12, cachedTokens: 5, evaluatedTokens: 7, source: "backend_cached_tokens" });
        expect(promptCacheReport(attrs({ prompt_n: 7, cache_n: 5 }))).toMatchObject({ promptTokens: 12, cachedTokens: 5, evaluatedTokens: 7, source: "cache_n" });
    });

    it("never invents a report", () => {
        for (const a of [
            {},
            { prompt_eval_count: 35 },
            { prompt_eval_cached_count: 3 },
            { prompt_eval_count: 3, prompt_eval_cached_count: 4 },
            { prompt_tokens: 12 },
            { reused_prompt_tokens: 12, prompt_tokens: 12 },
            { backend_cached_tokens: 5 },
            { prompt_tokens: 4, backend_cached_tokens: 5 },
            { prompt_eval_count: 3.5, prompt_eval_cached_count: 1 },
            { prompt_eval_count: "35", prompt_eval_cached_count: "34" },
        ]) {
            expect(promptCacheReport(attrs(a))).toBeNull();
        }
        for (const a of [{}, { backend_draft_tokens: 4 }, { backend_draft_acceptance_ratio: 0.5 }, { backend_draft_tokens: 2, backend_draft_accepted_tokens: 3 }, { draft_n: -1, draft_n_accepted: 0 }]) {
            expect(speculationReport(attrs(a))).toBeNull();
        }
    });

    it("reads draft counts from backend_draft_* or raw draft_n / draft_n_accepted", () => {
        expect(speculationReport(attrs({ backend_draft_tokens: 4, backend_draft_accepted_tokens: 2 }))).toEqual({ draftTokens: 4, acceptedTokens: 2, source: "backend_draft_tokens" });
        expect(speculationReport(attrs({ draft_n: 0, draft_n_accepted: 0 }))).toEqual({ draftTokens: 0, acceptedTokens: 0, source: "draft_n" });
    });

    it("renders null explicit-only sampler fields and num_ctx 0 as model default, a null seed as unset", () => {
        const e = at(1, "request.started", {
            attributes: {
                sampling: { temperature: null, top_k: 0, top_p: 0.9, typical_p: 1.0, num_ctx: 0, seed: null, max_tokens: 64, explicit_only: true, other: null, nested: { a: 1 } },
            },
        });
        expect(samplerSettings(e)).toEqual([
            { key: "temperature", text: "model default", modelDefault: true },
            { key: "top_k", text: "0", modelDefault: false },
            { key: "top_p", text: "0.9", modelDefault: false },
            { key: "typical_p", text: "1", modelDefault: false },
            { key: "num_ctx", text: "model default", modelDefault: true },
            // Sonder-Inference: "Unset lets the backend choose" (an entropy seed), not the model's default.
            { key: "seed", text: "unset (backend chooses)", modelDefault: false },
            { key: "max_tokens", text: "64", modelDefault: false },
            { key: "other", text: "unset", modelDefault: false },
        ]);
        // Without explicit_only (older recordings) a null seed is still unset, not a model default.
        const legacy = samplerSettings(at(4, "session.created", { attributes: { sampling: { temperature: 0.8, seed: null, max_tokens: 128 } } }))!;
        expect(legacy.find((r) => r.key === "seed")).toEqual({ key: "seed", text: "unset (backend chooses)", modelDefault: false });
        expect(legacy.some((r) => r.modelDefault)).toBe(false);
        expect(samplerSettings(at(2, "request.started", { attributes: { kind: "chat" } }))).toBeNull();
        expect(samplerSettings(at(3, "request.started", { attributes: { sampling: [1] } }))).toBeNull();
    });
});

describe("prompt cache and speculation metrics", () => {
    const events = load();
    const m = deriveMetrics(events);

    it("reports each request's latest backend report and its model", () => {
        expect(m.requests.map((r) => [r.requestId, r.model, r.promptCache?.cachedTokens, r.promptCache?.promptTokens, r.speculation?.acceptedTokens ?? null])).toEqual([
            ["req-0a11a00000000001", "qwen3:8b", 34, 35, null],
            ["req-0b22b00000000003", "llama-3.2-3b-instruct-q4_k_m", 5, 12, 2],
            // prompt_eval_cached_count 0 is a measured miss (Ollama 0.33.3+ always reports the field).
            ["req-0a11a00000000002", "qwen3:8b", 0, 120, null],
            ["req-0b22b00000000004", "llama-3.2-3b-instruct-q4_k_m", 0, 40, 9],
        ]);
        const r1 = m.requests[0]!;
        expect(r1.promptCache).toMatchObject({ evaluatedTokens: 1, hitRatio: 34 / 35, source: "prompt_eval_cached_count" });
        expect(events.find((e) => e.event_id === r1.promptCache!.eventId)?.event_type).toBe("backend.timing.prefill");
        const r3 = m.requests[1]!;
        expect(r3.speculation).toMatchObject({ draftTokens: 4, acceptedTokens: 2, acceptanceRate: 0.5, source: "backend_draft_tokens" });
        expect(events.find((e) => e.event_id === r3.speculation!.eventId)?.event_type).toBe("request.completed");
    });

    it("aggregates token-weighted per session and per model", () => {
        expect(m.promptCache).toMatchObject({ requests: 4, promptTokens: 207, cachedTokens: 39, evaluatedTokens: 168, hitRatio: 39 / 207, unreportedRequests: 0 });
        expect(m.promptCache.byModel).toEqual({
            "qwen3:8b": { requests: 2, promptTokens: 155, cachedTokens: 34, evaluatedTokens: 121, hitRatio: 34 / 155, unreportedRequests: 0 },
            "llama-3.2-3b-instruct-q4_k_m": { requests: 2, promptTokens: 52, cachedTokens: 5, evaluatedTokens: 47, hitRatio: 5 / 52, unreportedRequests: 0 },
        });
        expect(Object.keys(m.promptCache.bySession)).toEqual(["sess-0a11a0000000cafe", "sess-0b22b0000000beef"]);
        expect(m.promptCache.eventIds).toHaveLength(4);
        expect(m.speculation).toMatchObject({ requests: 2, draftTokens: 14, acceptedTokens: 11, acceptanceRate: 11 / 14, acceptedPerRequest: 5.5 });
        expect(Object.keys(m.speculation.byModel)).toEqual(["llama-3.2-3b-instruct-q4_k_m"]);
        expect(m.speculation.bySession["sess-0b22b0000000beef"]).toMatchObject({ requests: 2, acceptanceRate: 11 / 14 });
    });

    it("leaves the existing token and latency metrics of the same stream intact", () => {
        expect(m.tokens.provenance).toBe("backend-reported");
        expect(m.tokens.total).toBe(6 + 6 + 2 + 2);
        expect(m.requestLatency.count).toBe(4);
    });

    it("renders cards and inspector rows only with reports", () => {
        const cache = promptCacheCardModel(m)!;
        expect(cache.value).toBe("19% cached");
        expect(cache.sub).toBe("39 of 207 prompt tokens served from cache · 168 evaluated · 4 requests in 2 sessions");
        expect(cache.rows).toEqual([
            ["qwen3:8b", "22% cached · 34 / 155 prompt tokens · 2 reqs"],
            ["llama-3.2-3b-instruct-q4_k_m", "10% cached · 5 / 52 prompt tokens · 2 reqs"],
        ]);
        expect(cache.sessionRows).toEqual([
            ["sess-0a11a0000000cafe", "22% cached · 34 / 155 prompt tokens · 2 reqs"],
            ["sess-0b22b0000000beef", "10% cached · 5 / 52 prompt tokens · 2 reqs"],
        ]);
        expect(cache.moreSessions).toBe(0);
        const spec = speculationCardModel(m)!;
        expect(spec.value).toBe("79% accepted");
        expect(spec.sub).toBe("11 of 14 draft tokens accepted · mean 5.5 accepted per request · 2 requests");
        expect(spec.sessionRows).toEqual([["sess-0b22b0000000beef", "79% accepted · 11 / 14 draft tokens · 2 reqs"]]);
        expect(requestReuseRows(m.requests[1]!)).toEqual([
            ["model", "llama-3.2-3b-instruct-q4_k_m"],
            ["prompt cache", "5 / 12 prompt tokens cached (42%) · 7 evaluated · backend_cached_tokens"],
            ["speculation", "2 / 4 draft tokens accepted (50%) · backend_draft_tokens"],
        ]);
        // A prompt_eval_cached_count of 0 is shown as a measured miss.
        expect(requestReuseRows(m.requests[2]!)).toEqual([
            ["model", "qwen3:8b"],
            ["prompt cache", "0 / 120 prompt tokens cached (0%) · 120 evaluated · prompt_eval_cached_count"],
        ]);
        const bare = deriveMetrics([at(1, "request.started", { request_id: "r" }), at(2, "request.completed", { request_id: "r" })]);
        expect(promptCacheCardModel(bare)).toBeNull();
        expect(speculationCardModel(bare)).toBeNull();
        expect(requestReuseRows(bare.requests[0]!)).toEqual([]);
    });

    it("shows the explicit-only session sampling as model defaults", () => {
        const created = events.find((e) => e.event_type === "session.created" && e.attributes.backend === "ollama")!;
        const rows = samplerSettings(created)!;
        expect(rows.filter((r) => r.modelDefault).map((r) => r.key)).toEqual([
            "temperature",
            "top_k",
            "min_p",
            "repeat_penalty",
            "repeat_last_n",
            "presence_penalty",
            "frequency_penalty",
            "num_ctx",
        ]);
        expect(rows.find((r) => r.key === "top_p")).toEqual({ key: "top_p", text: "0.9", modelDefault: false });
        // Producer shapes: typical_p and max_tokens are always values, seed null is "backend chooses".
        expect(rows.find((r) => r.key === "typical_p")).toEqual({ key: "typical_p", text: "1", modelDefault: false });
        expect(rows.find((r) => r.key === "max_tokens")).toEqual({ key: "max_tokens", text: "256", modelDefault: false });
        expect(rows.find((r) => r.key === "seed")).toEqual({ key: "seed", text: "unset (backend chooses)", modelDefault: false });
    });

    it("metricsAt equals deriveMetrics for every prefix of the fixture", () => {
        const index = new MetricsIndex(events);
        const counts = [...Array(events.length + 1).keys()];
        for (const c of [...counts].reverse()) {
            expect(index.at(c)).toEqual(deriveMetrics(events.slice(0, c)));
        }
    });

    it("excludes requests without cache data from the ratio and counts them on the card", () => {
        const prefill = (ms: number, rid: string, sid: string, attributes: Record<string, unknown>) =>
            at(ms, "backend.timing.prefill", { request_id: rid, session_id: sid, attributes: { model: "m", ...attributes } });
        const ev = [
            at(1, "request.started", { request_id: "a", session_id: "s1" }),
            prefill(2, "a", "s1", { prompt_eval_count: 100, prompt_eval_cached_count: 80 }),
            at(3, "request.started", { request_id: "b", session_id: "s1" }),
            // A measured miss: counted, 0 cached.
            prefill(4, "b", "s1", { prompt_eval_count: 100, prompt_eval_cached_count: 0 }),
            at(5, "request.started", { request_id: "c", session_id: "s1" }),
            // No cached-count field (an older producer / Ollama): unknown, excluded.
            prefill(6, "c", "s1", { prompt_eval_count: 100 }),
            at(7, "request.completed", { request_id: "c", session_id: "s1" }),
            at(8, "request.started", { request_id: "d", session_id: "s2" }),
            at(9, "request.completed", { request_id: "d", session_id: "s2" }),
            // Still open: it may report later, so it is not counted as without data.
            at(10, "request.started", { request_id: "e", session_id: "s1" }),
        ];
        const u = deriveMetrics(ev);
        expect(u.promptCache).toMatchObject({ requests: 2, promptTokens: 200, cachedTokens: 80, evaluatedTokens: 120, hitRatio: 0.4, unreportedRequests: 2 });
        // A group exists only where a request reported; s2 has none.
        expect(u.promptCache.byModel).toEqual({ m: { requests: 2, promptTokens: 200, cachedTokens: 80, evaluatedTokens: 120, hitRatio: 0.4, unreportedRequests: 1 } });
        expect(Object.keys(u.promptCache.bySession)).toEqual(["s1"]);
        expect(u.promptCache.bySession.s1!.unreportedRequests).toBe(1);
        const card = promptCacheCardModel(u)!;
        expect(card.value).toBe("40% cached");
        expect(card.sub).toBe("80 of 200 prompt tokens served from cache · 120 evaluated · 2 requests · 2 requests without cache data");
        expect(card.rows).toEqual([["m", "40% cached · 80 / 200 prompt tokens · 2 reqs · 1 req without cache data"]]);
        expect(requestReuseRows(u.requests[2]!)).toEqual([]);
        const index = new MetricsIndex(ev);
        for (let c = ev.length; c >= 0; c--) {
            expect(index.at(c)).toEqual(deriveMetrics(ev.slice(0, c)));
        }
    });

    it("groups requests with no model under UNKNOWN_MODEL", () => {
        const u = deriveMetrics([
            at(1, "request.started", { request_id: "r" }),
            at(2, "request.completed", { request_id: "r", attributes: { prompt_tokens: 10, backend_cached_tokens: 4 } }),
        ]);
        expect(u.requests[0]!.model).toBeNull();
        expect(Object.keys(u.promptCache.byModel)).toEqual([UNKNOWN_MODEL]);
    });
});
