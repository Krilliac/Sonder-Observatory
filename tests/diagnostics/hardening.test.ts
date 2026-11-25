/**
 * Wave 3 non-resource diagnostics hardening tests:
 *  - Edge cases: empty streams, NaN/negative timestamps & durations, invalid configs
 *  - False positive/negative fixes across all 9 non-resource detectors
 *  - Wave 2 event types (embeddings, orchestration failures, non-resident model loads)
 *  - O(N) hot-path regression tests (findBurstsLinear, noProgress outcomes, latency rolling window)
 *  - FindingsController & panel defensive guards
 */
import { describe, expect, it } from "vitest";
import { FindingsController, type DiagnosticsSelectionHost } from "../../src/diagnostics/controller";
import { callSignature } from "../../src/diagnostics/detectors/noProgress";
import { findBurstsLinear, nonNegDurationMs, severityFor } from "../../src/diagnostics/detectors/shared";
import { syntheticStream } from "../../src/diagnostics/fixtures";
import type { Finding } from "../../src/diagnostics/types";
import { findBursts } from "../../src/diagnostics/util";
import type { ObservatoryEvent } from "../../src/protocol/events";
import { detect } from "./helpers";

describe("shared detector primitives", () => {
    it("findBurstsLinear matches findBursts and guards invalid thresholds / NaN timestamps", () => {
        const e = syntheticStream("shared_burst");
        const ev = [0, 100, 200, 5000, 9000, 9100, 9200, 9300].map((t) => e(t, "x"));
        expect(findBurstsLinear(ev, 3, 500)).toEqual(findBursts(ev, 3, 500));
        expect(findBurstsLinear(ev, 0, 500)).toEqual([]);
        expect(findBurstsLinear(ev, -2, 500)).toEqual([]);
        expect(findBurstsLinear(ev, Number.NaN, 500)).toEqual([]);
        expect(findBurstsLinear(ev, 3, -1)).toEqual([]);
        expect(findBurstsLinear(ev, 3, Number.NaN)).toEqual([]);

        const withNaN = [e(0, "x"), { ...e(50, "x"), mono_ns: Number.NaN }, e(100, "x"), e(200, "x")];
        expect(findBurstsLinear(withNaN, 3, 500)).toHaveLength(1);
        expect(findBurstsLinear(withNaN, 3, 500)[0]).toHaveLength(3);
    });

    it("findBurstsLinear runs in linear time on 50,000 clustered events", () => {
        const e = syntheticStream("shared_scale");
        const events = Array.from({ length: 50_000 }, (_, i) => e(i, "retry.scheduled"));
        const t0 = performance.now();
        const bursts = findBurstsLinear(events, 3, 60_000);
        const elapsedMs = performance.now() - t0;
        expect(bursts).toHaveLength(1);
        expect(bursts[0]).toHaveLength(50_000);
        expect(elapsedMs).toBeLessThan(500);
    });

    it("guards severityFor and nonNegDurationMs against NaN and negative skew", () => {
        expect(severityFor(Number.NaN, 0.8, 0.95)).toBeNull();
        expect(severityFor(Number.POSITIVE_INFINITY, 0.8, 0.95)).toBeNull();
        expect(nonNegDurationMs(2_000_000, 1_000_000)).toBeNull();
        expect(nonNegDurationMs(Number.NaN, 1_000_000)).toBeNull();
        expect(nonNegDurationMs(1_000_000, 1_000_000)).toBe(0);
    });
});

