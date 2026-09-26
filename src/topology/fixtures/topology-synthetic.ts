/**
 * SYNTHETIC TOPOLOGY FIXTURE — not model telemetry.
 *
 * Hand-authored orchestration events that exercise Milestone 2 topology
 * paths the Milestone 1 fixture (fixtures/synthetic-session.ndjson) does not
 * cover: route.changed, agent.message, context.forked, memory retrieval,
 * recovery.action, guard.no_progress and guard.duplicate_work. Every event
 * is marked `producer.synthetic = true` and `attributes.synthetic = true`,
 * so the UI labels it as synthetic data. Attribute names follow the
 * conventions documented in src/topology/derive.ts.
 */
import type { ObservatoryEvent } from "../../protocol/events";

export const TOPOLOGY_FIXTURE_SESSION = "ses_topology_synthetic_0001";

const T0_NS = 2_000_000_000;
const WALL0_MS = Date.parse("2026-09-26T09:00:00.000Z");

type Row = [ms: number, type: string, fields: Partial<ObservatoryEvent>, attributes?: Record<string, unknown>];

const ROWS: Row[] = [
    [0, "session.started", {}, { text_capture: "none", note: "Synthetic topology fixture (src/topology/fixtures); not model telemetry." }],
    [10, "model.load.started", { model_instance_id: "mdl_syn_small" }, { model: "synthetic-3b" }],
    [60, "model.load.completed", { model_instance_id: "mdl_syn_small" }, { model: "synthetic-3b" }],
    [100, "agent.spawned", { agent_id: "agt_owner" }, { role: "owner", name: "owner" }],
    [105, "agent.started", { agent_id: "agt_owner" }, { role: "owner" }],
    [110, "route.selected", { agent_id: "agt_owner", model_instance_id: "mdl_syn_small" }, { reason: "default-route" }],
    [200, "agent.spawned", { agent_id: "agt_research" }, { role: "worker", parent: "agt_owner", name: "research" }],
    [205, "agent.started", { agent_id: "agt_research" }, { role: "worker" }],
    [210, "route.selected", { agent_id: "agt_research", model_instance_id: "mdl_syn_small" }, { reason: "worker-default" }],
    [220, "context.forked", { agent_id: "agt_owner", context_id: "ctx_1" }, { to_agent_id: "agt_research", tokens: 1200, parent_context_id: "ctx_0" }],
    [300, "memory.retrieval.started", { agent_id: "agt_research" }, { store: "project-notes" }],
    [340, "memory.retrieval.completed", { agent_id: "agt_research" }, { store: "project-notes", items: 4, tokens: 640 }],
    [400, "tool.called", { agent_id: "agt_research" }, { tool_call_id: "tc_a", tool: "synthetic.search", args: "[redacted]" }],
    [520, "tool.failed", { agent_id: "agt_research" }, { tool_call_id: "tc_a", error: "synthetic timeout" }],
    [525, "retry.scheduled", { agent_id: "agt_research" }, { tool_call_id: "tc_a", attempt: 2, backoff_ms: 50 }],
    [580, "tool.called", { agent_id: "agt_research" }, { tool_call_id: "tc_b", tool: "synthetic.search", args: "[redacted]", attempt: 2 }],
    [640, "tool.failed", { agent_id: "agt_research" }, { tool_call_id: "tc_b", error: "synthetic timeout" }],
    [645, "guard.no_progress", { agent_id: "agt_research" }, { window_ms: 500, repeated_actions: 2 }],
    [650, "model.load.started", { model_instance_id: "mdl_syn_large" }, { model: "synthetic-13b" }],
    [760, "model.load.completed", { model_instance_id: "mdl_syn_large" }, { model: "synthetic-13b" }],
    [770, "route.changed", { agent_id: "agt_research", model_instance_id: "mdl_syn_large" }, { from_model: "mdl_syn_small", reason: "recovery-escalation" }],
    [775, "recovery.action", { agent_id: "agt_research" }, { action: "escalate-model", target_model: "mdl_syn_large" }],
    [800, "tool.called", { agent_id: "agt_research" }, { tool_call_id: "tc_c", tool: "synthetic.fetch", args: "[redacted]" }],
    [900, "tool.completed", { agent_id: "agt_research" }, { tool_call_id: "tc_c", duration_ms: 100, result: "[redacted]" }],
    [950, "agent.message", { agent_id: "agt_research" }, { to_agent_id: "agt_owner", tokens: 300, content_hash: "sha256:synthetic" }],
    [960, "agent.completed", { agent_id: "agt_research" }, { role: "worker" }],
    [1000, "agent.spawned", { agent_id: "agt_critic" }, { role: "critic", parent: "agt_owner", name: "critic" }],
    [1005, "agent.started", { agent_id: "agt_critic" }, { role: "critic" }],
    [1010, "route.selected", { agent_id: "agt_critic", model_instance_id: "mdl_syn_small" }, { reason: "critic-default" }],
    [1100, "guard.duplicate_work", { agent_id: "agt_critic" }, { duplicate_of: "agt_research", similarity: 0.97 }],
    [1150, "agent.cancelled", { agent_id: "agt_critic" }, { reason: "duplicate-work" }],
    [1200, "guard.budget_pressure", {}, { budget: "context", used_fraction: 0.91 }],
    [1300, "tool.completed", { agent_id: "agt_owner" }, { tool_call_id: "tc_unknown", result: "[redacted]" }],
    [1400, "agent.completed", { agent_id: "agt_owner" }, { role: "owner" }],
    [1500, "session.ended", {}, {}],
];

/** Builds the synthetic topology fixture (fresh objects on every call). */
export function topologyFixtureEvents(): ObservatoryEvent[] {
    return ROWS.map(([ms, type, fields, attributes], i) => ({
        schema: "sonder.observatory.event/1",
        event_id: `evt_topo_${String(i + 1).padStart(4, "0")}`,
        sequence: i,
        event_type: type,
        wall_time: new Date(WALL0_MS + ms).toISOString(),
        mono_ns: T0_NS + ms * 1_000_000,
        session_id: TOPOLOGY_FIXTURE_SESSION,
        run_id: "run_topology_synthetic",
        producer: { name: "sonder-observatory-topology-fixture", version: "0.1.0", node_id: "fixture", synthetic: true },
        sampling: { level: "standard", sampled: true },
        ...fields,
        attributes: { synthetic: true, ...(attributes ?? {}) },
    }));
}

/** mono_ns of fixture row at `ms` offset (for scrub tests). */
export function topologyFixtureTime(ms: number): number {
    return T0_NS + ms * 1_000_000;
}
