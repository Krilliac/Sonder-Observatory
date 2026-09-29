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
        // Older Ollama reports 0: a real zero, shown as 0% cached.
        expect(promptCacheReport(attrs({ prompt_eval_count: 12, prompt_eval_cached_count: 0 }))?.cachedTokens).toBe(0);
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

    it("renders null sampler fields and num_ctx 0 as model default", () => {
        const e = at(1, "request.started", {
            attributes: { sampling: { temperature: null, top_k: 0, top_p: 0.9, num_ctx: 0, seed: null, max_tokens: 64, explicit_only: true, nested: { a: 1 } } },
        });
        expect(samplerSettings(e)).toEqual([
            { key: "temperature", text: "model default", modelDefault: true },
            { key: "top_k", text: "0", modelDefault: false },
            { key: "top_p", text: "0.9", modelDefault: false },
            { key: "num_ctx", text: "model default", modelDefault: true },
            { key: "seed", text: "model default", modelDefault: true },
            { key: "max_tokens", text: "64", modelDefault: false },
        ]);
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
        expect(m.promptCache).toMatchObject({ requests: 4, promptTokens: 207, cachedTokens: 39, evaluatedTokens: 168, hitRatio: 39 / 207 });
        expect(m.promptCache.byModel).toEqual({
            "qwen3:8b": { requests: 2, promptTokens: 155, cachedTokens: 34, evaluatedTokens: 121, hitRatio: 34 / 155 },
            "llama-3.2-3b-instruct-q4_k_m": { requests: 2, promptTokens: 52, cachedTokens: 5, evaluatedTokens: 47, hitRatio: 5 / 52 },
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
        const spec = speculationCardModel(m)!;
        expect(spec.value).toBe("79% accepted");
        expect(spec.sub).toBe("11 of 14 draft tokens accepted · mean 5.5 accepted per request · 2 requests");
        expect(requestReuseRows(m.requests[1]!)).toEqual([
            ["model", "llama-3.2-3b-instruct-q4_k_m"],
            ["prompt cache", "5 / 12 prompt tokens cached (42%) · 7 evaluated · backend_cached_tokens"],
            ["speculation", "2 / 4 draft tokens accepted (50%) · backend_draft_tokens"],
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
            "typical_p",
            "repeat_last_n",
            "presence_penalty",
            "frequency_penalty",
            "num_ctx",
            "max_tokens",
            "seed",
        ]);
        expect(rows.find((r) => r.key === "top_p")).toEqual({ key: "top_p", text: "0.9", modelDefault: false });
    });

    it("metricsAt equals deriveMetrics for every prefix of the fixture", () => {
        const index = new MetricsIndex(events);
        const counts = [...Array(events.length + 1).keys()];
        for (const c of [...counts].reverse()) {
            expect(index.at(c)).toEqual(deriveMetrics(events.slice(0, c)));
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
