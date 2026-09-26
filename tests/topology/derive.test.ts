import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateEvent } from "../../src/protocol/validate";
import { parseNdjson } from "../../src/recording/ndjson";
import { isSyntheticProducer } from "../../src/recording/sobs";
import { allDiagnostics, deriveTopology, evidenceFor, isTopologyEvent, selectionValid } from "../../src/topology/derive";
import { topologyFixtureEvents, topologyFixtureTime } from "../../src/topology/fixtures/topology-synthetic";
import type { TopologyGraph } from "../../src/topology/model";
import { at } from "../helpers";

const root = fileURLToPath(new URL("../..", import.meta.url));
const m1Events = parseNdjson(readFileSync(join(root, "fixtures/synthetic-session.ndjson"), "utf8")).events;

function node(g: TopologyGraph, id: string) {
    const n = g.nodes.find((x) => x.id === id);
    if (!n) {
        throw new Error(`missing node ${id}; have ${g.nodes.map((x) => x.id).join(", ")}`);
    }
    return n;
}

function edge(g: TopologyGraph, id: string) {
    const e = g.edges.find((x) => x.id === id);
    if (!e) {
        throw new Error(`missing edge ${id}; have ${g.edges.map((x) => x.id).join(", ")}`);
    }
    return e;
}

/** Every drawable item must resolve to real input events (grounded visuals). */
function expectGrounded(g: TopologyGraph, events: { event_id: string }[]): void {
    const ids = new Set(events.map((e) => e.event_id));
    for (const item of [...g.nodes, ...g.edges]) {
        expect(item.evidence.length, item.id).toBeGreaterThan(0);
        for (const id of item.evidence) {
            expect(ids.has(id), `${item.id} cites unknown ${id}`).toBe(true);
        }
    }
    for (const d of allDiagnostics(g)) {
        expect(ids.has(d.eventId)).toBe(true);
    }
    for (const e of g.edges) {
        expect(g.nodes.some((n) => n.id === e.source), e.id).toBe(true);
        expect(g.nodes.some((n) => n.id === e.target), e.id).toBe(true);
    }
}

describe("topology fixture", () => {
    const events = topologyFixtureEvents();
    it("is schema-valid and labelled synthetic", () => {
        for (const e of events) {
            expect(validateEvent(e).ok, e.event_id).toBe(true);
            expect(isSyntheticProducer(e.producer)).toBe(true);
            expect(e.attributes.synthetic).toBe(true);
        }
    });
});

describe("deriveTopology on the M1 synthetic fixture", () => {
    const g = deriveTopology(m1Events);

    it("builds owner -> worker/critic delegation, routes and tools", () => {
        expect(g.nodes.filter((n) => n.kind === "agent").map((n) => n.entityId).sort()).toEqual(["agt_critic", "agt_owner", "agt_worker_1"]);
        expect(edge(g, "delegation:agent:agt_owner->agent:agt_worker_1").evidence).toEqual(["evt_syn_000127"]);
        expect(edge(g, "delegation:agent:agt_owner->agent:agt_critic").count).toBe(1);
        expect(edge(g, "route:agent:agt_owner->model:mdl_synthetic_7b_q4").status).toBe("active");
        expect(node(g, "model:mdl_synthetic_7b_q4").label).toBe("synthetic-7b");
        expect(node(g, "agent:agt_worker_1").role).toBe("worker");
        expect(node(g, "agent:agt_owner").status).toBe("completed");
    });

    it("correlates tool completion/failure by tool_call_id and links the retry", () => {
        const fetch = edge(g, "tool_call:agent:agt_worker_1->tool:synthetic.fetch");
        expect(fetch.count).toBe(2);
        expect(fetch.failures).toBe(1);
        expect(fetch.status).toBe("ok");
        expect(fetch.evidence).toEqual(["evt_syn_000330", "evt_syn_000335", "evt_syn_000337", "evt_syn_000340"]);
        const retry = edge(g, "retry:agent:agt_worker_1->tool:synthetic.fetch");
        expect(retry.evidence).toEqual(["evt_syn_000336"]);
        expect(node(g, "tool:synthetic.fetch").diagnostics.map((d) => d.kind)).toEqual(["failure", "retry"]);
    });

    it("attaches the budget guard to the owner agent", () => {
        const owner = node(g, "agent:agt_owner");
        expect(owner.diagnostics.map((d) => [d.kind, d.eventId])).toContainEqual(["budget_pressure", "evt_syn_000516"]);
    });

    it("ignores non-orchestration events and grounds everything", () => {
        expect(g.consideredEvents).toBe(m1Events.length);
        expect(g.mappedEvents).toBe(m1Events.filter((e) => isTopologyEvent(e.event_type)).length);
        expect(g.unmappedEventIds).toEqual([]);
        expectGrounded(g, m1Events);
    });
});