describe("budget-pressure hardening", () => {
    it("ignores negative token counts, handles negative guard fractions, and derives guard fraction from used/limit", () => {
        const e = syntheticStream("budget_hard");
        const events = [
            e(0, "context.appended", { context_id: "c", used_tokens: -50, limit_tokens: 100 }),
            e(10, "guard.budget_pressure", { budget: "context", used_fraction: -0.5 }),
            e(20, "guard.budget_pressure", { budget: "context", used_tokens: 960, limit_tokens: 1000 }),
        ];
        const f = detect("budget-pressure", events);
        expect(f).toHaveLength(2);
        // Negative used_fraction treated as unspecified -> warning without negative percentage.
        expect(f[0]!.severity).toBe("warning");
        expect(f[0]!.summary).not.toContain("-");
        expect(f[0]!.facts.used_fraction).toBeUndefined();
        // Derived fraction from used/limit -> critical 96%.
        expect(f[1]!.severity).toBe("critical");
        expect(f[1]!.facts.used_fraction).toBeCloseTo(0.96);
    });

    it("isolates context_id series across different producer streams", () => {
        const e = syntheticStream("budget_iso");
        const pA = { name: "rt", version: "1", node_id: "n1", instance_id: "a", synthetic: true };
        const pB = { name: "rt", version: "1", node_id: "n2", instance_id: "b", synthetic: true };
        const events = [
            e(0, "context.appended", { context_id: "c", used_tokens: 90, limit_tokens: 100 }, { producer: pA }),
            e(10, "context.appended", { context_id: "c", used_tokens: 10, limit_tokens: 100 }, { producer: pB }),
            e(20, "context.appended", { context_id: "c", used_tokens: 92, limit_tokens: 100 }, { producer: pA }),
        ];
        const f = detect("budget-pressure", events);
        // Producer B's low sample must not split Producer A's contiguous episode.
        expect(f).toHaveLength(1);
        expect(f[0]!.evidenceEventIds).toHaveLength(2);
    });
});

describe("cache-thrash hardening", () => {
    it("handles zero/negative/NaN windowMs, invalid minLookups, and NaN timestamps safely", () => {
        const e = syntheticStream("cache_hard");
        const events = Array.from({ length: 20 }, (_, i) => e(i * 100, i < 10 ? "kv.reused" : "kv.allocated"));
        expect(detect("cache-thrash", events, { cacheThrash: { windowMs: 0 } })).toEqual([]);
        expect(detect("cache-thrash", events, { cacheThrash: { windowMs: -100 } })).toEqual([]);
        expect(detect("cache-thrash", events, { cacheThrash: { windowMs: Number.NaN } })).toEqual([]);
        expect(detect("cache-thrash", events, { cacheThrash: { minLookups: 0 } })).toEqual([]);
        expect(detect("cache-thrash", [{ ...e(0, "kv.reused"), mono_ns: Number.NaN }])).toEqual([]);
    });

    it("isolates cache scopes across producer streams", () => {
        const e = syntheticStream("cache_iso");
        const pA = { name: "inf", version: "1", node_id: "n1", instance_id: "a", synthetic: true };
        const pB = { name: "inf", version: "1", node_id: "n2", instance_id: "b", synthetic: true };
        const events: ObservatoryEvent[] = [];
        for (let i = 0; i < 10; i += 1) {
            events.push(e(i * 100, "kv.reused", {}, { device_id: "gpu:0", producer: pA }));
            events.push(e(5000 + i * 100, "kv.allocated", {}, { device_id: "gpu:0", producer: pB }));
        }
        expect(detect("cache-thrash", events)).toEqual([]);
    });
});

