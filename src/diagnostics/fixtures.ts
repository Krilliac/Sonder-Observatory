/**
 * Labelled SYNTHETIC diagnostic cases. Not model telemetry: every event
 * carries producer.synthetic = true and attributes.synthetic = true so the
 * renderer labels it as synthetic. Each case targets one detector and states
 * whether it must trigger (positive) or must not (negative).
 */
import type { ObservatoryEvent } from "../protocol/events";
import type { FindingKind } from "./types";

export interface DiagnosticCase {
    label: string;
    kind: FindingKind;
    expect: "positive" | "negative";
    description: string;
    events: ObservatoryEvent[];
    /** For positive cases: event ids that must appear as evidence of some finding. */
    mustCite?: string[];
}

const PRODUCER = { name: "sonder-observatory-synthetic-diagnostics", version: "0.1.0", node_id: "fixture", synthetic: true };

/** Builds a case-local synthetic event factory with unique ids and sequences. */
export function syntheticStream(caseId: string) {
    let seq = 0;
    return (atMs: number, eventType: string, attributes: Record<string, unknown> = {}, envelope: Partial<ObservatoryEvent> = {}): ObservatoryEvent => {
        seq += 1;
        return {
            schema: "sonder.observatory.event/1",
            event_id: `evt_diag_${caseId}_${String(seq).padStart(4, "0")}`,
            sequence: seq,
            event_type: eventType,
            wall_time: new Date(Date.UTC(2026, 8, 26, 8, 0, 0) + atMs).toISOString(),
            mono_ns: Math.round(atMs * 1_000_000),
            session_id: `ses_diag_${caseId}`,
            producer: PRODUCER,
            sampling: { level: "standard", sampled: true },
            ...envelope,
            attributes: { synthetic: true, ...attributes },
        };
    };
}

function budgetPositive(): DiagnosticCase {
    const e = syntheticStream("budget_pos");
    const events = [0, 1, 2, 3, 4].map((i) =>
        e(i * 1000, "context.appended", { context_id: "ctx_1", used_tokens: [3000, 6600, 7200, 7900, 5000][i], limit_tokens: 8192 }),
    );
    events.push(e(4500, "guard.budget_pressure", { budget: "context", used_fraction: 0.97 }, { agent_id: "agt_a" }));
    return {
        label: "budget: context climbs past 80% then 95%, plus a producer guard",
        kind: "budget-pressure",
        expect: "positive",
        description: "3 samples >= 80% of 8192 tokens (peak 96.4%) and one guard.budget_pressure.",
        events,
        mustCite: [events[1]!.event_id, events[3]!.event_id, events[5]!.event_id],
    };
}

function budgetNegative(): DiagnosticCase {
    const e = syntheticStream("budget_neg");
    return {
        label: "budget: usage stays under 80%; used-only samples are ignored",
        kind: "budget-pressure",
        expect: "negative",
        description: "Peaks at 70%; one event has used_tokens but no limit.",
        events: [
            e(0, "context.appended", { context_id: "ctx_1", used_tokens: 2000, limit_tokens: 8192 }),
            e(1000, "context.appended", { context_id: "ctx_1", used_tokens: 5734, limit_tokens: 8192 }),
            e(2000, "context.appended", { context_id: "ctx_1", used_tokens: 99999 }),
        ],
    };
}

function compactionPositive(): DiagnosticCase {
    const e = syntheticStream("compact_pos");
    const ctx = { context_id: "ctx_1" };
    const events = [
        e(0, "context.compaction.started", { ...ctx, tokens_before: 7800 }),
        e(120, "context.compaction.completed", { ...ctx, tokens_after: 2100 }),
        e(10_000, "context.compaction.started", ctx),
        e(10_080, "context.compaction.completed", { ...ctx, tokens_before: 7600, tokens_after: 2300 }),
        e(20_000, "context.compaction.started", ctx),
        e(20_090, "context.compaction.completed", ctx),
        e(30_000, "context.compaction.started", { context_id: "ctx_2" }),
    ];
    return {
        label: "compaction: three compactions in 20 s (churn) and one that never completes",
        kind: "compaction",
        expect: "positive",
        description: "Info per compaction, churn warning, dangling start warning.",
        events,
        mustCite: [events[0]!.event_id, events[1]!.event_id, events[5]!.event_id, events[6]!.event_id],
    };
}

function compactionNegative(): DiagnosticCase {
    const e = syntheticStream("compact_neg");
    return {
        label: "compaction: none in stream",
        kind: "compaction",
        expect: "negative",
        description: "Context appends only.",
        events: [e(0, "context.appended", { context_id: "ctx_1" }), e(500, "context.created", { context_id: "ctx_2" })],
    };
}

