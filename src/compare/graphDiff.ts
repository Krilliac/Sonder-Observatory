/**
 * Agent/tool call graph diff over the topology data model (src/topology).
 *
 * Node and edge ids are built from producer entity ids (`agent:<id>`,
 * `tool:<name>`, `tool_call:<src>-><dst>`...), so the same entity in two
 * sessions has the same id. Added = only in B, removed = only in A, changed =
 * in both with a different status, interaction count or failure count.
 */
import type { EdgeStatus, NodeStatus, TopologyEdge, TopologyGraph, TopologyNode } from "../topology";

export interface NodeChange {
    id: string;
    a: TopologyNode;
    b: TopologyNode;
    status: { a: NodeStatus; b: NodeStatus } | null;
}

export interface EdgeChange {
    id: string;
    a: TopologyEdge;
    b: TopologyEdge;
    status: { a: EdgeStatus; b: EdgeStatus } | null;
    /** b.count - a.count */
    countDelta: number;
    /** b.failures - a.failures */
    failuresDelta: number;
}

export interface GraphDiff {
    addedNodes: TopologyNode[];
    removedNodes: TopologyNode[];
    changedNodes: NodeChange[];
    addedEdges: TopologyEdge[];
    removedEdges: TopologyEdge[];
    changedEdges: EdgeChange[];
    unchangedNodes: number;
    unchangedEdges: number;
}

const byId = <T extends { id: string }>(items: readonly T[]) => new Map(items.map((x) => [x.id, x]));
const idOrder = (x: { id: string }, y: { id: string }) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

export function diffGraphs(a: TopologyGraph, b: TopologyGraph): GraphDiff {
    const an = byId(a.nodes);
    const bn = byId(b.nodes);
    const ae = byId(a.edges);
    const be = byId(b.edges);
    const out: GraphDiff = {
        addedNodes: b.nodes.filter((n) => !an.has(n.id)).sort(idOrder),
        removedNodes: a.nodes.filter((n) => !bn.has(n.id)).sort(idOrder),
        changedNodes: [],
        addedEdges: b.edges.filter((e) => !ae.has(e.id)).sort(idOrder),
        removedEdges: a.edges.filter((e) => !be.has(e.id)).sort(idOrder),
        changedEdges: [],
        unchangedNodes: 0,
        unchangedEdges: 0,
    };
    for (const na of [...a.nodes].sort(idOrder)) {
        const nb = bn.get(na.id);
        if (!nb) {
            continue;
        }
        if (na.status !== nb.status) {
            out.changedNodes.push({ id: na.id, a: na, b: nb, status: { a: na.status, b: nb.status } });
        } else {
            out.unchangedNodes += 1;
        }
    }
    for (const ea of [...a.edges].sort(idOrder)) {
        const eb = be.get(ea.id);
        if (!eb) {
            continue;
        }
        const status = ea.status !== eb.status ? { a: ea.status, b: eb.status } : null;
        const countDelta = eb.count - ea.count;
        const failuresDelta = eb.failures - ea.failures;
        if (status || countDelta !== 0 || failuresDelta !== 0) {
            out.changedEdges.push({ id: ea.id, a: ea, b: eb, status, countDelta, failuresDelta });
        } else {
            out.unchangedEdges += 1;
        }
    }
    return out;
}