describe("compaction hardening", () => {
    it("closes open compactions on cancellation and guards negative durations/tokens", () => {
        const e = syntheticStream("compact_hard");
        const events = [
            e(0, "context.compaction.started", { context_id: "c1", compaction_id: "cmp_cancel" }),
            e(50, "context.compaction.cancelled", { context_id: "c1", compaction_id: "cmp_cancel" }),
            // Clock-skewed completion (mono_ns < start.mono_ns) with negative tokens
            e(200, "context.compaction.started", { context_id: "c2", compaction_id: "cmp_skew" }),
            {
                ...e(100, "context.compaction.completed", {
                    context_id: "c2",
                    compaction_id: "cmp_skew",
                    tokens_before: -10,
                    tokens_after: 5,
                    duration_ms: 42,
                }),
                mono_ns: 100_000_000,
            },
        ];
        // Pass directly through detectCompaction via sorted order where skew occurs if unsorted;
        // also test completed with producer-reported duration when no prior start exists.
        const f = detect("compaction", events);
        // Cancelled compaction must NOT emit a dangling-start warning.
        expect(f.some((x) => x.summary.includes("no completion observed") && x.facts.scope === "context:c1")).toBe(false);
        // Completed compaction with negative tokens must not emit negative token facts.
        const completed = f.find((x) => x.severity === "info")!;
        expect(completed.facts.tokens_before).toBeUndefined();
        expect(completed.facts.tokens_after).toBeUndefined();
        expect(completed.facts.duration_ms).toBe(42);
    });
});

describe("duplicate-worker hardening", () => {
    it("treats agent.failed as terminal so a retry worker is not a false positive", () => {
        const e = syntheticStream("dup_fail");
        const events = [
            e(0, "agent.spawned", { task_hash: "sha256:job1" }, { agent_id: "agt_1" }),
            e(100, "agent.failed", { error: "timeout" }, { agent_id: "agt_1" }),
            e(200, "agent.spawned", { task_hash: "sha256:job1" }, { agent_id: "agt_2" }),
            e(300, "agent.completed", {}, { agent_id: "agt_2" }),
        ];
        expect(detect("duplicate-worker", events)).toEqual([]);
    });

    it("detaches an agent from its prior task when re-spawned on a new task without completion", () => {
        const e = syntheticStream("dup_respawn");
        const events = [
            e(0, "agent.spawned", { task_hash: "task_A" }, { agent_id: "agt_1" }),
            // agt_1 moves to task_B without emitting agent.completed for task_A
            e(100, "agent.spawned", { task_hash: "task_B" }, { agent_id: "agt_1" }),
            // agt_2 now takes task_A -> must NOT falsely collide with agt_1
            e(200, "agent.spawned", { task_hash: "task_A" }, { agent_id: "agt_2" }),
        ];
        expect(detect("duplicate-worker", events)).toEqual([]);
    });

    it("isolates sessions/producers and ignores whitespace-only task keys", () => {
        const e = syntheticStream("dup_iso");
        const events = [
            e(0, "agent.spawned", { task_hash: "same" }, { agent_id: "a1", session_id: "s1" }),
            e(10, "agent.spawned", { task_hash: "same" }, { agent_id: "a2", session_id: "s2" }),
            e(20, "agent.spawned", { task_hash: "   " }, { agent_id: "a3", session_id: "s1" }),
            e(30, "agent.spawned", { task_hash: "   " }, { agent_id: "a4", session_id: "s1" }),
        ];
        expect(detect("duplicate-worker", events)).toEqual([]);
    });
});

describe("error-burst hardening", () => {
    it("captures Wave 2 fanout/ensemble failures and guards invalid thresholds", () => {
        const e = syntheticStream("err_w2");
        const events = [
            e(0, "fanout.worker.failed", { error: "oom" }),
            e(100, "ensemble.candidate.failed", { error: "timeout" }),
            e(200, "ensemble.failed", { error: "quorum_lost" }),
        ];
        const f = detect("error-burst", events);
        expect(f).toHaveLength(1);
        expect(f[0]!.facts.failures).toBe(3);
        expect(f[0]!.facts.breakdown).toBe("1x ensemble.candidate.failed, 1x ensemble.failed, 1x fanout.worker.failed");
        expect(detect("error-burst", events, { errorBurst: { count: 0 } })).toEqual([]);
        expect(detect("error-burst", events, { errorBurst: { windowMs: -1 } })).toEqual([]);
    });
});

