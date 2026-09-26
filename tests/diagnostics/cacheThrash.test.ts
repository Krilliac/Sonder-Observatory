import { describe, expect, it } from "vitest";
import { syntheticStream } from "../../src/diagnostics/fixtures";
import type { ObservatoryEvent } from "../../src/protocol/events";
import { assertEvidence, detect, getCase } from "./helpers";

describe("cache-thrash detector", () => {
    it("reports a hit-rate collapse and eviction churn", () => {
        const c = getCase("cache-thrash", "positive");
        const f = detect("cache-thrash", c.events);
        assertEvidence(f, c.events);
        const collapse = f.find((x) => x.id.includes(":hitrate:"))!;
        expect(collapse.facts.hit_rate).toBeCloseTo(0.1);
        expect(collapse.facts.baseline_hit_rate).toBeCloseTo(0.9);
        expect(collapse.evidenceEventIds).toHaveLength(20);
        const churn = f.find((x) => x.id.includes(":evictions:"))!;
        expect(churn.facts.evictions).toBe(20);
    });

    it("no collapse when the baseline itself is poor", () => {
        const e = syntheticStream("cache_poor");
        const events: ObservatoryEvent[] = [];
        for (let w = 0; w < 2; w++) {
            for (let i = 0; i < 10; i++) {
                events.push(e(w * 5000 + i * 100, (w === 0 ? i < 3 : i < 1) ? "kv.reused" : "kv.allocated", {}));
            }
        }
        expect(detect("cache-thrash", events)).toEqual([]);
        expect(detect("cache-thrash", events, { cacheThrash: { baselineHitRate: 0.25 } })).toHaveLength(1);
    });

    it("scopes are judged independently", () => {
        const e = syntheticStream("cache_scope");
        const events: ObservatoryEvent[] = [];
        for (let i = 0; i < 10; i++) {
            events.push(e(i * 100, "kv.reused", {}, { model_instance_id: "m1" }));
            events.push(e(5000 + i * 100, "kv.allocated", {}, { model_instance_id: "m2" }));
        }
        expect(detect("cache-thrash", events)).toEqual([]);
    });

    it("negative case: no findings", () => {
        expect(detect("cache-thrash", getCase("cache-thrash", "negative").events)).toEqual([]);
    });
});