function toolCall(e: ReturnType<typeof syntheticStream>, atMs: number, id: string, tool: string, attrs: Record<string, unknown>, agent = "agt_w") {
    return [
        e(atMs, "tool.called", { tool_call_id: id, tool, ...attrs }, { agent_id: agent }),
        e(atMs + 50, "tool.completed", { tool_call_id: id, tool, output_hash: attrs.output_hash ?? `sha256:out_${id}` }, { agent_id: agent }),
    ];
}

function noProgressPositive(): DiagnosticCase {
    const e = syntheticStream("loop_pos");
    const events = [
        ...toolCall(e, 0, "tc1", "fs.read", { args_hash: "sha256:aaa", output_hash: "sha256:same" }),
        ...toolCall(e, 200, "tc2", "fs.read", { args_hash: "sha256:aaa", output_hash: "sha256:same" }),
        ...toolCall(e, 400, "tc3", "fs.read", { args_hash: "sha256:aaa", output_hash: "sha256:same" }),
        ...toolCall(e, 600, "tc4", "fs.read", { args_hash: "sha256:aaa", output_hash: "sha256:same" }),
    ];
    return {
        label: "no-progress: same tool + same args hash 4x, identical outputs",
        kind: "no-progress-loop",
        expect: "positive",
        description: "Agent agt_w calls fs.read with args_hash sha256:aaa four times in a row.",
        events,
        mustCite: events.map((x) => x.event_id),
    };
}

function noProgressNegative(): DiagnosticCase {
    const e = syntheticStream("loop_neg");
    return {
        label: "no-progress: redacted args are unknown, varied args differ",
        kind: "no-progress-loop",
        expect: "negative",
        description: "Four calls with args '[redacted]' (not comparable) and three with distinct hashes.",
        events: [
            ...toolCall(e, 0, "r1", "web.fetch", { args: "[redacted]" }),
            ...toolCall(e, 100, "r2", "web.fetch", { args: "[redacted]" }),
            ...toolCall(e, 200, "r3", "web.fetch", { args: "[redacted]" }),
            ...toolCall(e, 300, "r4", "web.fetch", { args: "[redacted]" }),
            ...toolCall(e, 400, "v1", "fs.read", { args_hash: "sha256:1" }),
            ...toolCall(e, 500, "v2", "fs.read", { args_hash: "sha256:2" }),
            ...toolCall(e, 600, "v3", "fs.read", { args_hash: "sha256:3" }),
        ],
    };
}

function duplicatePositive(): DiagnosticCase {
    const e = syntheticStream("dup_pos");
    const events = [
        e(0, "agent.spawned", { role: "worker", task_hash: "sha256:task1" }, { agent_id: "agt_1" }),
        e(300, "agent.spawned", { role: "worker", task_hash: "sha256:task1" }, { agent_id: "agt_2" }),
        e(900, "agent.completed", {}, { agent_id: "agt_1" }),
        e(1200, "agent.completed", {}, { agent_id: "agt_2" }),
    ];
    return {
        label: "duplicate: two workers spawned for the same task hash while both active",
        kind: "duplicate-worker",
        expect: "positive",
        description: "agt_2 spawned for sha256:task1 while agt_1 still running.",
        events,
        mustCite: [events[0]!.event_id, events[1]!.event_id],
    };
}

function duplicateNegative(): DiagnosticCase {
    const e = syntheticStream("dup_neg");
    return {
        label: "duplicate: same task run sequentially; different tasks concurrently; no task identity",
        kind: "duplicate-worker",
        expect: "negative",
        description: "Re-spawn after completion is not a duplicate; spawns without task keys are not compared.",
        events: [
            e(0, "agent.spawned", { task_hash: "sha256:t1" }, { agent_id: "agt_1" }),
            e(500, "agent.completed", {}, { agent_id: "agt_1" }),
            e(600, "agent.spawned", { task_hash: "sha256:t1" }, { agent_id: "agt_2" }),
            e(700, "agent.spawned", { task_hash: "sha256:t2" }, { agent_id: "agt_3" }),
            e(800, "agent.spawned", { role: "worker" }, { agent_id: "agt_4" }),
            e(900, "agent.spawned", { role: "worker" }, { agent_id: "agt_5" }),
        ],
    };
}

