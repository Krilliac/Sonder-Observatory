import { describe, expect, it } from "vitest";
import type { ObservatoryEvent } from "../src/protocol/events";
import { deriveMetrics, isEmbeddingRequestEvent } from "../src/query/metrics";
import { MetricsIndex, metricsAt } from "../src/query/metricsIndex";
import { orderEvents } from "../src/replay/order";
import { at } from "./helpers";

const rt = {
    name: "sonder-runtime",
    version: "0.9.0",
    node_id: "workstation",
    instance_id: "rt-wave2-01",
    role: "runtime",
};

const inf = {
    name: "sonder-inference",
    version: "0.4.0",
    node_id: "NODE1",
    instance_id: "tel-wave2-01",
    role: "inference",
};

describe("metrics execution_route breakdown", () => {
    it("attributes execution_route metadata to spans (pre-start and in-flight) and breaks down latency by mode and band", () => {
        const events: ObservatoryEvent[] = [
            // Route selected BEFORE request.started attaches to the span once started.
            at(0, "route.selected", {
                producer: rt,
                request_id: "turn-ens",
                attributes: {
                    execution_route: {
                        mode: "ensemble",
                        band: "hard",
                        difficulty_score: 0.78,
                        recommended_tiers: ["code", "reasoning"],
                        ensemble_mode: "code",
                        auto_selected: true,
                    },
                },
            }),
            at(10, "request.started", { producer: rt, request_id: "turn-ens", attributes: { kind: "chat" } }),
            at(210, "request.completed", { producer: rt, request_id: "turn-ens", attributes: { total_ms: 200 } }),

            // Route selected AFTER request.started and enriched on completion.
            at(300, "request.started", { producer: rt, request_id: "turn-fan", attributes: { kind: "chat" } }),
            at(305, "route.selected", {
                producer: rt,
                request_id: "turn-fan",
                attributes: {
                    execution_mode: "fanout",
                    difficulty_band: "multi_scope",
                    difficulty_score: 0.91,
                    fanout_scope: "local",
                    worker_count: 3,
                    auto_selected: true,
                },
            }),
            at(700, "request.completed", { producer: rt, request_id: "turn-fan", attributes: { total_ms: 400 } }),

            // Quick single-tier manual turn.
            at(800, "request.started", {
                producer: rt,
                request_id: "turn-single",
                attributes: {
                    kind: "chat",
                    execution_route: {
                        mode: "single",
                        band: "quick",
                        difficulty_score: 0.12,
                        recommended_tiers: ["fast"],
                        auto_selected: false,
                    },
                },
            }),
            at(850, "request.completed", { producer: rt, request_id: "turn-single", attributes: { total_ms: 50 } }),

            // Standalone route event without a request span still counts in executionRoutes totals.
            at(900, "execution_route.selected", {
                producer: rt,
                attributes: { execution_mode: "agent", band: "standard", auto_selected: false },
            }),
        ];

        const m = deriveMetrics(events);
        expect(m.executionRoutes.total).toBe(4);
        expect(m.executionRoutes.byMode).toEqual({ single: 1, ensemble: 1, fanout: 1, agent: 1 });
        expect(m.executionRoutes.byBand).toEqual({ quick: 1, standard: 1, hard: 1, multi_scope: 1 });
        expect(m.executionRoutes.autoCount).toBe(2);
        expect(m.executionRoutes.manualCount).toBe(2);

        expect(m.executionRoutes.latencyByMode.ensemble).toEqual({ count: 1, p50Ms: 200, p95Ms: 200, maxMs: 200 });
        expect(m.executionRoutes.latencyByMode.fanout).toEqual({ count: 1, p50Ms: 400, p95Ms: 400, maxMs: 400 });
        expect(m.executionRoutes.latencyByMode.single).toEqual({ count: 1, p50Ms: 50, p95Ms: 50, maxMs: 50 });
        expect(m.executionRoutes.latencyByMode.agent).toBeUndefined();

        expect(m.executionRoutes.latencyByBand.hard).toEqual({ count: 1, p50Ms: 200, p95Ms: 200, maxMs: 200 });
        expect(m.executionRoutes.latencyByBand.multi_scope).toEqual({ count: 1, p50Ms: 400, p95Ms: 400, maxMs: 400 });
        expect(m.executionRoutes.latencyByBand.quick).toEqual({ count: 1, p50Ms: 50, p95Ms: 50, maxMs: 50 });

        expect(m.requests[0]!.executionRoute).toMatchObject({
            mode: "ensemble",
            band: "hard",
            difficultyScore: 0.78,
            recommendedTiers: ["code", "reasoning"],
            ensembleMode: "code",
            autoSelected: true,
        });
        expect(m.requests[1]!.executionRoute).toMatchObject({
            mode: "fanout",
            band: "multi_scope",
            fanoutScope: "local",
            participantCount: 3,
        });

        // Exact prefix parity between deriveMetrics and MetricsIndex in forward and reverse order.
        const index = new MetricsIndex(events);
        for (const c of [...Array(events.length + 1).keys()].reverse()) {
            expect(index.at(c)).toEqual(deriveMetrics(events.slice(0, c)));
        }
        for (let c = 0; c <= events.length; c += 1) {
            expect(index.at(c)).toEqual(deriveMetrics(events.slice(0, c)));
        }
    });
});

