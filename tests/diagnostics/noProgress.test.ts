import { describe, expect, it } from "vitest";
import { callSignature } from "../../src/diagnostics/detectors/noProgress";
import { syntheticStream } from "../../src/diagnostics/fixtures";
import { assertEvidence, detect, getCase } from "./helpers";

describe("no-progress-loop detector", () => {
    it("flags repeated identical calls and identical outputs, citing calls and completions", () => {
        const c = getCase("no-progress-loop", "positive");
        const f = detect("no-progress-loop", c.events);
        assertEvidence(f, c.events);
        const calls = f.find((x) => x.id.includes(":calls:"))!;
        expect(calls.facts).toMatchObject({ tool: "fs.read", repeats: 4, actor: "agent:agt_w" });
        expect(calls.evidenceEventIds).toHaveLength(8);
        expect(f.find((x) => x.id.includes(":outputs:"))).toBeDefined();
    });

    it("an intervening different call breaks the run", () => {
        const e = syntheticStream("loop_break");
        const a = { tool: "t", args_hash: "h1" };
        const events = [
            e(0, "tool.called", a, { agent_id: "x" }),
            e(1, "tool.called", a, { agent_id: "x" }),
            e(2, "tool.called", { tool: "t", args_hash: "h2" }, { agent_id: "x" }),
            e(3, "tool.called", a, { agent_id: "x" }),
        ];
        expect(detect("no-progress-loop", events)).toEqual([]);
        expect(detect("no-progress-loop", events.slice(0, 2), { noProgress: { repeatCount: 2 } })).toHaveLength(1);
    });

    it("different agents are not combined", () => {
        const e = syntheticStream("loop_agents");
        const a = { tool: "t", args_hash: "h" };
        const events = ["a", "b", "c"].map((agent, i) => e(i, "tool.called", a, { agent_id: agent }));
        expect(detect("no-progress-loop", events)).toEqual([]);
    });

    it("critical at twice the repeat count", () => {
        const e = syntheticStream("loop_crit");
        const events = Array.from({ length: 6 }, (_, i) => e(i, "tool.called", { tool: "t", args: "ls -la" }, { agent_id: "a" }));
        expect(detect("no-progress-loop", events)[0]!.severity).toBe("critical");
    });

    it("restates guard.no_progress", () => {
        const e = syntheticStream("loop_guard");
        const f = detect("no-progress-loop", [e(0, "guard.no_progress", {}, { agent_id: "a" })]);
        expect(f[0]!.provenance).toBe("producer-reported");
    });

    it("redacted or missing args have no signature", () => {
        const e = syntheticStream("loop_sig");
        expect(callSignature(e(0, "tool.called", { tool: "t", args: "[redacted]" }))).toBeNull();
        expect(callSignature(e(0, "tool.called", { tool: "t" }))).toBeNull();
        expect(callSignature(e(0, "tool.called", { tool: "t", content_hash: "sha256:x" }))).toBe("t|sha256:x");
    });

    it("negative case: no findings", () => {
        expect(detect("no-progress-loop", getCase("no-progress-loop", "negative").events)).toEqual([]);
    });
});
