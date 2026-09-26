/**
 * Sonder topology graph model (Milestone 2).
 *
 * Every node, edge and diagnostic carries the ids of the protocol events it
 * was derived from (`evidence`). Nothing in this model is inferred without an
 * event: an entity that no event mentions does not exist in the graph.
 */

export type TopologyNodeKind = "agent" | "model" | "tool" | "memory";

export const TOPOLOGY_NODE_KINDS: readonly TopologyNodeKind[] = ["agent", "model", "tool", "memory"];

export type TopologyEdgeKind =
    /** agent.spawned with a parent: parent agent -> child agent. */
    | "delegation"
    /** route.selected / route.changed: agent -> model instance. */
    | "route"
    /** route.changed with a reported previous model: old model -> new model. */
    | "route_change"
    /** context.forked (or context transfer attributes): agent -> agent. */
    | "context_transfer"
    /** agent.message with a reported recipient: agent -> agent. */
    | "message"
    /** tool.called / completed / failed: agent -> tool. */
    | "tool_call"
    /** memory.retrieval.*: agent -> memory store. */
    | "memory_retrieval"
    /** retry.scheduled correlated to a tool call or target: agent -> target. */
    | "retry"
    /** recovery.action with a reported target: agent -> target. */
    | "recovery";

export const TOPOLOGY_EDGE_KINDS: readonly TopologyEdgeKind[] = [
    "delegation",
    "route",
    "route_change",
    "context_transfer",
    "message",
    "tool_call",
    "memory_retrieval",
    "retry",
    "recovery",
];

/**
 * Lifecycle state as reported by events up to the graph time. "unknown"
 * means the entity was referenced but no lifecycle event was observed.
 */
export type NodeStatus = "pending" | "active" | "completed" | "failed" | "cancelled" | "loading" | "unloaded" | "unknown";

/** "superseded" marks a route edge replaced by a later route for the same agent. */
export type EdgeStatus = "active" | "ok" | "failed" | "superseded";

export type DiagnosticKind =
    | "retry"
    | "recovery"
    | "no_progress"
    | "duplicate_work"
    | "budget_pressure"
    | "guard"
    | "failure";

export interface TopologyDiagnostic {
    kind: DiagnosticKind;
    /** The single event this diagnostic was read from. */
    eventId: string;
    eventType: string;
    monoNs: number;
    /** Graph id of the node the diagnostic is attached to, if any. */
    nodeId: string | null;
}

export interface TopologyNode {
    /** Graph id, `${kind}:${entityId}`. */
    id: string;
    kind: TopologyNodeKind;
    /** Id as reported by the producer (agent_id, model_instance_id, tool name, store name). */
    entityId: string;
    label: string;
    /** Reported role (agents: owner/worker/critic...) when present in attributes. */
    role: string | null;
    status: NodeStatus;
    firstMonoNs: number;
    lastMonoNs: number;
    /** Event ids, in replay order, that mention this node. Never empty. */
    evidence: string[];
    diagnostics: TopologyDiagnostic[];
}

export interface TopologyEdge {
    /** `${kind}:${source}->${target}` */
    id: string;
    kind: TopologyEdgeKind;
    source: string;
    target: string;
    status: EdgeStatus;
    /** Number of evidence events that opened an interaction on this edge (calls, messages, routes...). */
    count: number;
    /** Number of reported failures on this edge. */
    failures: number;
    /** Sum of reported token counts, or null if no event reported tokens. */
    tokens: number | null;
    firstMonoNs: number;
    lastMonoNs: number;
    /** Event ids, in replay order. Never empty. */
    evidence: string[];
}

export interface TopologyGraph {
    nodes: TopologyNode[];
    edges: TopologyEdge[];
    /** Diagnostics that could not be attached to a node (no agent_id). */
    unattachedDiagnostics: TopologyDiagnostic[];
    /** Replay time the graph represents (inclusive), or null for "all events". */
    atMonoNs: number | null;
    /** Events considered (after dedupe and time cut). */
    consideredEvents: number;
    /** Events that contributed to at least one node, edge or diagnostic. */
    mappedEvents: number;
    /**
     * Topology-relevant events that could not be mapped because a required
     * field was missing (for example tool.completed with an unknown call).
     */
    unmappedEventIds: string[];
}

export type TopologySelection =
    | { kind: "node"; id: string }
    | { kind: "edge"; id: string };

export function nodeId(kind: TopologyNodeKind, entityId: string): string {
    return `${kind}:${entityId}`;
}

export function edgeId(kind: TopologyEdgeKind, source: string, target: string): string {
    return `${kind}:${source}->${target}`;
}
