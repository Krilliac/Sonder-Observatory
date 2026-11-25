import { describe, expect, it } from "vitest";
import type { ObservatoryEvent } from "../../src/protocol/events";
import { analyzeSession } from "../../src/compare/summary";
import { orderEvents } from "../../src/replay/order";
import { at } from "../helpers";

describe("analyzeSession fused single-pass correctness", () => {
    it("matches ordered vs unordered inputs identically across totals, run, request, and inferred/reported turn groups", () => {
        const events: ObservatoryEvent[] = [
            at(10, "session.started", { run_id: null, request_id: null, attributes: { cost_budget_usd: 2.0 } }),
            at(20, "request.started", { run_id: "run-a", request_id: "r2", attributes: { prompt_tokens: 100 } }),
            at(25, "kv.allocated", { run_id: "run-a", request_id: "r2" }),
            at(30, "guard.budget_pressure", { run_id: "run-a", request_id: "r2", attributes: { used_fraction: 0.4 } }),
            at(35, "guard.budget_pressure", { run_id: "run-a", request_id: "r2", attributes: { used_fraction: 0.75 } }),
            at(40, "retry.scheduled", { run_id: "run-a", request_id: "r2" }),
            at(50, "inference.token.generated", { run_id: "run-a", request_id: "r2", attributes: { unit: "token", count: 1 } }),
            at(60, "inference.token.generated", { run_id: "run-a", request_id: "r2", attributes: { unit: "token", count: 1 } }),
            at(70, "request.completed", {
                run_id: "run-a",
                request_id: "r2",
                attributes: { completion_tokens: 2, cost_usd: 0.25 },
            }),

            // Earlier request started out of sequence order in input, plus kv.reused hit and failed outcome.
            at(15, "request.started", { run_id: "run-b", request_id: "r1", attributes: { prompt_tokens: 50 } }),
            at(18, "kv.reused", { run_id: "run-b", request_id: "r1" }),
            at(45, "request.failed", {
                run_id: "run-b",
                request_id: "r1",
                attributes: { ttft_ms: 12, cost_usd: 0.15 },
            }),
        ];

        const ordered = orderEvents(events).events;
        const fromUnordered = analyzeSession(events);
        const fromOrdered = analyzeSession(ordered);
        expect(fromUnordered).toEqual(fromOrdered);

        expect(fromOrdered.groups.turn.keySource).toBe("inferred");
        expect(fromOrdered.groups.request.units.map((u) => u.key)).toEqual(["r1", "r2"]);
        expect(fromOrdered.groups.turn.units.map((u) => u.key)).toEqual(["#1", "#2"]);

        const r2Unit = fromOrdered.groups.request.units[1]!;
        expect(r2Unit.retries).toBe(1);
        expect(r2Unit.cacheHits).toBe(0);
        expect(r2Unit.cacheMisses).toBe(1);
        expect(r2Unit.cacheHitRate).toBe(0);
        expect(r2Unit.budgetPeakFraction).toBe(0.75);
        expect(r2Unit.errors).toBe(3); // 2 guard.budget_pressure + 1 retry.scheduled
        expect(r2Unit.costUsd).toBeCloseTo(0.25);

        expect(fromOrdered.totals.costUsd).toBeCloseTo(0.4);
        expect(fromOrdered.totals.costBudgetFraction).toBeCloseTo(0.2);
        expect(fromOrdered.totals.failedRequests).toBe(1);
        expect(fromOrdered.totals.cacheHitRate).toBeCloseTo(0.5);
    });

    it("includes older /v1/embeddings requests (without request.started) in compare request facts", () => {
        const events: ObservatoryEvent[] = [
            at(10, "request.queued", {
                run_id: "run-emb",
                request_id: "emb-1",
                attributes: { kind: "embed", inputs: 2, turn_id: "t1" },
            }),
            at(35, "request.completed", {
                run_id: "run-emb",
                request_id: "emb-1",
                attributes: { kind: "embed", prompt_tokens: 64, total_ms: 25, turn_id: "t1" },
            }),
        ];
        const a = analyzeSession(events);
        expect(a.requests).toHaveLength(1);
        expect(a.requests[0]).toMatchObject({
            requestId: "emb-1",
            runId: "run-emb",
            turn: "t1",
            outcome: "completed",
            promptTokens: 64,
        });
        expect(a.groups.request.units).toHaveLength(1);
        expect(a.groups.request.units[0]!.events).toBe(2);
    });
});
