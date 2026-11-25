import { describe, expect, it } from "vitest";
import type { ObservatoryEvent } from "../src/protocol/events";
import { deriveExecutionRoutes, parseExecutionRoute } from "../src/query/executionRoute";
import { executionRouteAt } from "../src/query/executionRouteIndex";
import { orderEvents } from "../src/replay/order";
import { SessionStore } from "../src/replay/session";
import { at } from "./helpers";

const rt = { name: "sonder-runtime", version: "0.9.0", node_id: "workstation", instance_id: "rt-aabbccddeeff", role: "runtime" };

describe("deriveExecutionRoutes", () => {
    it("parses PR #881 execution_route payloads, flattened execution_mode, and ensemble/fanout events", () => {
        const events: ObservatoryEvent[] = [
            at(10, "route.selected", {
                producer: rt,
                request_id: "turn-1",
                attributes: {
                    provider: "sonder_inference",
                    operation: "chat",
                    execution_route: {
                        mode: "ensemble",
                        band: "hard",
                        difficulty_score: 0.74,
                        recommended_tiers: ["code", "reasoning"],
                        ensemble_mode: "code",
                        fanout_scope: "local",
                        reason: "hard reasoning prompt auto-routed to parallel multi-model ensemble",
                        signals: ["architecture_tradeoff", "concurrency_memory_systems"],
                        auto_selected: true,
                    },
                },
            }),
            // Duplicate report on request.completed merges cleanly into the same turn (no double count).
            at(20, "request.completed", {
                producer: rt,
                request_id: "turn-1",
                attributes: {
                    execution_route: {
                        mode: "ensemble",
                        band: "hard",
                        difficulty_score: 0.74,
                        recommended_tiers: ["code", "reasoning"],
                        auto_selected: true,
                    },
                },
            }),
            // Fanout via flattened attributes
            at(30, "route.selected", {
                producer: rt,
                request_id: "turn-2",
                attributes: {
                    execution_mode: "fanout",
                    difficulty_band: "multi_scope",
                    difficulty_score: 0.91,
                    fanout_scope: "local",
                    recommended_tiers: ["code", "reasoning"],
                    auto_selected: true,
                    worker_count: 3,
                    route_reason: "multi-scope audit prompt auto-routed to bounded local fanout",
                },
            }),
            // Quick single tier
            at(40, "route.selected", {
                producer: rt,
                request_id: "turn-3",
                attributes: {
                    execution_route: {
                        mode: "single",
                        band: "quick",
                        difficulty_score: 0.12,
                        recommended_tiers: ["fast"],
                        auto_selected: true,
                        reason: "quick low-complexity prompt routed to fast single tier",
                    },
                },
            }),
            // Manual agent override
            at(50, "route.selected", {
                producer: rt,
                request_id: "turn-4",
                attributes: {
                    execution_mode: "agent",
                    band: "multi-scope",
                    auto_selected: false,
                    reason: "explicit agent execution mode requested",
                },
            }),
            // Dedicated ensemble.started without request_id
            at(60, "ensemble.started", {
                producer: rt,
                attributes: {
                    ensemble: { mode: "prose", tiers: ["code", "reasoning"], count: 2 },
                },
            }),
        ];

        const m = deriveExecutionRoutes(events);
        expect(m.total).toBe(5);
        expect(m.byMode).toEqual({ single: 1, ensemble: 2, fanout: 1, agent: 1 });
        expect(m.byBand).toEqual({ quick: 1, standard: 0, hard: 1, multi_scope: 2 });
        expect(m.autoCount).toBe(3);
        expect(m.manualCount).toBe(1);
        expect(m.records[0]).toMatchObject({
            requestId: "turn-1",
            mode: "ensemble",
            band: "hard",
            difficultyScore: 0.74,
            recommendedTiers: ["code", "reasoning"],
            signals: ["architecture_tradeoff", "concurrency_memory_systems"],
            autoSelected: true,
        });
        expect(m.records[1]).toMatchObject({
            requestId: "turn-2",
            mode: "fanout",
            band: "multi_scope",
            fanoutScope: "local",
            participantCount: 3,
        });
        expect(m.latest?.mode).toBe("ensemble");
        expect(m.latest?.participantCount).toBe(2);
    });

    it("ignores legacy route.selected and malformed execution_route fields without inventing records", () => {
        const legacy = [
            at(1, "route.selected", { producer: rt, request_id: "r1", attributes: { provider: "ollama", operation: "chat", model: "qwen3:14b", reason: "default-route" } }),
            at(2, "route.changed", { producer: rt, request_id: "r1", attributes: { from_provider: "sonder_inference", to_provider: "ollama", reason_code: "primary_unreachable" } }),
            at(3, "route.selected", { producer: rt, request_id: "r2", attributes: { execution_route: { mode: "unknown-mode", difficulty_score: 99 } } }),
            at(4, "route.selected", { producer: rt, request_id: "r3", attributes: { execution_route: "not-an-object" } }),
        ];
        expect(deriveExecutionRoutes(legacy)).toEqual({
            total: 0,
            byMode: { single: 0, ensemble: 0, fanout: 0, agent: 0 },
            byBand: { quick: 0, standard: 0, hard: 0, multi_scope: 0 },
            autoCount: 0,
            manualCount: 0,
            synthetic: false,
            latest: null,
            records: [],
        });

        // Out-of-range difficulty score is dropped to null rather than clamped or fabricated.
        const parsed = parseExecutionRoute(
            at(5, "route.selected", {
                producer: rt,
                request_id: "r4",
                attributes: { execution_route: { mode: "ensemble", difficulty_score: 1.5, recommended_tiers: ["code", 42, ""] } },
            }),
        )!;
        expect(parsed.difficultyScore).toBeNull();
        expect(parsed.recommendedTiers).toEqual(["code"]);
    });

    it("isolates equal request_ids across different producer instances and keeps sparse index exact", () => {
        const rt2 = { ...rt, node_id: "NODE1", instance_id: "rt-112233445566" };
        const events = orderEvents([
            at(10, "route.selected", { producer: rt, request_id: "same-id", attributes: { execution_mode: "ensemble", auto_selected: true } }),
            at(15, "inference.token.generated", { producer: rt, request_id: "same-id" }),
            at(20, "route.selected", { producer: rt2, request_id: "same-id", attributes: { execution_mode: "fanout", auto_selected: true } }),
        ]).events;

        expect(deriveExecutionRoutes(events).total).toBe(2);
        for (const c of [0, 1, 2, 3, 1, 0, 3]) {
            expect(executionRouteAt(events, c)).toEqual(deriveExecutionRoutes(events.slice(0, c)));
        }

        const store = new SessionStore({ maxLiveEvents: 2 });
        store.reset("live", "routes");
        store.append(events.slice(0, 1));
        const before = executionRouteAt(store.events);
        store.append([events[1]!]);
        expect(executionRouteAt(store.events)).toBe(before);
        store.append([events[2]!]);
        expect(executionRouteAt(store.events)).toEqual(deriveExecutionRoutes(store.events));
    });
});