describe("deriveTopology on the topology fixture", () => {
    const events = topologyFixtureEvents();
    const g = deriveTopology(events);

    it("derives context transfer and messages with tokens", () => {
        const ctx = edge(g, "context_transfer:agent:agt_owner->agent:agt_research");
        expect(ctx.tokens).toBe(1200);
        expect(ctx.evidence).toHaveLength(1);
        expect(edge(g, "message:agent:agt_research->agent:agt_owner").tokens).toBe(300);
    });

    it("derives memory nodes and retrieval edges", () => {
        const mem = node(g, "memory:project-notes");
        expect(mem.status).toBe("completed");
        const e = edge(g, "memory_retrieval:agent:agt_research->memory:project-notes");
        expect(e.count).toBe(1);
        expect(e.tokens).toBe(640);
        expect(e.status).toBe("ok");
    });

    it("tracks route changes: supersedes the old route and adds a model-change edge", () => {
        expect(edge(g, "route:agent:agt_research->model:mdl_syn_small").status).toBe("superseded");
        expect(edge(g, "route:agent:agt_research->model:mdl_syn_large").status).toBe("active");
        expect(edge(g, "route_change:model:mdl_syn_small->model:mdl_syn_large").evidence).toEqual(["evt_topo_0021"]);
        expect(edge(g, "recovery:agent:agt_research->model:mdl_syn_large").count).toBe(1);
    });

    it("records retry, no-progress, duplicate-work, recovery and unattached budget diagnostics", () => {
        expect(node(g, "agent:agt_research").diagnostics.map((d) => d.kind)).toEqual(["retry", "no_progress", "recovery"]);
        expect(node(g, "agent:agt_critic").diagnostics.map((d) => d.kind)).toEqual(["duplicate_work"]);
        expect(node(g, "agent:agt_critic").status).toBe("cancelled");
        expect(g.unattachedDiagnostics.map((d) => d.kind)).toEqual(["budget_pressure"]);
        const search = edge(g, "tool_call:agent:agt_research->tool:synthetic.search");
        expect([search.count, search.failures, search.status]).toEqual([2, 2, "failed"]);
    });

    it("does not invent a node for a completion with an unknown call id and no tool name", () => {
        expect(g.unmappedEventIds).toEqual(["evt_topo_0033"]);
        expect(g.nodes.some((n) => n.entityId === "tc_unknown")).toBe(false);
    });

    it("grounds every node and edge in input events", () => {
        expectGrounded(g, events);
    });

    it("is independent of input order and duplicate deliveries", () => {
        const shuffled = [...events].reverse();
        const dup = [...events, ...events.slice(0, 5)];
        expect(deriveTopology(shuffled)).toEqual(g);
        expect(deriveTopology(dup)).toEqual(g);
    });

    it("does not mutate its input", () => {
        const copy = JSON.parse(JSON.stringify(events));
        deriveTopology(events);
        expect(events).toEqual(copy);
    });
});

