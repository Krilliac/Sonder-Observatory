import { describe, expect, it } from "vitest";
import { isFailureEvent } from "../../src/diagnostics/detectors/errorBurst";
import { syntheticStream } from "../../src/diagnostics/fixtures";
import { assertEvidence, detect, getCase } from "./helpers";

describe("error-burst detector", () => {
    it("reports a burst with a per-type breakdown", () => {
        const c = getCase("error-burst", "positive");
        const f = detect("error-burst", c.events);
        assertEvidence(f, c.events);
        expect(f).toHaveLength(1);
        expect(f[0]!.facts).toMatchObject({ failures: 4, breakdown: "2x tool.failed, 1x backend.error, 1x request.failed" });
    });

    it("configurable window turns isolated failures into a burst", () => {
        const c = getCase("error-burst", "negative");
        expect(detect("error-burst", c.events, { errorBurst: { windowMs: 30_000 } })).toHaveLength(1);
    });

    it("classifies failures narrowly", () => {
        const e = syntheticStream("err_cls");
        expect(isFailureEvent(e(0, "tool.failed"))).toBe(true);
        expect(isFailureEvent(e(0, "backend.error"))).toBe(true);
        expect(isFailureEvent(e(0, "retry.scheduled"))).toBe(false);
        expect(isFailureEvent(e(0, "request.cancelled"))).toBe(false);
    });

    it("negative case: no findings", () => {
        expect(detect("error-burst", getCase("error-burst", "negative").events)).toEqual([]);
    });
});