describe("latency-outlier hardening", () => {
    it("detects Wave 2 embedding requests without request.started and ignores clock-skewed/NaN spans", () => {
        const e = syntheticStream("lat_w2");
        const events: ObservatoryEvent[] = [];
        for (let i = 0; i < 6; i += 1) {
            events.push(
                e(i * 1000, "request.queued", { kind: "embed" }, { request_id: `emb_${i}` }),
                e(i * 1000 + 50, "request.completed", { kind: "embed" }, { request_id: `emb_${i}` }),
            );
        }
        // Inject a malformed NaN-timestamp span that must NOT poison the rolling baseline.
        events.push(
            { ...e(7000, "request.started", {}, { request_id: "nan_req" }), mono_ns: Number.NaN },
            e(7100, "request.completed", {}, { request_id: "nan_req" }),
        );
        // Slow embedding request (1000 ms vs 50 ms baseline p95).
        events.push(
            e(8000, "request.queued", { kind: "embed" }, { request_id: "emb_slow" }),
            e(9000, "request.completed", { kind: "embed" }, { request_id: "emb_slow" }),
        );
        const f = detect("latency-outlier", events);
        expect(f).toHaveLength(1);
        expect(f[0]!.facts.request_id).toBe("emb_slow");
        expect(f[0]!.facts.duration_ms).toBe(1000);
        expect(f[0]!.facts.baseline_p95_ms).toBe(50);
    });

    it("guards invalid config and handles large rolling baselines quickly", () => {
        const e = syntheticStream("lat_scale");
        const events: ObservatoryEvent[] = [];
        for (let i = 0; i < 5_000; i += 1) {
            const dur = i === 4_999 ? 5000 : 100 + (i % 20);
            events.push(
                e(i * 200, "request.started", {}, { request_id: `r_${i}` }),
                e(i * 200 + dur, "request.completed", {}, { request_id: `r_${i}` }),
            );
        }
        expect(detect("latency-outlier", events, { latency: { baselineSize: 0 } })).toEqual([]);
        expect(detect("latency-outlier", events, { latency: { factor: Number.NaN } })).toEqual([]);
        const t0 = performance.now();
        const f = detect("latency-outlier", events, { latency: { baselineSize: 200 } });
        expect(performance.now() - t0).toBeLessThan(500);
        expect(f).toHaveLength(1);
        expect(f[0]!.facts.request_id).toBe("r_4999");
    });
});

describe("model-churn hardening", () => {
    it("ignores non-resident model.load.completed and recognizes model.unloaded / model.unload.completed", () => {
        const e = syntheticStream("churn_w2");
        const nonResident = Array.from({ length: 6 }, (_, i) =>
            e(i * 1000, "model.load.completed", { resident: false }, { model_instance_id: "m1" }),
        );
        expect(detect("model-churn", nonResident)).toEqual([]);

        const mixed = [
            e(0, "model.load.completed", {}, { model_instance_id: "m1" }),
            e(1000, "model.unloaded", {}, { model_instance_id: "m1" }),
            e(2000, "model.load.completed", {}, { model_instance_id: "m2" }),
            e(3000, "model.unload.completed", {}, { model_instance_id: "m2" }),
        ];
        const f = detect("model-churn", mixed);
        expect(f).toHaveLength(1);
        expect(f[0]!.facts).toMatchObject({ loads: 2, unloads: 2 });
    });
});