describe("time scrub", () => {
    const events = topologyFixtureEvents();

    it("returns the graph as of the replay cursor", () => {
        const early = deriveTopology(events, { atMonoNs: topologyFixtureTime(210) });
        expect(early.atMonoNs).toBe(topologyFixtureTime(210));
        expect(early.nodes.map((n) => n.id)).toEqual(["model:mdl_syn_small", "agent:agt_owner", "agent:agt_research"]);
        expect(node(early, "agent:agt_research").status).toBe("active");
        expect(early.edges.some((e) => e.kind === "tool_call")).toBe(false);

        const mid = deriveTopology(events, { atMonoNs: topologyFixtureTime(600) });
        expect(node(mid, "tool:synthetic.search").status).toBe("active");
        expect(edge(mid, "route:agent:agt_research->model:mdl_syn_small").status).toBe("active");
        expect(mid.nodes.some((n) => n.id === "model:mdl_syn_large")).toBe(false);
    });

    it("is inclusive at the cursor and monotone in evidence", () => {
        const times = [0, 220, 520, 770, 1100, 1500].map(topologyFixtureTime);
        let prev = 0;
        for (const t of times) {
            const g = deriveTopology(events, { atMonoNs: t });
            const total = [...g.nodes, ...g.edges].reduce((s, x) => s + x.evidence.length, 0);
            expect(total).toBeGreaterThanOrEqual(prev);
            prev = total;
            for (const item of [...g.nodes, ...g.edges]) {
                for (const id of item.evidence) {
                    expect(events.find((e) => e.event_id === id)!.mono_ns).toBeLessThanOrEqual(t);
                }
            }
        }
        expect(deriveTopology(events, { atMonoNs: topologyFixtureTime(1500) })).toEqual({ ...deriveTopology(events), atMonoNs: topologyFixtureTime(1500) });
    });

    it("keeps a selection valid only while its identity exists", () => {
        const sel = { kind: "node" as const, id: "memory:project-notes" };
        expect(selectionValid(deriveTopology(events, { atMonoNs: topologyFixtureTime(250) }), sel)).toBe(false);
        const g = deriveTopology(events, { atMonoNs: topologyFixtureTime(350) });
        expect(selectionValid(g, sel)).toBe(true);
        expect(evidenceFor(g, sel)).toEqual(["evt_topo_0011", "evt_topo_0012"]);
        expect(evidenceFor(g, { kind: "edge", id: "nope" })).toEqual([]);
        expect(selectionValid(g, null)).toBe(false);
    });
});

describe("edge cases", () => {
    it("returns an empty graph for no events or only non-topology events", () => {
        const g = deriveTopology([at(1, "inference.token.generated"), at(2, "device.memory.sample")]);
        expect(g.nodes).toEqual([]);
        expect(g.edges).toEqual([]);
        expect(g.consideredEvents).toBe(2);
        expect(g.mappedEvents).toBe(0);
        expect(deriveTopology([]).nodes).toEqual([]);
    });

    it("lists topology events missing required ids as unmapped", () => {
        const g = deriveTopology([
            at(1, "route.selected", { agent_id: "a" }), // no model
            at(2, "tool.called", { agent_id: "a" }), // no tool name
            at(3, "context.forked", { agent_id: "a" }), // no target
        ]);
        expect(g.unmappedEventIds).toEqual(["evt_route.selected_1", "evt_tool.called_2", "evt_context.forked_3"]);
        // nothing is drawn from incomplete events
        expect(g.nodes).toEqual([]);
    });

    it("accepts alternative attribute names and envelope tool_call_id", () => {
        const g = deriveTopology([
            at(1, "agent.spawned", { agent_id: "child", attributes: { parent_agent_id: "root" } }),
            at(2, "tool.called", { agent_id: "child", tool_call_id: "x", attributes: { tool_name: "grep" } }),
            at(3, "tool.completed", { agent_id: "child", tool_call_id: "x", attributes: {} }),
            at(4, "memory.retrieval.completed", { agent_id: "child", attributes: { memory_store: "vec" } }),
            at(5, "agent.message", { agent_id: "child", attributes: { to: "root" } }),
        ]);
        expect(g.edges.map((e) => e.id)).toEqual([
            "delegation:agent:root->agent:child",
            "tool_call:agent:child->tool:grep",
            "memory_retrieval:agent:child->memory:vec",
            "message:agent:child->agent:root",
        ]);
        expect(edge(g, "tool_call:agent:child->tool:grep").status).toBe("ok");
        expect(node(g, "agent:root").status).toBe("unknown");
        expect(node(g, "agent:child").status).toBe("pending");
    });

    it("unknown guard types stay visible as generic guard diagnostics", () => {
        const g = deriveTopology([at(1, "guard.loop_detected", { agent_id: "a" })]);
        expect(node(g, "agent:a").diagnostics.map((d) => d.kind)).toEqual(["guard"]);
    });
});
