import type { ObservatoryEvent } from "../protocol/events";
import { orderEvents } from "../replay/order";
import {
    edgeId,
    nodeId,
    type DiagnosticKind,
    type EdgeStatus,
    type NodeStatus,
    type TopologyDiagnostic,
    type TopologyEdge,
    type TopologyEdgeKind,
    type TopologyGraph,
    type TopologyNode,
    type TopologyNodeKind,
} from "./model";

/**
 * Pure derivation of the Sonder topology graph from protocol events.
 *
 * Attribute conventions read here (all optional; see INTEGRATION_NOTES.md):
 * - agent.spawned: `attributes.role`, `attributes.name`, parent in
 *   `attributes.parent` | `parent_agent_id` (matches the M1 synthetic fixture).
 * - agent.message: recipient in `attributes.to_agent_id` | `to` | `target_agent_id`.
 * - route.*: model in envelope `model_instance_id` | `attributes.model_instance_id`
 *   | `attributes.to_model`; previous model in `attributes.from_model` |
 *   `previous_model_instance_id`.
 * - model.*: display name in `attributes.model`.
 * - tool.*: `attributes.tool_call_id` (or envelope `tool_call_id`), tool name in
 *   `attributes.tool` | `tool_name`.
 * - memory.retrieval.*: store in `attributes.store` | `memory_store` | `store_id`.
 * - context.forked: source agent = envelope `agent_id` | `attributes.from_agent_id`,
 *   target = `attributes.to_agent_id` | `target_agent_id`.
 * - tokens: `attributes.tokens` | `token_count` | `transferred_tokens`.
 * - retry.scheduled: `attributes.tool_call_id` or `attributes.target_agent_id`.
 * - recovery.action: `attributes.target_agent_id` | `target_model` | `tool_call_id`.
 *
 * Nothing is invented: when a required id is missing the event is listed in
 * `unmappedEventIds` (or kept as a node-level diagnostic) instead of guessing.
 */

export interface DeriveOptions {
    /** Include only events with `mono_ns <= atMonoNs` (replay cursor time). */
    atMonoNs?: number | null;
}

/** Event types the topology understands (prefix match for families). */
export function isTopologyEvent(eventType: string): boolean {
    return (
        eventType.startsWith("agent.") ||
        eventType.startsWith("route.") ||
        eventType.startsWith("tool.") ||
        eventType.startsWith("memory.retrieval.") ||
        eventType.startsWith("guard.") ||
        eventType === "model.load.started" ||
        eventType === "model.load.completed" ||
        eventType === "model.unload" ||
        eventType === "context.forked" ||
        eventType === "retry.scheduled" ||
        eventType === "recovery.action"
    );
}