function retryPositive(): DiagnosticCase {
    const e = syntheticStream("retry_pos");
    const events: ObservatoryEvent[] = [];
    for (let i = 0; i < 4; i++) {
        events.push(e(i * 1000, "tool.failed", { tool_call_id: "tc_x", error: "synthetic timeout" }, { request_id: "req_1" }));
        events.push(e(i * 1000 + 5, "retry.scheduled", { tool_call_id: "tc_x", attempt: i + 2, backoff_ms: 100 }, { request_id: "req_1" }));
    }
    return {
        label: "retry: four retries of one tool call within 3 s",
        kind: "retry-storm",
        expect: "positive",
        description: "retry.scheduled x4 within 10 s window (threshold 3).",
        events,
        mustCite: events.filter((x) => x.event_type === "retry.scheduled").map((x) => x.event_id),
    };
}

function retryNegative(): DiagnosticCase {
    const e = syntheticStream("retry_neg");
    return {
        label: "retry: retries spread 15 s apart",
        kind: "retry-storm",
        expect: "negative",
        description: "Three retries but never three within 10 s.",
        events: [0, 15_000, 30_000].map((t) => e(t, "retry.scheduled", { attempt: 2 }, { request_id: `req_${t}` })),
    };
}

function cachePositive(): DiagnosticCase {
    const e = syntheticStream("cache_pos");
    const m = { model_instance_id: "mdl_1" };
    const events: ObservatoryEvent[] = [];
    // window 0 (0-5 s): 10 lookups, 9 hits
    for (let i = 0; i < 10; i++) {
        events.push(e(i * 400, i < 9 ? "kv.reused" : "kv.allocated", { kv_segment_id: `seg_${i}` }, m));
    }
    // window 1 (5-10 s): 10 lookups, 1 hit
    for (let i = 0; i < 10; i++) {
        events.push(e(5000 + i * 400, i < 1 ? "kv.reused" : "kv.allocated", { kv_segment_id: `seg_b${i}` }, m));
    }
    // eviction churn: 20 evictions in 2 s
    for (let i = 0; i < 20; i++) {
        events.push(e(10_000 + i * 100, "kv.evicted", { kv_segment_id: `seg_e${i}` }, m));
    }
    return {
        label: "cache: hit rate 90% -> 10% and 20 evictions in 2 s",
        kind: "cache-thrash",
        expect: "positive",
        description: "Collapse from 90% baseline to 10% plus eviction churn.",
        events,
        mustCite: [events[0]!.event_id, events[19]!.event_id, events[20]!.event_id, events[39]!.event_id],
    };
}

function cacheNegative(): DiagnosticCase {
    const e = syntheticStream("cache_neg");
    const events: ObservatoryEvent[] = [];
    for (let w = 0; w < 3; w++) {
        for (let i = 0; i < 10; i++) {
            events.push(e(w * 5000 + i * 400, i < 7 ? "kv.reused" : "kv.allocated", {}, { model_instance_id: "mdl_1" }));
        }
    }
    // a sparse window with 0 hits but too few lookups to judge
    events.push(e(15_000, "kv.allocated", {}, { model_instance_id: "mdl_1" }));
    for (let i = 0; i < 5; i++) {
        events.push(e(16_000 + i * 1000, "kv.evicted", {}, { model_instance_id: "mdl_1" }));
    }
    return {
        label: "cache: steady 70% hit rate, sparse window ignored, few evictions",
        kind: "cache-thrash",
        expect: "negative",
        description: "No collapse; 5 evictions below threshold 20.",
        events,
    };
}

function churnPositive(): DiagnosticCase {
    const e = syntheticStream("churn_pos");
    const events: ObservatoryEvent[] = [];
    for (let i = 0; i < 3; i++) {
        const id = i % 2 === 0 ? "mdl_a" : "mdl_b";
        events.push(e(i * 10_000, "model.load.started", {}, { model_instance_id: id }));
        events.push(e(i * 10_000 + 2000, "model.load.completed", { load_ms: 2000 }, { model_instance_id: id }));
        events.push(e(i * 10_000 + 8000, "model.unload", {}, { model_instance_id: id }));
    }
    return {
        label: "model churn: load/unload three times in 30 s",
        kind: "model-churn",
        expect: "positive",
        description: "6 lifecycle transitions within 60 s (threshold 4).",
        events,
        mustCite: events.filter((x) => x.event_type !== "model.load.started").map((x) => x.event_id),
    };
}

function churnNegative(): DiagnosticCase {
    const e = syntheticStream("churn_neg");
    return {
        label: "model churn: single load, unload at session end",
        kind: "model-churn",
        expect: "negative",
        description: "2 transitions.",
        events: [
            e(0, "model.load.started", {}, { model_instance_id: "mdl_a" }),
            e(800, "model.load.completed", {}, { model_instance_id: "mdl_a" }),
            e(120_000, "model.unload", {}, { model_instance_id: "mdl_a" }),
        ],
    };
}

