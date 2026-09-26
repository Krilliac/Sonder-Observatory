import { describe, expect, it } from "vitest";
import { syntheticStream } from "../../src/diagnostics/fixtures";
import { assertEvidence, detect, getCase } from "./helpers";

describe("compaction detector", () => {
    it("reports each compaction, the churn, and the dangling start", () => {
        const c = getCase("compaction", "positive");
        const f = detect("compaction", c.events);
        assertEvidence(f, c.events);
        const info = f.filter((x) => x.severity === "info");
        expect(info).toHaveLength(3);
        expect(info[0]!.facts).toMatchObject({ tokens_before: 7800, tokens_after: 2100, duration_ms: 120 });
        expect(f.filter((x) => x.id.startsWith("compaction:churn:"))).toHaveLength(1);
        expect(f.some((x) => x.summary.includes("no completion observed"))).toBe(true);
    });

    it("no churn when compactions are spread beyond the window", () => {
        const c = getCase("compaction", "positive");
        const f = detect("compaction", c.events, { compaction: { windowMs: 5_000 } });
        expect(f.some((x) => x.id.startsWith("compaction:churn:"))).toBe(false);
    });

    it("failed compaction is a warning citing start and failure", () => {
        const e = syntheticStream("compact_fail");
        const events = [e(0, "context.compaction.started", { context_id: "c" }), e(10, "context.compaction.failed", { context_id: "c" })];
        const f = detect("compaction", events);
        expect(f).toHaveLength(1);
        expect(f[0]!.severity).toBe("warning");
        expect(f[0]!.evidenceEventIds).toEqual(events.map((x) => x.event_id));
    });

    it("negative case: no findings", () => {
        expect(detect("compaction", getCase("compaction", "negative").events)).toEqual([]);
    });
});
