import { describe, expect, it } from "vitest";
import { deriveExecutionRoutes } from "../../src/query/executionRoute";
import {
    executionRouteBadgeModel,
    renderRouteCards,
    routeCardModel,
    stripRouteSummary,
} from "../../src/renderer/routeBadges";
import { at } from "../helpers";

class FakeNode {
    readonly attrs: Record<string, string> = {};
    textContent = "";
    readonly children: (FakeNode | string)[] = [];
    constructor(readonly tag: string) {}
    set className(v: string) {
        this.attrs.class = v;
    }
    setAttribute(k: string, v: string): void {
        this.attrs[k] = v;
    }
    append(...kids: (FakeNode | string)[]): void {
        this.children.push(...kids);
    }
}

function withFakeDocument<T>(fn: () => T): T {
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: { createElement: (tag: string) => new FakeNode(tag) },
    });
    try {
        return fn();
    } finally {
        if (original) Object.defineProperty(globalThis, "document", original);
        else Reflect.deleteProperty(globalThis, "document");
    }
}

const rt = { name: "sonder-runtime", version: "0.9.0", node_id: "workstation", instance_id: "rt-1", role: "runtime" };

describe("execution_route / ensemble / fanout badges", () => {
    it("renders nothing when no execution_route or ensemble/fanout telemetry is emitted", () => {
        const empty = deriveExecutionRoutes([
            at(1, "route.selected", { producer: rt, request_id: "r1", attributes: { provider: "ollama", operation: "chat" } }),
        ]);
        expect(routeCardModel(empty)).toBeNull();
        expect(stripRouteSummary(empty)).toBeNull();
        expect(renderRouteCards(empty)).toEqual([]);
    });

    it("formats Auto · Hard · Ensemble and Fanout badges with score, tooltip, and mode totals", () => {
        const routes = deriveExecutionRoutes([
            at(10, "route.selected", {
                producer: rt,
                request_id: "t1",
                attributes: {
                    execution_route: {
                        mode: "ensemble",
                        band: "hard",
                        difficulty_score: 0.78,
                        recommended_tiers: ["code", "reasoning"],
                        auto_selected: true,
                        reason: "hard architecture prompt",
                        signals: ["architecture_tradeoff"],
                    },
                },
            }),
            at(20, "route.selected", {
                producer: rt,
                request_id: "t2",
                attributes: {
                    execution_route: {
                        mode: "fanout",
                        band: "multi_scope",
                        difficulty_score: 0.92,
                        fanout_scope: "local",
                        auto_selected: true,
                        reason: "multi-module audit",
                    },
                },
            }),
            at(30, "route.selected", {
                producer: rt,
                request_id: "t3",
                attributes: {
                    execution_route: {
                        mode: "single",
                        band: "quick",
                        difficulty_score: 0.12,
                        recommended_tiers: ["fast"],
                        auto_selected: true,
                    },
                },
            }),
        ]);

        const ensembleBadge = executionRouteBadgeModel(routes.records[0]!);
        expect(ensembleBadge.label).toBe("Auto · Hard · Ensemble (code+reasoning)");
        expect(ensembleBadge.scoreText).toBe("score 0.78");
        expect(ensembleBadge.tooltip).toContain("hard architecture prompt");
        expect(ensembleBadge.tooltip).toContain("architecture_tradeoff");

        const fanoutBadge = executionRouteBadgeModel(routes.records[1]!);
        expect(fanoutBadge.label).toBe("Auto · Multi-Scope · Fanout (local)");
        expect(fanoutBadge.scoreText).toBe("score 0.92");

        const singleBadge = executionRouteBadgeModel(routes.records[2]!);
        expect(singleBadge.label).toBe("Auto · Quick · Single (fast)");

        const card = routeCardModel(routes)!;
        expect(card.title).toBe("Execution routing");
        expect(card.value).toBe("Ensemble ×1 · Fanout ×1 · Single ×1");
        expect(card.sub).toBe("3 routed turns · 3 auto");
        expect(card.recent).toHaveLength(3);

        expect(stripRouteSummary(routes)).toBe("Auto · Quick · Single (fast) · 1 ensemble · 1 fanout");

        withFakeDocument(() => {
            const cards = renderRouteCards(routes) as unknown as FakeNode[];
            expect(cards).toHaveLength(1);
            expect(cards[0]!.attrs["data-testid"]).toBe("execution-route-card");
        });
    });

    it("labels synthetic execution-route telemetry as synthetic", () => {
        const routes = deriveExecutionRoutes([
            at(1, "ensemble.started", {
                producer: { ...rt, synthetic: true },
                request_id: "syn-1",
                attributes: { ensemble: { mode: "code", count: 2 } },
            }),
        ]);
        expect(routeCardModel(routes)?.synthetic).toBe(true);
    });
});