function requests(e: ReturnType<typeof syntheticStream>, durations: number[], failLast = false): ObservatoryEvent[] {
    const out: ObservatoryEvent[] = [];
    let t = 0;
    durations.forEach((d, i) => {
        const rid = `req_${i}`;
        out.push(e(t, "request.started", {}, { request_id: rid }));
        const last = i === durations.length - 1;
        out.push(e(t + d, failLast && last ? "request.failed" : "request.completed", {}, { request_id: rid }));
        t += d + 100;
    });
    return out;
}

function latencyPositive(): DiagnosticCase {
    const e = syntheticStream("lat_pos");
    const events = requests(e, [400, 420, 390, 410, 405, 395, 415, 3200]);
    return {
        label: "latency: seven ~400 ms requests then one 3200 ms request",
        kind: "latency-outlier",
        expect: "positive",
        description: "3200 ms vs rolling p95 420 ms.",
        events,
        mustCite: [events[14]!.event_id, events[15]!.event_id],
    };
}

function latencyNegative(): DiagnosticCase {
    const e = syntheticStream("lat_neg");
    return {
        label: "latency: steady latency; early slow request lacks baseline; small-absolute jitter",
        kind: "latency-outlier",
        expect: "negative",
        description: "First request 5 s has no baseline; 2.5x of 20 ms is below minExcessMs.",
        events: requests(e, [5000, 20, 20, 20, 20, 20, 50]),
    };
}

function errorPositive(): DiagnosticCase {
    const e = syntheticStream("err_pos");
    const events = [
        e(0, "tool.failed", { error: "synthetic" }, { request_id: "req_1" }),
        e(400, "request.failed", { error: "synthetic" }, { request_id: "req_1" }),
        e(900, "tool.failed", { error: "synthetic" }, { request_id: "req_2" }),
        e(1500, "backend.error", { error: "synthetic" }),
    ];
    return {
        label: "errors: four failures within 1.5 s",
        kind: "error-burst",
        expect: "positive",
        description: "tool.failed x2, request.failed, backend.error.",
        events,
        mustCite: events.map((x) => x.event_id),
    };
}

function errorNegative(): DiagnosticCase {
    const e = syntheticStream("err_neg");
    return {
        label: "errors: isolated failures; retries and guards are not failures",
        kind: "error-burst",
        expect: "negative",
        description: "Failures 10 s apart; retry.scheduled/guard.* ignored.",
        events: [
            e(0, "tool.failed", {}),
            e(100, "retry.scheduled", {}),
            e(200, "guard.no_progress", {}),
            e(10_000, "request.failed", {}),
            e(20_000, "tool.failed", {}),
        ],
    };
}

function mem(e: ReturnType<typeof syntheticStream>, atMs: number, fraction: number, kind = "vram", device = "dev_gpu0") {
    const total = 12 * 2 ** 30;
    return e(atMs, "device.memory.sample", { used_bytes: Math.round(total * fraction), total_bytes: total, kind }, { device_id: device });
}

function resourcePositive(): DiagnosticCase {
    const e = syntheticStream("res_pos");
    const events = [
        mem(e, 0, 0.5),
        mem(e, 250, 0.88),
        mem(e, 500, 0.97),
        mem(e, 750, 0.9),
        mem(e, 1000, 0.6),
        e(1100, "kv.pressure", { occupancy: 0.96, action: "evict-candidates" }, { device_id: "dev_gpu0" }),
    ];
    return {
        label: "resource: VRAM peaks at 97% for three samples; KV pressure event",
        kind: "resource-pressure",
        expect: "positive",
        description: "Critical VRAM episode plus producer-reported kv.pressure.",
        events,
        mustCite: [events[1]!.event_id, events[2]!.event_id, events[3]!.event_id, events[5]!.event_id],
    };
}

function resourceNegative(): DiagnosticCase {
    const e = syntheticStream("res_neg");
    return {
        label: "resource: memory under 85% on every device",
        kind: "resource-pressure",
        expect: "negative",
        description: "VRAM 80%, RAM 84%.",
        events: [mem(e, 0, 0.8), mem(e, 0, 0.84, "ram", "host"), mem(e, 500, 0.7)],
    };
}

export const DIAGNOSTIC_CASES: readonly DiagnosticCase[] = [
    budgetPositive(),
    budgetNegative(),
    compactionPositive(),
    compactionNegative(),
    noProgressPositive(),
    noProgressNegative(),
    duplicatePositive(),
    duplicateNegative(),
    retryPositive(),
    retryNegative(),
    cachePositive(),
    cacheNegative(),
    churnPositive(),
    churnNegative(),
    latencyPositive(),
    latencyNegative(),
    errorPositive(),
    errorNegative(),
    resourcePositive(),
    resourceNegative(),
];