describe("no-progress-loop hardening", () => {
    it("ignores redacted variants/hashes, preserves pipes in tool names, and isolates sessions", () => {
        const e = syntheticStream("noprog_hard");
        expect(callSignature(e(0, "tool.called", { tool: "t", args: "[redacted: pii]" }))).toBeNull();
        expect(callSignature(e(0, "tool.called", { tool: "t", args: "<redacted: secret>" }))).toBeNull();
        expect(callSignature(e(0, "tool.called", { tool: "t", args: "   " }))).toBeNull();
        expect(callSignature(e(0, "tool.called", { tool: "t", args_hash: "[redacted]" }))).toBeNull();

        // Tool name containing "|" must stay intact in facts.tool.
        const pipeEvents = Array.from({ length: 3 }, (_, i) =>
            e(i * 10, "tool.called", { tool: "mcp|search", args_hash: "sha256:abc12345" }, { agent_id: "a1" }),
        );
        const f = detect("no-progress-loop", pipeEvents);
        expect(f).toHaveLength(1);
        expect(f[0]!.facts.tool).toBe("mcp|search");

        // Same agent_id across two different sessions must not combine into one loop.
        const crossSession = [
            e(0, "tool.called", { tool: "t", args_hash: "h" }, { agent_id: "a1", session_id: "s1" }),
            e(10, "tool.called", { tool: "t", args_hash: "h" }, { agent_id: "a1", session_id: "s2" }),
            e(20, "tool.called", { tool: "t", args_hash: "h" }, { agent_id: "a1", session_id: "s1" }),
        ];
        expect(detect("no-progress-loop", crossSession)).toEqual([]);
        expect(detect("no-progress-loop", pipeEvents, { noProgress: { repeatCount: 0 } })).toEqual([]);
    });

    it("handles thousands of outcomes sharing a tool_call_id in linear time", () => {
        const e = syntheticStream("noprog_scale");
        const events: ObservatoryEvent[] = [];
        for (let i = 0; i < 3; i += 1) {
            events.push(e(i * 10, "tool.called", { tool: "t", tool_call_id: "tc_shared", args_hash: "h1" }, { agent_id: "a1" }));
        }
        for (let i = 0; i < 5_000; i += 1) {
            events.push(e(100 + i, "tool.failed", { tool: "t", tool_call_id: "tc_shared" }, { agent_id: "a1" }));
        }
        const t0 = performance.now();
        const f = detect("no-progress-loop", events);
        expect(performance.now() - t0).toBeLessThan(500);
        expect(f).toHaveLength(1);
        // Outcomes attached once (3 calls + 5,000 outcomes = 5,003 unique ids, not 3 * 5,000).
        expect(f[0]!.evidenceEventIds).toHaveLength(5_003);
    });
});

describe("retry-storm & FindingsController hardening", () => {
    it("retry-storm guards invalid thresholds and runs linearly on large bursts", () => {
        const e = syntheticStream("retry_hard");
        const events = Array.from({ length: 10_000 }, (_, i) => e(i, "retry.scheduled"));
        expect(detect("retry-storm", events, { retryStorm: { count: 0 } })).toEqual([]);
        expect(detect("retry-storm", events, { retryStorm: { windowMs: Number.NaN } })).toEqual([]);
        const t0 = performance.now();
        const f = detect("retry-storm", events);
        expect(performance.now() - t0).toBeLessThan(500);
        expect(f).toHaveLength(1);
        expect(f[0]!.facts.retries).toBe(10_000);
    });

    it("FindingsController tolerates empty evidence arrays and unknown severity values", () => {
        const selected: string[] = [];
        const highlighted: string[][] = [];
        const host: DiagnosticsSelectionHost = {
            highlightEvents: (ids) => highlighted.push([...ids]),
            selectEvent: (id) => selected.push(id),
        };
        const ctrl = new FindingsController(host);
        const badFinding = {
            id: "f:empty",
            kind: "retry-storm",
            severity: "bogus" as Finding["severity"],
            startNs: 0,
            endNs: 0,
            summary: "x",
            evidenceEventIds: [],
            facts: {},
            provenance: "derived",
        } satisfies Finding;
        ctrl.setFindings([badFinding]);
        expect(ctrl.counts()).toEqual({ info: 0, warning: 0, critical: 0 });
        ctrl.select("f:empty");
        expect(highlighted.at(-1)).toEqual([]);
        expect(selected).toEqual([]);
    });
});
