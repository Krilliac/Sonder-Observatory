import { describe, expect, it } from "vitest";
import { assertEvidence, detect, getCase } from "./helpers";

describe("model-churn detector", () => {
    it("reports load/unload churn without counting load.started", () => {
        const c = getCase("model-churn", "positive");
        const f = detect("model-churn", c.events);
        assertEvidence(f, c.events);
        expect(f).toHaveLength(1);
        expect(f[0]!.facts).toMatchObject({ loads: 3, unloads: 3, models: "mdl_a, mdl_b" });
        expect(f[0]!.severity).toBe("warning");
        expect(f[0]!.evidenceEventIds).toHaveLength(6);
    });

    it("threshold is configurable", () => {
        const c = getCase("model-churn", "positive");
        expect(detect("model-churn", c.events, { modelChurn: { count: 3 } })[0]!.severity).toBe("critical");
        expect(detect("model-churn", c.events, { modelChurn: { windowMs: 5_000 } })).toEqual([]);
    });

    it("negative case: no findings", () => {
        expect(detect("model-churn", getCase("model-churn", "negative").events)).toEqual([]);
    });
});
