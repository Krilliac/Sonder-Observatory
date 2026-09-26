import type { TopologyLayout } from "./layout";
import {
    TOPOLOGY_EDGE_KINDS,
    TOPOLOGY_NODE_KINDS,
    type EdgeStatus,
    type NodeStatus,
    type TopologyEdgeKind,
    type TopologyGraph,
    type TopologyNodeKind,
    type TopologySelection,
} from "./model";

/**
 * DOM-free scene description for the topology renderer. Kept pure so the
 * visual encoding (and its legend) is unit-testable in the Node test env.
 *
 * Encoding (UX.md: state is never communicated by colour alone):
 * - node shape  -> entity kind (agent circle, model square, tool diamond, memory hexagon)
 * - node colour -> entity kind; outline dash + text badge -> status
 * - node size   -> log of evidence event count (how much telemetry mentions it)
 * - edge colour + dash pattern -> relationship kind
 * - edge width  -> log of reported tokens if any, else interaction count
 * - opacity     -> recency relative to the replay cursor (active entities stay opaque)
 */

export type NodeShape = "circle" | "square" | "diamond" | "hexagon";

export const NODE_STYLE: Record<TopologyNodeKind, { shape: NodeShape; color: string; label: string }> = {
    agent: { shape: "circle", color: "var(--color-primary, #3B82F6)", label: "Agent" },
    model: { shape: "square", color: "var(--color-purple, #A855F7)", label: "Model instance" },
    tool: { shape: "diamond", color: "var(--color-cyan, #22D3EE)", label: "Tool" },
    memory: { shape: "hexagon", color: "var(--color-success, #10B981)", label: "Memory store" },
};

export const EDGE_STYLE: Record<TopologyEdgeKind, { color: string; dash: string; label: string }> = {
    delegation: { color: "var(--color-primary, #3B82F6)", dash: "", label: "Delegation (agent.spawned parent)" },
    route: { color: "var(--color-purple, #A855F7)", dash: "", label: "Route (route.selected/changed)" },
    route_change: { color: "var(--color-purple, #A855F7)", dash: "2 4", label: "Model change (route.changed from→to)" },
    context_transfer: { color: "var(--color-cyan, #22D3EE)", dash: "8 3", label: "Context transfer (context.forked)" },
    message: { color: "var(--muted, #94A3B8)", dash: "4 3", label: "Message (agent.message)" },
    tool_call: { color: "var(--color-cyan, #22D3EE)", dash: "", label: "Tool call (tool.*)" },
    memory_retrieval: { color: "var(--color-success, #10B981)", dash: "", label: "Memory retrieval (memory.retrieval.*)" },
    retry: { color: "var(--color-warning, #F59E0B)", dash: "6 3", label: "Retry (retry.scheduled)" },
    recovery: { color: "var(--color-warning, #F59E0B)", dash: "1 3", label: "Recovery (recovery.action)" },
};

export const STATUS_STYLE: Record<NodeStatus, { badge: string; dash: string; stroke: string }> = {
    pending: { badge: "…", dash: "3 3", stroke: "var(--muted, #94A3B8)" },
    active: { badge: "●", dash: "", stroke: "var(--color-success, #10B981)" },
    completed: { badge: "✓", dash: "", stroke: "var(--color-border, #24334A)" },
    failed: { badge: "!", dash: "4 2", stroke: "var(--color-error, #EF4444)" },
    cancelled: { badge: "×", dash: "2 2", stroke: "var(--muted, #94A3B8)" },
    loading: { badge: "↻", dash: "3 3", stroke: "var(--color-warning, #F59E0B)" },
    unloaded: { badge: "○", dash: "2 4", stroke: "var(--muted, #94A3B8)" },
    unknown: { badge: "?", dash: "1 3", stroke: "var(--muted, #94A3B8)" },
};

export interface SceneNode {
    id: string;
    kind: TopologyNodeKind;
    shape: NodeShape;
    x: number;
    y: number;
    r: number;
    fill: string;
    stroke: string;
    dash: string;
    opacity: number;
    label: string;
    sublabel: string;
    badge: string;
    /** Number of diagnostics (retry/guard/failure...) attached; drawn as a warning marker. */
    diagnosticCount: number;
    selected: boolean;
    ariaLabel: string;
}

export interface SceneEdge {
    id: string;
    kind: TopologyEdgeKind;
    /** SVG path data. */
    path: string;
    labelX: number;
    labelY: number;
    color: string;
    dash: string;
    width: number;
    opacity: number;
    status: EdgeStatus;
    label: string;
    selected: boolean;
    ariaLabel: string;
}

