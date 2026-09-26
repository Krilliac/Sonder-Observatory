import { describe, expect, it } from "vitest";
import { syntheticStream } from "../../src/diagnostics/fixtures";
import { assertEvidence, detect, getCase } from "./helpers";

describe("duplicate-worker detector", () => {
    it("reports concurrent agents with the same task hash", () => {
        const c = getCase("duplicate-worker", "positive");
        const f = detect("duplicate-worker", c.events);
        assertEvidence(f, c.events);
        expect(f).toHaveLength(1);
        expect(f[0]!.severity).toBe("warning");
        expect(f[0]!.facts).toMatchObject({ task: "sha256:task1", agents: 2 });
    });

    it("critical with three concurrent agents; envelope task_id is a fallback identity", () => {
        const e = syntheticStream("dup_three");
        const events = ["a", "b", "c"].map((id, i) => e(i, "agent.spawned", {}, { agent_id: id, task_id: "task_9" }));
        const f = detect("duplicate-worker", events);
        expect(f).toHaveLength(1);
        expect(f[0]!.severity).toBe("critical");
        expect(f[0]!.evidenceEventIds).toHaveLength(3);
    });

    it("task key attributes are configurable", () => {
        const e = syntheticStream("dup_cfg");
        const events = [e(0, "agent.spawned", { goal: "g" }, { agent_id: "a" }), e(1, "agent.spawned", { goal: "g" }, { agent_id: "b" })];
        expect(detect("duplicate-worker", events)).toEqual([]);
        expect(detect("duplicate-worker", events, { duplicateWorker: { taskKeys: ["goal"] } })).toHaveLength(1);
    });

    it("restates guard.duplicate_work", () => {
        const e = syntheticStream("dup_guard");
        expect(detect("duplicate-worker", [e(0, "guard.duplicate_work", {})])[0]!.provenance).toBe("producer-reported");
    });

    it("negative case: no findings", () => {
        expect(detect("duplicate-worker", getCase("duplicate-worker", "negative").events)).toEqual([]);
    });
});
