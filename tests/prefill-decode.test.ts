import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ObservatoryEvent } from "../src/protocol/events";
import { derivePrefillDecode, MODEL_RELOAD_MIN_MS } from "../src/query/prefillDecode";
import { prefillDecodeAt } from "../src/query/prefillDecodeIndex";
import { parseNdjson } from "../src/recording/ndjson";
import { orderEvents } from "../src/replay/order";
import { SessionStore } from "../src/replay/session";
import { at } from "./helpers";

const cacheSpecText = readFileSync(new URL("./fixtures/sonder-inference-cache-spec.jsonl", import.meta.url), "utf8");

function cacheSpecEvents(): ObservatoryEvent[] {
    const parsed = parseNdjson(cacheSpecText);
    expect(parsed.rejected).toEqual([]);
    return orderEvents(parsed.events).events;
}

describe("derivePrefillDecode", () => {
    it("separates prefill tok/s from decode tok/s and divides by uncached evaluated tokens (never inflating cache hits)", () => {
        const events = cacheSpecEvents();
        const pd = derivePrefillDecode(events);

        expect(pd.requests).toHaveLength(4);

        // Req 1 (Ollama qwen3:8b): 35 prompt tokens, 34 cached -> 1 evaluated over 12 ms = 83.33 tok/s (not inflated 35/0.012)
        // Warm load_duration_ns = 21 ms (< MODEL_RELOAD_MIN_MS) -> steady-prefill, NOT reload.
        const r1 = pd.requests[0]!;
        expect(r1).toMatchObject({
            requestId: "req-0a11a00000000001",
            model: "qwen3:8b",
            promptTokens: 35,
            cachedPromptTokens: 34,
            evaluatedPromptTokens: 1,
            fullPromptCacheHit: false,
            prefillMs: 12,
            decodeTokens: 6,
            decodeMs: 80,
            ttftClass: "steady-prefill",
        });
        expect(r1.prefillTokPerSec).toBeCloseTo(1 / 0.012, 5);
        expect(r1.decodeTokPerSec).toBeCloseTo(75, 5);

        // Req 2 (llamaserver): 12 prompt tokens, 5 cached -> 7 evaluated over 1.5 ms; decode 2 tokens over 2.25 ms.
        const r2 = pd.requests[1]!;
        expect(r2.evaluatedPromptTokens).toBe(7);
        expect(r2.prefillTokPerSec).toBeCloseTo(7 / 0.0015, 5);
        expect(r2.decodeTokPerSec).toBeCloseTo(2 / 0.00225, 5);
        expect(r2.ttftClass).toBe("steady-prefill");

        // Req 3 (Ollama): 120 prompt tokens, 0 cached -> 120 evaluated over 12 ms = 10000 tok/s.
        expect(pd.requests[2]!.prefillTokPerSec).toBeCloseTo(10000, 5);

        // Token-weighted aggregate prefill = (1 + 7 + 120 + 40) / ((12 + 1.5 + 12 + 1.5) / 1000)
        expect(pd.prefill.totalEvaluatedTokens).toBe(168);
        expect(pd.prefill.rateTokPerSec).toBeCloseTo(168 / 0.027, 4);
        // Token-weighted aggregate decode = (6 + 2 + 6 + 2) / ((80 + 2.25 + 80 + 2.25) / 1000)
        expect(pd.decode.totalTokens).toBe(16);
        expect(pd.decode.rateTokPerSec).toBeCloseTo(16 / 0.1645, 4);
        expect(pd.ttft.reload.count).toBe(0);
        expect(pd.ttft.steadyPrefill.count).toBe(4);
    });

    it("marks 100% prompt-cache hits without inventing an inflated prefill tok/s", () => {
        const events = [
            at(0, "request.started", { request_id: "r-hit" }),
            at(5, "inference.token.generated", { request_id: "r-hit", attributes: { unit: "chunk" } }),
            at(50, "inference.prefill.completed", {
                request_id: "r-hit",
                attributes: {
                    prompt_tokens: 4096,
                    backend_cached_tokens: 4096,
                    backend_prompt_eval_ms: 2.0,
                    ttft_ms: 5.0,
                },
            }),
            at(100, "request.completed", { request_id: "r-hit", attributes: { completion_tokens: 10, token_counts_from_backend: true, ttft_ms: 5, total_ms: 100 } }),
        ];
        const pd = derivePrefillDecode(events);
        expect(pd.requests[0]!.fullPromptCacheHit).toBe(true);
        expect(pd.requests[0]!.prefillTokPerSec).toBeNull();
        expect(pd.prefill.fullCacheHitRequests).toBe(1);
        expect(pd.prefill.rateTokPerSec).toBeNull();
    });

    it("separates model reloads from steady long-prompt prefill and unexplained TTFT overhead spikes", () => {
        const prod = { name: "sonder-inference", version: "0.4.0", node_id: "NODE1", instance_id: "tel-node1" };
        const events: ObservatoryEvent[] = [
            // 1. Cold model reload via backend.model.load.reported (4.2 s load, 180 ms prefill, 4.45 s TTFT)
            at(0, "request.started", { producer: prod, request_id: "r-reload" }),
            at(4450, "inference.token.generated", { producer: prod, request_id: "r-reload", attributes: { unit: "chunk" } }),
            at(5000, "backend.model.load.reported", { producer: prod, request_id: "r-reload", attributes: { backend: "llamaserver", model: "qwen3-80b", load_duration_ns: 4_200_000_000 } }),
            at(5000, "inference.prefill.completed", { producer: prod, request_id: "r-reload", attributes: { prompt_tokens: 120, backend_prompt_eval_ms: 180, ttft_ms: 4450 } }),
            at(5000, "inference.decode.completed", { producer: prod, request_id: "r-reload", attributes: { completion_tokens: 20, backend_eval_ms: 500 } }),
            at(5000, "request.completed", { producer: prod, request_id: "r-reload", attributes: { completion_tokens: 20, token_counts_from_backend: true, ttft_ms: 4450, total_ms: 5000 } }),

            // 2. Steady long-prompt prefill (2426 tokens in 10s = 242.6 tok/s, TTFT 10.05s — NOT a reload!)
            at(6000, "request.started", { producer: prod, request_id: "r-steady" }),
            at(16050, "inference.token.generated", { producer: prod, request_id: "r-steady", attributes: { unit: "chunk" } }),
            at(26050, "inference.prefill.completed", { producer: prod, request_id: "r-steady", attributes: { prompt_tokens: 2426, backend_prompt_eval_ms: 10_000, ttft_ms: 10_050 } }),
            at(26050, "inference.decode.completed", { producer: prod, request_id: "r-steady", attributes: { completion_tokens: 385, backend_eval_ms: 10_000 } }),
            at(26050, "request.completed", { producer: prod, request_id: "r-steady", attributes: { completion_tokens: 385, token_counts_from_backend: true, ttft_ms: 10_050, total_ms: 20_050 } }),

            // 3. Reload triggered via resident model.load.completed just before request.started
            at(27000, "model.load.completed", { producer: prod, attributes: { model: "qwen3-80b", resident: true, duration_ms: 3100 } }),
            at(27200, "request.started", { producer: prod, request_id: "r-preload" }),
            at(30500, "inference.token.generated", { producer: prod, request_id: "r-preload", attributes: { unit: "chunk" } }),
            at(31000, "inference.prefill.completed", { producer: prod, request_id: "r-preload", attributes: { prompt_tokens: 200, backend_prompt_eval_ms: 200, ttft_ms: 3300 } }),
            at(31000, "request.completed", { producer: prod, request_id: "r-preload", attributes: { completion_tokens: 15, token_counts_from_backend: true, ttft_ms: 3300, total_ms: 3800 } }),

            // 4. Unexplained overhead spike (no load event, no queue wait, 3.2s TTFT vs 100ms prefill)
            at(32000, "request.started", { producer: prod, request_id: "r-spike" }),
            at(35200, "inference.token.generated", { producer: prod, request_id: "r-spike", attributes: { unit: "chunk" } }),
            at(36000, "inference.prefill.completed", { producer: prod, request_id: "r-spike", attributes: { prompt_tokens: 100, backend_prompt_eval_ms: 100, ttft_ms: 3200 } }),
            at(36000, "request.completed", { producer: prod, request_id: "r-spike", attributes: { completion_tokens: 20, token_counts_from_backend: true, ttft_ms: 3200, total_ms: 4000 } }),

            // 5. High TTFT explained by admission queue_ms -> steady-prefill (NOT overhead spike)
            at(37000, "request.started", { producer: prod, request_id: "r-queued" }),
            at(40200, "inference.token.generated", { producer: prod, request_id: "r-queued", attributes: { unit: "chunk" } }),
            at(41000, "inference.prefill.completed", { producer: prod, request_id: "r-queued", attributes: { prompt_tokens: 100, backend_prompt_eval_ms: 150, ttft_ms: 3200 } }),
            at(41000, "request.completed", { producer: prod, request_id: "r-queued", attributes: { completion_tokens: 20, token_counts_from_backend: true, ttft_ms: 3200, total_ms: 4000, admission: { priority: "background", queue_ms: 3000 } } }),
        ];

        const pd = derivePrefillDecode(events);
        expect(pd.requests.map((r) => [r.requestId, r.ttftClass])).toEqual([
            ["r-reload", "reload"],
            ["r-steady", "steady-prefill"],
            ["r-preload", "reload"],
            ["r-spike", "overhead-spike"],
            ["r-queued", "steady-prefill"],
        ]);
        expect(pd.requests[1]!.prefillTokPerSec).toBeCloseTo(242.6, 4);
        expect(pd.requests[1]!.decodeTokPerSec).toBeCloseTo(38.5, 4);
        expect(pd.ttft.reload.count).toBe(2);
        expect(pd.ttft.steadyPrefill.count).toBe(2);
        expect(pd.ttft.overheadSpike.count).toBe(1);
        expect(pd.ttft.classifiedCount).toBe(5);
        expect(MODEL_RELOAD_MIN_MS).toBe(250);
    });

    it("falls back to backend.metrics.sample gauges when no per-request timings exist and ignores metadata-only loads", () => {
        const events = [
            at(10, "model.load.completed", { attributes: { model: "qwen3:8b", resident: false, duration_ms: 5000 } }),
            at(20, "backend.metrics.sample", {
                attributes: {
                    backend: "llamaserver",
                    status: "ok",
                    metrics: { prompt_tokens_seconds: 1050.5, predicted_tokens_seconds: 86.8 },
                },
            }),
        ];
        const pd = derivePrefillDecode(events);
        expect(pd.prefill.rateTokPerSec).toBe(1050.5);
        expect(pd.prefill.gaugeRateTokPerSec).toBe(1050.5);
        expect(pd.prefill.provenance).toBe("backend-reported");
        expect(pd.decode.rateTokPerSec).toBe(86.8);
        expect(pd.decode.gaugeRateTokPerSec).toBe(86.8);
        expect(pd.ttft.classifiedCount).toBe(0);
    });

    it("prefillDecodeAt matches derivePrefillDecode across every prefix, live append, and eviction", () => {
        const events = cacheSpecEvents();
        for (const c of [0, 5, 14, 22, 34, events.length, 10, 0, events.length]) {
            expect(prefillDecodeAt(events, c)).toEqual(derivePrefillDecode(events.slice(0, c)));
        }

        const store = new SessionStore({ maxLiveEvents: 15 });
        store.reset("live", "prefill-decode");
        store.append(events.slice(0, 14));
        const before = prefillDecodeAt(store.events);
        store.append([at(900001000, "device.memory.sample", { attributes: { kind: "cpu", total_bytes: 100, available_bytes: 50 } })]);
        expect(prefillDecodeAt(store.events)).toBe(before);
        store.append(events.slice(14));
        expect(prefillDecodeAt(store.events)).toEqual(derivePrefillDecode(store.events));
    });
});
