import type { TopologyGraph, TopologyNode, TopologyNodeKind } from "./model";

/**
 * Deterministic layered layout, no dependencies.
 *
 * Columns (left to right): agents by delegation depth (roots first), then
 * model instances, tools and memory stores. Within a column nodes are ordered
 * by first appearance. Positions only encode column membership and first-seen
 * order; they carry no other meaning (shown in the legend).
 *
 * For replay, compute the layout once from the full-session graph and reuse it
 * for every scrub position so nodes do not jump while scrubbing.
 */

export interface Point {
    x: number;
    y: number;
}

export interface TopologyLayout {
    positions: Map<string, Point>;
    width: number;
    height: number;
    columns: { label: string; x: number }[];
}

export interface LayoutOptions {
    columnGap?: number;
    rowGap?: number;
    margin?: number;
}

const TAIL_KINDS: readonly TopologyNodeKind[] = ["model", "tool", "memory"];
const TAIL_LABELS: Record<string, string> = { model: "Models", tool: "Tools", memory: "Memory" };

/** Delegation depth for each agent node (roots = 0). Cycles are broken by first-seen order. */
export function agentDepths(graph: TopologyGraph): Map<string, number> {
    const agents = graph.nodes.filter((n) => n.kind === "agent");
    const children = new Map<string, string[]>();
    const hasParent = new Set<string>();
    for (const e of graph.edges) {
        if (e.kind !== "delegation") {
            continue;
        }
        const list = children.get(e.source) ?? [];
        list.push(e.target);
        children.set(e.source, list);
        hasParent.add(e.target);
    }
    const depth = new Map<string, number>();
    const queue: string[] = [];
    for (const a of agents) {
        if (!hasParent.has(a.id)) {
            depth.set(a.id, 0);
            queue.push(a.id);
        }
    }
    const visit = (): void => {
        while (queue.length > 0) {
            const id = queue.shift()!;
            const d = depth.get(id)!;
            for (const c of children.get(id) ?? []) {
                if (!depth.has(c)) {
                    depth.set(c, d + 1);
                    queue.push(c);
                }
            }
        }
    };
    visit();
    // Agents only reachable through a delegation cycle.
    for (const a of agents) {
        if (!depth.has(a.id)) {
            depth.set(a.id, 0);
            queue.push(a.id);
            visit();
        }
    }
    return depth;
}

export function layoutTopology(graph: TopologyGraph, options: LayoutOptions = {}): TopologyLayout {
    const columnGap = options.columnGap ?? 180;
    const rowGap = options.rowGap ?? 84;
    const margin = options.margin ?? 60;

    const depths = agentDepths(graph);
    const maxDepth = Math.max(-1, ...depths.values());
    const columnsNodes: { label: string; nodes: TopologyNode[] }[] = [];
    for (let d = 0; d <= maxDepth; d += 1) {
        columnsNodes.push({ label: d === 0 ? "Agents" : `Agents (depth ${d})`, nodes: [] });
    }
    const tailIndex = new Map<TopologyNodeKind, number>();
    for (const kind of TAIL_KINDS) {
        if (graph.nodes.some((n) => n.kind === kind)) {
            tailIndex.set(kind, columnsNodes.length);
            columnsNodes.push({ label: TAIL_LABELS[kind] ?? kind, nodes: [] });
        }
    }
    // graph.nodes is already in first-seen order
    for (const n of graph.nodes) {
        const col = n.kind === "agent" ? depths.get(n.id) ?? 0 : tailIndex.get(n.kind);
        if (col !== undefined) {
            columnsNodes[col]!.nodes.push(n);
        }
    }

    const tallest = Math.max(1, ...columnsNodes.map((c) => c.nodes.length));
    const height = margin * 2 + (tallest - 1) * rowGap;
    const width = margin * 2 + Math.max(0, columnsNodes.length - 1) * columnGap;
    const positions = new Map<string, Point>();
    const columns: { label: string; x: number }[] = [];
    columnsNodes.forEach((col, i) => {
        const x = margin + i * columnGap;
        columns.push({ label: col.label, x });
        const offset = ((tallest - col.nodes.length) * rowGap) / 2;
        col.nodes.forEach((n, j) => positions.set(n.id, { x, y: margin + offset + j * rowGap }));
    });
    return { positions, width, height, columns };
}