export interface LegendEntry {
    group: "node" | "edge" | "status" | "mapping";
    key: string;
    label: string;
    color?: string;
    dash?: string;
    shape?: NodeShape;
    badge?: string;
}

export interface TopologyScene {
    width: number;
    height: number;
    nodes: SceneNode[];
    edges: SceneEdge[];
    columns: { label: string; x: number }[];
    legend: LegendEntry[];
    /** Graph nodes that had no layout position (layout computed from other events). */
    unplacedNodeIds: string[];
}

export interface SceneOptions {
    selection?: TopologySelection | null;
    /** Replay cursor; defaults to graph.atMonoNs, or the latest evidence time. */
    atMonoNs?: number | null;
    /** Recency window for opacity fade, ns. Default 10 s. */
    fadeWindowNs?: number;
}

const MIN_OPACITY = 0.45;

function recency(lastMonoNs: number, at: number, windowNs: number, active: boolean): number {
    if (active) {
        return 1;
    }
    const age = Math.max(0, at - lastMonoNs);
    return Math.max(MIN_OPACITY, 1 - (age / windowNs) * (1 - MIN_OPACITY));
}

function round(v: number): number {
    return Math.round(v * 10) / 10;
}

export function buildScene(graph: TopologyGraph, layout: TopologyLayout, options: SceneOptions = {}): TopologyScene {
    const selection = options.selection ?? null;
    const windowNs = options.fadeWindowNs ?? 10_000_000_000;
    const latest = Math.max(0, ...graph.nodes.map((n) => n.lastMonoNs), ...graph.edges.map((e) => e.lastMonoNs));
    const at = options.atMonoNs ?? graph.atMonoNs ?? latest;

    const nodes: SceneNode[] = [];
    const unplaced: string[] = [];
    const radius = new Map<string, number>();
    for (const n of graph.nodes) {
        const p = layout.positions.get(n.id);
        if (!p) {
            unplaced.push(n.id);
            continue;
        }
        const style = NODE_STYLE[n.kind];
        const status = STATUS_STYLE[n.status];
        const r = round(16 + Math.min(12, 3 * Math.log2(n.evidence.length)));
        radius.set(n.id, r);
        const sub = [n.role, n.status].filter(Boolean).join(" · ");
        nodes.push({
            id: n.id,
            kind: n.kind,
            shape: style.shape,
            x: p.x,
            y: p.y,
            r,
            fill: style.color,
            stroke: status.stroke,
            dash: status.dash,
            opacity: round(recency(n.lastMonoNs, at, windowNs, n.status === "active" || n.status === "loading")),
            label: n.label,
            sublabel: sub,
            badge: status.badge,
            diagnosticCount: n.diagnostics.length,
            selected: selection?.kind === "node" && selection.id === n.id,
            ariaLabel: `${style.label} ${n.label}, ${n.role ? `role ${n.role}, ` : ""}status ${n.status}, ${n.evidence.length} evidence events${
                n.diagnostics.length ? `, ${n.diagnostics.length} diagnostics` : ""
            }`,
        });
    }

    // Parallel edges between the same pair get separate curvature lanes.
    const lanes = new Map<string, number>();
    const edges: SceneEdge[] = [];
    for (const e of graph.edges) {
        const a = layout.positions.get(e.source);
        const b = layout.positions.get(e.target);
        if (!a || !b) {
            continue;
        }
        const pairKey = e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`;
        const lane = lanes.get(pairKey) ?? 0;
        lanes.set(pairKey, lane + 1);
        const style = EDGE_STYLE[e.kind];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const ra = radius.get(e.source) ?? 16;
        const rb = (radius.get(e.target) ?? 16) + 4;
        const sx = a.x + ux * ra;
        const sy = a.y + uy * ra;
        const tx = b.x - ux * rb;
        const ty = b.y - uy * rb;
        // alternate sides: 0, +1, -1, +2, -2 ...
        const side = lane === 0 ? 0 : (lane % 2 === 1 ? 1 : -1) * Math.ceil(lane / 2);
        const bend = side * 28 + (Math.abs(dy) < 1 && lane === 0 && len > 200 ? 24 : 0);
        const mx = (sx + tx) / 2 - uy * bend;
        const my = (sy + ty) / 2 + ux * bend;
        const magnitude = e.tokens !== null ? Math.log10(1 + e.tokens) : Math.log2(1 + Math.max(1, e.count));
        const width = round(Math.min(7, 1.25 + magnitude));
        const qualifier = e.tokens !== null ? `${e.tokens} tokens` : `${e.count}×`;
        edges.push({
            id: e.id,
            kind: e.kind,
            path: `M${round(sx)},${round(sy)} Q${round(mx)},${round(my)} ${round(tx)},${round(ty)}`,
            labelX: round((sx + 2 * mx + tx) / 4),
            labelY: round((sy + 2 * my + ty) / 4),
            color: e.status === "failed" ? "var(--color-error, #EF4444)" : style.color,
            dash: style.dash,
            width,
            opacity: round(e.status === "superseded" ? MIN_OPACITY : recency(e.lastMonoNs, at, windowNs, e.status === "active")),
            status: e.status,
            label: `${e.kind.replace("_", " ")} ${qualifier}${e.failures ? ` · ${e.failures} failed` : ""}${
                e.status === "superseded" ? " · superseded" : ""
            }`,
            selected: selection?.kind === "edge" && selection.id === e.id,
            ariaLabel: `${style.label} from ${e.source} to ${e.target}, status ${e.status}, ${qualifier}, ${e.evidence.length} evidence events`,
        });
    }

    return {
        width: layout.width,
        height: layout.height,
        nodes,
        edges,
        columns: layout.columns,
        legend: buildLegend(graph),
        unplacedNodeIds: unplaced,
    };
}

/** Legend entries for kinds/statuses present in the graph plus the fixed mappings. */
export function buildLegend(graph: TopologyGraph): LegendEntry[] {
    const nodeKinds = new Set(graph.nodes.map((n) => n.kind));
    const edgeKinds = new Set(graph.edges.map((e) => e.kind));
    const statuses = new Set(graph.nodes.map((n) => n.status));
    const out: LegendEntry[] = [];
    for (const k of TOPOLOGY_NODE_KINDS) {
        if (nodeKinds.has(k)) {
            out.push({ group: "node", key: k, label: NODE_STYLE[k].label, color: NODE_STYLE[k].color, shape: NODE_STYLE[k].shape });
        }
    }
    for (const k of TOPOLOGY_EDGE_KINDS) {
        if (edgeKinds.has(k)) {
            out.push({ group: "edge", key: k, label: EDGE_STYLE[k].label, color: EDGE_STYLE[k].color, dash: EDGE_STYLE[k].dash });
        }
    }
    for (const s of Object.keys(STATUS_STYLE) as NodeStatus[]) {
        if (statuses.has(s)) {
            out.push({ group: "status", key: s, label: s, badge: STATUS_STYLE[s].badge, dash: STATUS_STYLE[s].dash, color: STATUS_STYLE[s].stroke });
        }
    }
    out.push(
        { group: "mapping", key: "size", label: "Node size: log of evidence event count" },
        { group: "mapping", key: "width", label: "Edge width: log of reported tokens, else interaction count" },
        { group: "mapping", key: "opacity", label: "Opacity: recency at replay cursor (active = opaque)" },
        { group: "mapping", key: "position", label: "Columns: agents by delegation depth, then models, tools, memory; rows: first seen" },
        { group: "mapping", key: "marker", label: "⚠ n: retry / recovery / guard / failure diagnostics on the node" },
    );
    return out;
}

/** SVG polygon/path for a node shape centred at (x, y). */
export function shapePath(shape: NodeShape, x: number, y: number, r: number): string {
    const pts = (count: number, rot: number): string =>
        Array.from({ length: count }, (_, i) => {
            const a = rot + (i * 2 * Math.PI) / count;
            return `${round(x + r * Math.cos(a))},${round(y + r * Math.sin(a))}`;
        }).join(" ");
    switch (shape) {
        case "circle":
            return `M${round(x - r)},${y} a${r},${r} 0 1,0 ${round(2 * r)},0 a${r},${r} 0 1,0 ${round(-2 * r)},0 Z`;
        case "square": {
            const s = round(r * 0.88);
            return `M${round(x - s)},${round(y - s)} H${round(x + s)} V${round(y + s)} H${round(x - s)} Z`;
        }
        case "diamond":
            return `M${pts(4, -Math.PI / 2).split(" ").join(" L")} Z`;
        case "hexagon":
            return `M${pts(6, 0).split(" ").join(" L")} Z`;
    }
}
