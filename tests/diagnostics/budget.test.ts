import { describe, expect, it } from "vitest";
import { syntheticStream } from "../../src/diagnostics/fixtures";
import { assertEvidence, detect, getCase } from "./helpers";

describe("budget-pressure detector", () => {
    it("reports one derived episode and one producer guard", () => {
        const c = getCase("budget-pressure", "positive");
        const f = detect("budget-pressure", c.events);
        assertEvidence(f, c.events);
        const derived = f.filter((x) => x.provenance === "derived");
        const guard = f.filter((x) => x.provenance === "producer-reported");
        expect(derived).toHaveLength(1);
        expect(derived[0]!.evidenceEventIds).toHaveLength(3);
        expect(derived[0]!.severity).toBe("critical");
        expect(derived[0]!.facts.peak_used_tokens).toBe(7900);
        expect(guard).toHaveLength(1);
        expect(guard[0]!.severity).toBe("critical");
    });

    it("splits episodes when usage drops below the threshold and keeps scopes apart", () => {
        const e = syntheticStream("budget_split");
        const events = [
            e(0, "context.appended", { context_id: "a", used_tokens: 90, limit_tokens: 100 }),
            e(1, "context.appended", { context_id: "b", used_tokens: 85, limit_tokens: 100 }),
            e(2, "context.appended", { context_id: "a", used_tokens: 10, limit_tokens: 100 }),
            e(3, "context.appended", { context_id: "a", used_tokens: 81, limit_tokens: 100 }),
        ];
        const f = detect("budget-pressure", events);
        expect(f).toHaveLength(3);
        expect(f.every((x) => x.severity === "warning")).toBe(true);
    });

    it("honours configurable thresholds", () => {
        const c = getCase("budget-pressure", "negative");
        expect(detect("budget-pressure", c.events)).toEqual([]);
        const f = detect("budget-pressure", c.events, { budget: { warnFraction: 0.6 } });
        expect(f).toHaveLength(1);
    });

    it("guard without a fraction is a warning and guard below warn is info", () => {
        const e = syntheticStream("budget_guard");
        const f = detect("budget-pressure", [e(0, "guard.budget_pressure", {}), e(1, "guard.budget_pressure", { budget: "tokens", used_fraction: 0.5 })]);
        expect(f.map((x) => x.severity)).toEqual(["warning", "info"]);
    });

    it("negative case: no findings", () => {
        expect(detect("budget-pressure", getCase("budget-pressure", "negative").events)).toEqual([]);
    });
});