function str(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function attr(e: ObservatoryEvent, ...keys: string[]): string | null {
    for (const key of keys) {
        const v = str(e.attributes[key]);
        if (v) {
            return v;
        }
    }
    return null;
}

function envelopeOrAttr(e: ObservatoryEvent, key: string, ...attrKeys: string[]): string | null {
    return str(e[key]) ?? attr(e, key, ...attrKeys);
}

function tokensOf(e: ObservatoryEvent): number | null {
    return num(e.attributes.tokens) ?? num(e.attributes.token_count) ?? num(e.attributes.transferred_tokens);
}

interface ToolCallRecord {
    agentNode: string | null;
    toolNode: string;
    edge: string | null;
}

class GraphBuilder {
    readonly nodes = new Map<string, TopologyNode>();
    readonly edges = new Map<string, TopologyEdge>();
    readonly unattached: TopologyDiagnostic[] = [];
    readonly unmapped: string[] = [];
    readonly toolCalls = new Map<string, ToolCallRecord>();
    /** agent node id -> active route edge id */
    readonly activeRoute = new Map<string, string>();
    mapped = 0;
    private touched = false;

    begin(): void {
        this.touched = false;
    }

    end(e: ObservatoryEvent): void {
        if (this.touched) {
            this.mapped += 1;
        } else {
            this.unmapped.push(e.event_id);
        }
    }

    node(kind: TopologyNodeKind, entityId: string, e: ObservatoryEvent, label?: string | null): TopologyNode {
        const id = nodeId(kind, entityId);
        let n = this.nodes.get(id);
        if (!n) {
            n = {
                id,
                kind,
                entityId,
                label: label ?? entityId,
                role: null,
                status: "unknown",
                firstMonoNs: e.mono_ns,
                lastMonoNs: e.mono_ns,
                evidence: [],
                diagnostics: [],
            };
            this.nodes.set(id, n);
        } else if (label && n.label === n.entityId) {
            n.label = label;
        }
        this.cite(n, e);
        return n;
    }

    edge(kind: TopologyEdgeKind, source: string, target: string, e: ObservatoryEvent): TopologyEdge {
        const id = edgeId(kind, source, target);
        let ed = this.edges.get(id);
        if (!ed) {
            ed = {
                id,
                kind,
                source,
                target,
                status: "active",
                count: 0,
                failures: 0,
                tokens: null,
                firstMonoNs: e.mono_ns,
                lastMonoNs: e.mono_ns,
                evidence: [],
            };
            this.edges.set(id, ed);
        }
        this.cite(ed, e);
        const tokens = tokensOf(e);
        if (tokens !== null) {
            ed.tokens = (ed.tokens ?? 0) + tokens;
        }
        return ed;
    }

    cite(target: { evidence: string[]; lastMonoNs: number }, e: ObservatoryEvent): void {
        if (target.evidence[target.evidence.length - 1] !== e.event_id) {
            target.evidence.push(e.event_id);
        }
        target.lastMonoNs = Math.max(target.lastMonoNs, e.mono_ns);
        this.touched = true;
    }

    diagnostic(kind: DiagnosticKind, e: ObservatoryEvent, node: TopologyNode | null): void {
        const d: TopologyDiagnostic = {
            kind,
            eventId: e.event_id,
            eventType: e.event_type,
            monoNs: e.mono_ns,
            nodeId: node ? node.id : null,
        };
        if (node) {
            node.diagnostics.push(d);
            this.cite(node, e);
        } else {
            this.unattached.push(d);
            this.touched = true;
        }
    }

    agent(e: ObservatoryEvent, id: string | null = str(e.agent_id)): TopologyNode | null {
        return id ? this.node("agent", id, e) : null;
    }
}

function setStatus(n: TopologyNode, status: NodeStatus): void {
    n.status = status;
}

function setEdgeStatus(ed: TopologyEdge, status: EdgeStatus): void {
    ed.status = status;
}

function applyAgent(b: GraphBuilder, e: ObservatoryEvent): void {
    const self = b.agent(e);
    const kind = e.event_type;
    if (kind === "agent.message") {
        const to = attr(e, "to_agent_id", "to", "target_agent_id");
        if (self && to) {
            const target = b.node("agent", to, e);
            b.edge("message", self.id, target.id, e).count += 1;
        }
        return;
    }
    if (!self) {
        return;
    }
    const role = attr(e, "role");
    if (role) {
        self.role = role;
    }
    const name = attr(e, "name");
    if (name && self.label === self.entityId) {
        self.label = name;
    }
    switch (kind) {
        case "agent.spawned": {
            if (self.status === "unknown") {
                setStatus(self, "pending");
            }
            const parent = attr(e, "parent", "parent_agent_id");
            if (parent) {
                const p = b.node("agent", parent, e);
                b.edge("delegation", p.id, self.id, e).count += 1;
            }
            break;
        }
        case "agent.started":
            setStatus(self, "active");
            break;
        case "agent.completed":
            setStatus(self, "completed");
            break;
        case "agent.cancelled":
            setStatus(self, "cancelled");
            break;
        default:
            if (kind.endsWith(".failed")) {
                setStatus(self, "failed");
                b.diagnostic("failure", e, self);
            }
    }
}

function applyRoute(b: GraphBuilder, e: ObservatoryEvent): void {
    const model = envelopeOrAttr(e, "model_instance_id", "to_model");
    const agent = model ? b.agent(e) : null;
    if (!agent || !model) {
        return;
    }
    const modelNode = b.node("model", model, e);
    const edge = b.edge("route", agent.id, modelNode.id, e);
    edge.count += 1;
    const previous = b.activeRoute.get(agent.id);
    if (previous && previous !== edge.id) {
        const prevEdge = b.edges.get(previous);
        if (prevEdge) {
            setEdgeStatus(prevEdge, "superseded");
            b.cite(prevEdge, e);
        }
    }
    setEdgeStatus(edge, "active");
    b.activeRoute.set(agent.id, edge.id);
    if (e.event_type === "route.changed") {
        const from = attr(e, "from_model", "previous_model_instance_id");
        if (from && from !== model) {
            const fromNode = b.node("model", from, e);
            b.edge("route_change", fromNode.id, modelNode.id, e).count += 1;
        }
    }
}

function applyModel(b: GraphBuilder, e: ObservatoryEvent): void {
    const id = str(e.model_instance_id);
    if (!id) {
        return;
    }
    const n = b.node("model", id, e, attr(e, "model"));
    if (e.event_type === "model.load.started") {
        setStatus(n, "loading");
    } else if (e.event_type === "model.load.completed") {
        setStatus(n, "active");
    } else if (e.event_type === "model.unload") {
        setStatus(n, "unloaded");
    }
}

function toolCallId(e: ObservatoryEvent): string | null {
    return str(e.tool_call_id) ?? attr(e, "tool_call_id");
}

function applyTool(b: GraphBuilder, e: ObservatoryEvent): void {
    const callId = toolCallId(e);
    const known = callId ? b.toolCalls.get(callId) : undefined;
    const name = attr(e, "tool", "tool_name");
    if (e.event_type === "tool.called") {
        if (!name) {
            return;
        }
        const agent = b.agent(e);
        const tool = b.node("tool", name, e);
        setStatus(tool, "active");
        let edge: TopologyEdge | null = null;
        if (agent) {
            edge = b.edge("tool_call", agent.id, tool.id, e);
            edge.count += 1;
            setEdgeStatus(edge, "active");
        }
        if (callId) {
            b.toolCalls.set(callId, { agentNode: agent ? agent.id : null, toolNode: tool.id, edge: edge ? edge.id : null });
        }
        return;
    }
    // completion/failure: resolve through the call id, or an explicit tool name
    let toolNode: TopologyNode | undefined;
    let edge: TopologyEdge | undefined;
    if (known) {
        toolNode = b.nodes.get(known.toolNode);
        edge = known.edge ? b.edges.get(known.edge) : undefined;
    } else if (name) {
        toolNode = b.node("tool", name, e);
        const agent = b.agent(e);
        if (agent) {
            edge = b.edge("tool_call", agent.id, toolNode.id, e);
        }
    }
    if (!toolNode) {
        return;
    }
    b.cite(toolNode, e);
    if (edge) {
        b.cite(edge, e);
    }
    const failed = e.event_type === "tool.failed";
    if (e.event_type === "tool.completed" || failed) {
        setStatus(toolNode, failed ? "failed" : "completed");
        if (edge) {
            setEdgeStatus(edge, failed ? "failed" : "ok");
            if (failed) {
                edge.failures += 1;
            }
        }
        if (failed) {
            b.diagnostic("failure", e, toolNode);
        }
    }
}

function applyMemory(b: GraphBuilder, e: ObservatoryEvent): void {
    const store = attr(e, "store", "memory_store", "store_id");
    if (!store) {
        // Attach to the agent if possible; never invent a store node.
        const agent = b.agent(e);
        if (agent) {
            b.cite(agent, e);
        }
        return;
    }
    const mem = b.node("memory", store, e);
    const agent = b.agent(e);
    const started = e.event_type === "memory.retrieval.started";
    setStatus(mem, started ? "active" : e.event_type.endsWith(".failed") ? "failed" : "completed");
    if (agent) {
        const edge = b.edge("memory_retrieval", agent.id, mem.id, e);
        if (started) {
            edge.count += 1;
            setEdgeStatus(edge, "active");
        } else if (e.event_type.endsWith(".failed")) {
            edge.failures += 1;
            setEdgeStatus(edge, "failed");
        } else {
            if (edge.count === 0) {
                edge.count = 1;
            }
            setEdgeStatus(edge, "ok");
        }
    }
}

function applyContext(b: GraphBuilder, e: ObservatoryEvent): void {
    const from = str(e.agent_id) ?? attr(e, "from_agent_id", "source_agent_id");
    const to = attr(e, "to_agent_id", "target_agent_id");
    if (!from || !to) {
        return;
    }
    const source = b.node("agent", from, e);
    const target = b.node("agent", to, e);
    b.edge("context_transfer", source.id, target.id, e).count += 1;
}

function applyRetry(b: GraphBuilder, e: ObservatoryEvent): void {
    const agent = b.agent(e);
    const callId = toolCallId(e);
    const call = callId ? b.toolCalls.get(callId) : undefined;
    const targetAgent = attr(e, "target_agent_id");
    b.diagnostic("retry", e, agent);
    if (agent && call) {
        b.edge("retry", agent.id, call.toolNode, e).count += 1;
        const tool = b.nodes.get(call.toolNode);
        if (tool) {
            b.diagnostic("retry", e, tool);
        }
    } else if (agent && targetAgent) {
        const t = b.node("agent", targetAgent, e);
        b.edge("retry", agent.id, t.id, e).count += 1;
    }
}

function applyRecovery(b: GraphBuilder, e: ObservatoryEvent): void {
    const agent = b.agent(e);
    b.diagnostic("recovery", e, agent);
    if (!agent) {
        return;
    }
    const targetAgent = attr(e, "target_agent_id");
    const targetModel = attr(e, "target_model");
    const callId = toolCallId(e);
    const call = callId ? b.toolCalls.get(callId) : undefined;
    let target: TopologyNode | undefined;
    if (targetAgent) {
        target = b.node("agent", targetAgent, e);
    } else if (targetModel) {
        target = b.node("model", targetModel, e);
    } else if (call) {
        target = b.nodes.get(call.toolNode);
    }
    if (target) {
        b.edge("recovery", agent.id, target.id, e).count += 1;
    }
}

const GUARD_KINDS: Record<string, DiagnosticKind> = {
    "guard.no_progress": "no_progress",
    "guard.duplicate_work": "duplicate_work",
    "guard.budget_pressure": "budget_pressure",
};

function applyGuard(b: GraphBuilder, e: ObservatoryEvent): void {
    b.diagnostic(GUARD_KINDS[e.event_type] ?? "guard", e, b.agent(e));
}

function applyEvent(b: GraphBuilder, e: ObservatoryEvent): void {
    const t = e.event_type;
    if (t.startsWith("agent.")) {
        applyAgent(b, e);
    } else if (t.startsWith("route.")) {
        applyRoute(b, e);
    } else if (t.startsWith("model.")) {
        applyModel(b, e);
    } else if (t.startsWith("tool.")) {
        applyTool(b, e);
    } else if (t.startsWith("memory.retrieval.")) {
        applyMemory(b, e);
    } else if (t === "context.forked") {
        applyContext(b, e);
    } else if (t === "retry.scheduled") {
        applyRetry(b, e);
    } else if (t === "recovery.action") {
        applyRecovery(b, e);
    } else if (t.startsWith("guard.")) {
        applyGuard(b, e);
    }
}

/**
 * Builds the topology graph as of `options.atMonoNs` (inclusive) or for all
 * events. Input order does not matter: events are deduplicated by event_id
 * and replayed in the shared replay order (mono_ns, sequence, event_id).
 * Does not mutate the input.
 */
export function deriveTopology(events: readonly ObservatoryEvent[], options: DeriveOptions = {}): TopologyGraph {
    const at = options.atMonoNs ?? null;
    const ordered = orderEvents(events).events;
    const b = new GraphBuilder();
    let considered = 0;
    for (const e of ordered) {
        if (at !== null && e.mono_ns > at) {
            break;
        }
        considered += 1;
        if (!isTopologyEvent(e.event_type)) {
            continue;
        }
        b.begin();
        applyEvent(b, e);
        b.end(e);
    }
    const byFirstSeen = <T extends { firstMonoNs: number; id: string }>(x: T, y: T): number =>
        x.firstMonoNs - y.firstMonoNs || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
    return {
        nodes: [...b.nodes.values()].sort(byFirstSeen),
        edges: [...b.edges.values()].sort(byFirstSeen),
        unattachedDiagnostics: b.unattached,
        atMonoNs: at,
        consideredEvents: considered,
        mappedEvents: b.mapped,
        unmappedEventIds: b.unmapped,
    };
}

/** All diagnostics (node-attached and unattached), in time order. */
export function allDiagnostics(graph: TopologyGraph): TopologyDiagnostic[] {
    const seen = new Set<string>();
    const out: TopologyDiagnostic[] = [];
    for (const d of [...graph.nodes.flatMap((n) => n.diagnostics), ...graph.unattachedDiagnostics]) {
        const key = `${d.eventId}\u0000${d.nodeId ?? ""}`;
        if (!seen.has(key)) {
            seen.add(key);
            out.push(d);
        }
    }
    return out.sort((a, b) => a.monoNs - b.monoNs || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
}

/** Evidence event ids for a selected node or edge (empty if the id is not in the graph). */
export function evidenceFor(graph: TopologyGraph, selection: { kind: "node" | "edge"; id: string }): string[] {
    const item =
        selection.kind === "node"
            ? graph.nodes.find((n) => n.id === selection.id)
            : graph.edges.find((ed) => ed.id === selection.id);
    return item ? [...item.evidence] : [];
}

/** True when the selection still resolves in `graph` (keep selection while scrubbing). */
export function selectionValid(graph: TopologyGraph, selection: { kind: "node" | "edge"; id: string } | null): boolean {
    return selection !== null && evidenceFor(graph, selection).length > 0;
}
