import { describe, expect, it } from "vitest";
import { syntheticStream } from "../../src/diagnostics/fixtures";
import { assertEvidence, detect, getCase } from "./helpers";

describe("retry-storm detector", () => {
    it("reports one burst of four retries", () => {
        const c = getCase("retry-storm", "positive");
        const f = detect("retry-storm", c.events);
        assertEvidence(f, c.events);
        expect(f).toHaveLength(1);
        expect(f[0]!.facts).toMatchObject({ retries: 4, targets: "tc_x" });
        expect(f[0]!.severity).toBe("warning");
    });

    it("critical at twice the count; configurable window", () => {
        const e = syntheticStream("retry_crit");
        const events = Array.from({ length: 6 }, (_, i) => e(i * 100, "retry.scheduled", {}));
        expect(detect("retry-storm", events)[0]!.severity).toBe("critical");
        const spread = getCase("retry-storm", "negative").events;
        expect(detect("retry-storm", spread, { retryStorm: { windowMs: 30_000 } })).toHaveLength(1);
    });

    it("separate bursts produce separate findings", () => {
        const e = syntheticStream("retry_two");
        const events = [0, 100, 200, 60_000, 60_100, 60_200].map((t) => e(t, "retry.scheduled", {}));
        expect(detect("retry-storm", events)).toHaveLength(2);
    });

    it("negative case: no findings", () => {
        expect(detect("retry-storm", getCase("retry-storm", "negative").events)).toEqual([]);
    });
});