describe("metrics fanout.* and ensemble.* orchestration spans", () => {
    it("tracks parent spans, sub-worker/candidate counts, sequential runs, and outcome-only fallbacks without closing on worker events", () => {
        const events: ObservatoryEvent[] = [
            // Fanout run 1 with 2 workers (1 fails, 1 completes) -> overall fanout completes.
            at(10, "fanout.started", {
                producer: rt,
                request_id: "turn-f1",
                run_id: "run-shared",
                attributes: { fanout_run_id: "fan-1", fanout_scope: "local", worker_count: 2, tiers: ["code", "reasoning"] },
            }),
            at(20, "fanout.worker.started", { producer: rt, request_id: "turn-f1", attributes: { fanout_run_id: "fan-1", worker_id: "w1" } }),
            at(25, "fanout.worker.started", { producer: rt, request_id: "turn-f1", attributes: { fanout_run_id: "fan-1", worker_id: "w2" } }),
            at(80, "fanout.worker.failed", { producer: rt, request_id: "turn-f1", attributes: { fanout_run_id: "fan-1", worker_id: "w1" } }),
            at(120, "fanout.worker.completed", { producer: rt, request_id: "turn-f1", attributes: { fanout_run_id: "fan-1", worker_id: "w2" } }),
            at(150, "fanout.synthesis.completed", { producer: rt, request_id: "turn-f1", attributes: { fanout_run_id: "fan-1" } }),
            at(210, "fanout.completed", { producer: rt, request_id: "turn-f1", attributes: { fanout_run_id: "fan-1" } }),
            // Late straggler after completion is ignored (does not fabricate a second span).
            at(215, "fanout.cancelled", { producer: rt, request_id: "turn-f1", attributes: { fanout_run_id: "fan-1" } }),

            // Sequential ensemble runs sharing the same default run_id do not clobber each other.
            at(300, "ensemble.started", {
                producer: rt,
                run_id: "run-shared",
                attributes: { ensemble: { mode: "code", tiers: ["code", "reasoning"], count: 2 } },
            }),
            at(310, "ensemble.candidate.started", { producer: rt, run_id: "run-shared" }),
            at(312, "ensemble.candidate.started", { producer: rt, run_id: "run-shared" }),
            at(390, "ensemble.candidate.completed", { producer: rt, run_id: "run-shared" }),
            at(400, "ensemble.candidate.completed", { producer: rt, run_id: "run-shared" }),
            at(450, "ensemble.completed", { producer: rt, run_id: "run-shared" }),

            at(500, "ensemble.started", {
                producer: rt,
                run_id: "run-shared",
                attributes: { ensemble_mode: "prose", candidate_count: 2 },
            }),
            at(560, "ensemble.failed", { producer: rt, run_id: "run-shared" }),

            // Orphan fanout.completed with reported total_ms recovers duration; without duration leaves latency null.
            at(700, "fanout.completed", {
                producer: rt,
                request_id: "orphan-with-dur",
                attributes: { total_ms: 85, fanout_scope: "fleet" },
            }),
            at(800, "fanout.cancelled", {
                producer: rt,
                request_id: "orphan-no-dur",
            }),
        ];

        const m = deriveMetrics(events);
        expect(m.orchestration.spans).toHaveLength(5);

        const fan1 = m.orchestration.spans[0]!;
        expect(fan1).toMatchObject({
            kind: "fanout",
            spanId: "fan-1",
            outcome: "completed",
            durationMs: 200,
            participantCount: 2,
            participantsStarted: 2,
            participantsCompleted: 1,
            participantsFailed: 1,
            participantsCancelled: 0,
            scopeOrMode: "local",
            tiers: ["code", "reasoning"],
            eventCount: 7,
        });

        expect(m.orchestration.fanout).toEqual({
            total: 3,
            open: 0,
            completed: 2,
            failed: 0,
            cancelled: 1,
            // Only fan-1 (200ms) and orphan-with-dur (85ms) have real durations; orphan-no-dur does not inject 0ms.
            latency: { count: 2, p50Ms: 85, p95Ms: 200, maxMs: 200 },
        });
        expect(m.orchestration.ensemble).toEqual({
            total: 2,
            open: 0,
            completed: 1,
            failed: 1,
            cancelled: 0,
            latency: { count: 2, p50Ms: 60, p95Ms: 150, maxMs: 150 },
        });

        // MetricsIndex parity at every prefix.
        const index = new MetricsIndex(events);
        for (const c of [...Array(events.length + 1).keys()].reverse()) {
            expect(index.at(c)).toEqual(deriveMetrics(events.slice(0, c)));
        }
    });
});

