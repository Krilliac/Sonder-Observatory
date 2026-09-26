import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { regressFixtureText } from "../../scripts/generate-fixture-regressed.mjs";
import { CompareController } from "../../src/compare/controller";
import { compareSessions } from "../../src/compare/compare";
import { metricDelta, METRICS } from "../../src/compare/delta";
import { formatDelta } from "../../src/compare/present";
import { parseNdjson } from "../../src/recording/ndjson";

const baseText = readFileSync("fixtures/synthetic-session.ndjson", "utf8");
const regressedText = regressFixtureText(baseText);
const a = parseNdjson(baseText).events;
const b = parseNdjson(regressedText).events;
const byKey = (key: string) => METRICS.find((m) => m.key === key)!;

describe("regressed fixture variant", () => {
    it("is deterministic and parses cleanly", () => {
        expect(regressFixtureText(baseText)).toBe(regressedText);
        expect(parseNdjson(regressedText).rejected).toEqual([]);
        expect(b.every((e) => e.producer.synthetic === true)).toBe(true);
        expect(b.map((e) => e.sequence)).toEqual(b.map((_, i) => i));
    });
});

describe("compareSessions (base vs regressed)", () => {
    const c = compareSessions(a, b, "request");
    const total = (key: string) => c.totals.find((d) => d.key === key)!;

    it("reports latency, retry, budget and token deltas", () => {
        expect(total("ttftMs").verdict).toBe("worse");
        expect(total("decodeTokPerSec").verdict).toBe("worse");
        expect([total("retries").a, total("retries").b, total("retries").verdict]).toEqual([1, 3, "worse"]);
        expect(total("budgetPeakFraction").verdict).toBe("worse");
        expect(total("promptTokens").verdict).toBe("changed");
        expect(total("completionTokens").verdict).toBe("same");
        expect(total("costUsd").verdict).toBe("only-b");
        expect(total("cacheHitRate").b).toBeCloseTo(0.45);
    });

    it("aligns requests by id, runs and inferred turns by position", () => {
        expect(c.alignment.matchedBy).toBe("id");
        expect(c.rows).toHaveLength(10);
        const run = compareSessions(a, b, "run");
        expect(run.alignment.matchedBy).toBe("position");
        expect(run.rows).toHaveLength(1);
        const turn = compareSessions(a, b, "turn");
        expect(turn.alignment.inferred).toBe(true);
        expect(turn.rows).toHaveLength(10);
    });

    it("diffs findings (new vs resolved)", () => {
        expect(c.findings.added.map((f) => f.kind)).toContain("retry-storm");
        expect(c.findings.resolved).toEqual([]);
        expect(c.findings.persisting.some((p) => p.a.kind === "budget-pressure" && p.severityChange === null)).toBe(true);
    });

    it("diffs the call graph", () => {
        expect(c.graph.addedNodes.map((n) => n.id)).toEqual(["tool:synthetic.rerank", "tool:synthetic.search_v2"]);
        expect(c.graph.removedNodes.map((n) => n.id)).toEqual(["tool:synthetic.search"]);
        expect(c.graph.removedEdges.map((e) => e.id)).toEqual(["tool_call:agent:agt_worker_1->tool:synthetic.search"]);
    });

    it("comparing a session with itself shows no change", () => {
        const same = compareSessions(a, a);
        expect(same.totals.every((d) => d.verdict === "same" || d.verdict === "n/a")).toBe(true);
        expect(same.findings.added).toEqual([]);
        expect(same.graph.addedNodes).toEqual([]);
    });
});

describe("metricDelta / formatting", () => {
    it("applies polarity and tolerance", () => {
        expect(metricDelta(byKey("ttftMs"), 100, 90).verdict).toBe("better");
        expect(metricDelta(byKey("cacheHitRate"), 0.8, 0.4).verdict).toBe("worse");
        expect(metricDelta(byKey("ttftMs"), 1000, 1001).verdict).toBe("same");
        expect(metricDelta(byKey("costUsd"), null, null).verdict).toBe("n/a");
        expect(formatDelta(metricDelta(byKey("retries"), 1, 3))).toBe("+2 (+200.0%)");
        expect(formatDelta(metricDelta(byKey("cacheHitRate"), 0.5, 0.45))).toBe("−5.0 pp");
    });
});

describe("CompareController", () => {
    it("loads recordings, swaps, and throttles a growing current session", () => {
        let now = 0;
        const ctl = new CompareController({ now: () => now, liveThrottleMs: 1000 });
        const live = a.slice(0, 100);
        ctl.setCurrent(live);
        expect(ctl.comparison()).toBeNull();
        expect(ctl.loadRecordingText("a", regressedText, "reg.ndjson").ok).toBe(true);
        expect(ctl.comparison()).not.toBeNull();
        ctl.swap();
        expect(ctl.side("a").kind).toBe("current");
        expect(ctl.side("b").label).toBe("reg.ndjson");
        const first = ctl.analysis("a");
        live.push(...a.slice(100));
        expect(ctl.analysis("a")).toBe(first);
        expect(ctl.pendingRefreshMs()).toBe(1000);
        now = 1000;
        expect(ctl.analysis("a")).not.toBe(first);
        expect(ctl.loadRecordingText("b", "garbage\n", "bad.ndjson").ok).toBe(false);
        expect(ctl.side("b").error).toContain("bad.ndjson");
    });
});