describe("graceful /v1/embeddings span accounting", () => {
    it("identifies embedding request events cleanly", () => {
        expect(isEmbeddingRequestEvent(at(1, "request.queued", { attributes: { kind: "embed" } }))).toBe(true);
        expect(isEmbeddingRequestEvent(at(1, "request.completed", { attributes: { operation: "embeddings" } }))).toBe(true);
        expect(isEmbeddingRequestEvent(at(1, "request.completed", { attributes: { endpoint: "/v1/embeddings" } }))).toBe(true);
        expect(isEmbeddingRequestEvent(at(1, "request.completed", { attributes: { kind: "chat" } }))).toBe(false);
        expect(isEmbeddingRequestEvent(at(1, "request.completed", { attributes: {} }))).toBe(false);
    });

    it("tracks older Session::embed (queued -> completed without request.started), upgrades when request.started is present, and handles outcome-only fallbacks", () => {
        const events = orderEvents([
            // 1. Older Sonder-Inference Session::embed: request.queued -> request.completed (no request.started).
            at(10, "request.queued", {
                producer: inf,
                request_id: "emb-old-ok",
                model_instance_id: "nomic-embed-text",
                attributes: { kind: "embed", inputs: 4 },
            }),
            at(45, "request.completed", {
                producer: inf,
                request_id: "emb-old-ok",
                attributes: { kind: "embed", outcome: "completed", prompt_tokens: 128, inputs: 4, total_ms: 35 },
            }),

            // 2. Older Session::embed failure (queued -> failed without request.started).
            at(60, "request.queued", {
                producer: inf,
                request_id: "emb-old-fail",
                attributes: { kind: "embed", inputs: 1 },
            }),
            at(72, "request.failed", {
                producer: inf,
                request_id: "emb-old-fail",
                attributes: { kind: "embed", error_code: "timeout", total_ms: 12 },
            }),

            // 3. Newer Session::embed: request.queued -> request.started -> request.completed.
            // Must upgrade startNs to request.started (105ms -> 125ms = 20ms, not queued 100ms).
            at(100, "request.queued", {
                producer: inf,
                request_id: "emb-new",
                model_instance_id: "nomic-embed-text",
                attributes: { kind: "embed", inputs: 2, model: "nomic-embed-v1.5" },
            }),
            at(105, "request.started", {
                producer: inf,
                request_id: "emb-new",
                attributes: { kind: "embed" },
            }),
            at(125, "request.completed", {
                producer: inf,
                request_id: "emb-new",
                attributes: { kind: "embed", outcome: "completed", total_ms: 20 },
            }),

            // 4. Truncated stream: only request.completed with total_ms (no queued, no started).
            at(200, "request.completed", {
                producer: inf,
                request_id: "emb-orphan-dur",
                attributes: { endpoint: "/v1/embeddings", total_ms: 40 },
            }),

            // 5. Truncated stream: outcome-only embed failure with NO total_ms -> span recorded, excluded from latency (no fake 0ms).
            at(250, "request.cancelled", {
                producer: inf,
                request_id: "emb-orphan-nodur",
                attributes: { kind: "embed" },
            }),

            // 6. Non-embed ghost completion is STILL ignored (preserves existing contract).
            at(300, "request.completed", {
                producer: inf,
                request_id: "ghost-chat",
                attributes: {},
            }),
        ]).events;

        const m = deriveMetrics(events);
        expect(m.requests.map((r) => [r.requestId, r.outcome, r.requestKind, r.startSource])).toEqual([
            ["emb-old-ok", "completed", "embed", "queued"],
            ["emb-old-fail", "failed", "embed", "queued"],
            ["emb-new", "completed", "embed", "started"],
            ["emb-orphan-dur", "completed", "embed", "reported-duration"],
            ["emb-orphan-nodur", "cancelled", "embed", "outcome-only"],
        ]);

        // Inherited attr model from queued embed survives upgrade to request.started.
        expect(m.requests[2]!.model).toBe("nomic-embed-v1.5");
        expect(m.requests[2]!.startNs).toBe(105 * 1e6);
        expect(m.requests[2]!.endNs).toBe(125 * 1e6);

        // Latency includes the 4 measurable spans (35ms, 12ms, 20ms, 40ms) and excludes outcome-only (no fake 0ms).
        expect(m.requestLatency).toEqual({ count: 4, p50Ms: 20, p95Ms: 40, maxMs: 40 });
        expect(m.requestLatencyByProducer["sonder-inference"]).toEqual({ count: 4, p50Ms: 20, p95Ms: 40, maxMs: 40 });
        expect(m.errors.total).toBe(1);

        // Exact prefix parity between deriveMetrics and metricsAt across every cursor position.
        for (let c = events.length; c >= 0; c -= 1) {
            expect(metricsAt(events, c)).toEqual(deriveMetrics(events.slice(0, c)));
        }
        for (let c = 0; c <= events.length; c += 1) {
            expect(metricsAt(events, c)).toEqual(deriveMetrics(events.slice(0, c)));
        }
    });
});
