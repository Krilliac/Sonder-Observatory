import { describe, expect, it } from "vitest";
import { deriveTopology } from "../../src/topology/derive";
import { topologyFixtureEvents, topologyFixtureTime } from "../../src/topology/fixtures/topology-synthetic";
import { agentDepths, layoutTopology } from "../../src/topology/layout";
import { TOPOLOGY_EDGE_KINDS, TOPOLOGY_NODE_KINDS } from "../../src/topology/model";
import { buildScene, EDGE_STYLE, NODE_STYLE, shapePath, STATUS_STYLE } from "../../src/topology/scene";
import { at } from "../helpers";

const events = topologyFixtureEvents();
const full = deriveTopology(events);
const layout = layoutTopology(full);

describe("layoutTopology", () => {
    it("places agents by delegation depth, then models, tools, memory", () => {
        expect(layout.columns.map((c) => c.label)).toEqual(["Agents", "Agents (depth 1)", "Models", "Tools", "Memory"]);
        const x = (id: string) => layout.positions.get(id)!.x;
        expect(x("agent:agt_owner")).toBeLessThan(x("agent:agt_research"));
        expect(x("agent:agt_research")).toBe(x("agent:agt_critic"));
        expect(x("agent:agt_critic")).toBeLessThan(x("model:mdl_syn_small"));
        expect(x("model:mdl_syn_small")).toBeLessThan(x("tool:synthetic.search"));
        expect(x("tool:synthetic.search")).toBeLessThan(x("memory:project-notes"));
        expect(layout.positions.size).toBe(full.nodes.length);
    });

    it("is deterministic and has no overlapping positions", () => {
        expect(layoutTopology(deriveTopology([...events].reverse()))).toEqual(layout);
        const keys = [...layout.positions.values()].map((p) => `${p.x},${p.y}`);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it("survives delegation cycles", () => {
        const g = deriveTopology([
            at(1, "agent.spawned", { agent_id: "a", attributes: { parent: "b" } }),
            at(2, "agent.spawned", { agent_id: "b", attributes: { parent: "a" } }),
        ]);
        const d = agentDepths(g);
        expect([...d.keys()].sort()).toEqual(["agent:a", "agent:b"]);
        expect(layoutTopology(g).positions.size).toBe(2);
    });

    it("handles an empty graph", () => {
        const l = layoutTopology(deriveTopology([]));
        expect(l.positions.size).toBe(0);
        expect(l.columns).toEqual([]);
    });
});

describe("buildScene", () => {
    it("draws only what exists at the cursor, on the full-session layout", () => {
        const t = topologyFixtureTime(350);
        const scene = buildScene(deriveTopology(events, { atMonoNs: t }), layout, { atMonoNs: t });
        expect(scene.nodes.map((n) => n.id).sort()).toEqual(["agent:agt_owner", "agent:agt_research", "memory:project-notes", "model:mdl_syn_small"]);
        expect(scene.unplacedNodeIds).toEqual([]);
        const research = scene.nodes.find((n) => n.id === "agent:agt_research")!;
        expect([research.x, research.y]).toEqual([layout.positions.get("agent:agt_research")!.x, layout.positions.get("agent:agt_research")!.y]);
    });

    it("encodes kind by shape and status by badge + dash (not colour alone)", () => {
        const scene = buildScene(full, layout);
        const shapes = new Set(TOPOLOGY_NODE_KINDS.map((k) => NODE_STYLE[k].shape));
        expect(shapes.size).toBe(TOPOLOGY_NODE_KINDS.length);
        const dashes = new Set(TOPOLOGY_EDGE_KINDS.map((k) => `${EDGE_STYLE[k].color}|${EDGE_STYLE[k].dash}`));
        expect(dashes.size).toBe(TOPOLOGY_EDGE_KINDS.length);
        const badges = new Set(Object.values(STATUS_STYLE).map((s) => s.badge));
        expect(badges.size).toBe(Object.keys(STATUS_STYLE).length);
        const critic = scene.nodes.find((n) => n.id === "agent:agt_critic")!;
        expect(critic.badge).toBe(STATUS_STYLE.cancelled.badge);
        expect(critic.diagnosticCount).toBe(1);
        expect(critic.ariaLabel).toContain("status cancelled");
    });

    it("marks selection, failed and superseded edges", () => {
        const scene = buildScene(full, layout, { selection: { kind: "edge", id: "tool_call:agent:agt_research->tool:synthetic.search" } });
        const sel = scene.edges.filter((e) => e.selected);
        expect(sel.map((e) => e.id)).toEqual(["tool_call:agent:agt_research->tool:synthetic.search"]);
        expect(sel[0]!.color).toContain("error");
        expect(sel[0]!.label).toContain("2 failed");
        const old = scene.edges.find((e) => e.id === "route:agent:agt_research->model:mdl_syn_small")!;
        expect(old.label).toContain("superseded");
        expect(old.opacity).toBeLessThan(1);
    });

    it("separates parallel edges between the same pair", () => {
        const scene = buildScene(full, layout);
        const paths = scene.edges
            .filter((e) => e.id.includes("agent:agt_research->tool:synthetic.search"))
            .map((e) => e.path);
        expect(paths).toHaveLength(2);
        expect(paths[0]).not.toEqual(paths[1]);
    });

    it("builds a legend covering every kind and status present", () => {
        const scene = buildScene(full, layout);
        const keys = (group: string) => scene.legend.filter((l) => l.group === group).map((l) => l.key);
        expect(keys("node").sort()).toEqual([...new Set(full.nodes.map((n) => n.kind))].sort());
        expect(keys("edge").sort()).toEqual([...new Set(full.edges.map((e) => e.kind))].sort());
        expect(keys("status").sort()).toEqual([...new Set(full.nodes.map((n) => n.status))].sort());
        expect(keys("mapping").length).toBeGreaterThanOrEqual(4);
    });

    it("fades inactive entities by recency but keeps active ones opaque", () => {
        const t = topologyFixtureTime(1500);
        const scene = buildScene(full, layout, { atMonoNs: t, fadeWindowNs: 1_000_000_000 });
        for (const n of scene.nodes) {
            expect(n.opacity).toBeGreaterThanOrEqual(0.45);
            expect(n.opacity).toBeLessThanOrEqual(1);
        }
        const large = scene.nodes.find((n) => n.id === "model:mdl_syn_large")!;
        expect(large.opacity).toBe(1); // loaded model is active
    });

    it("produces closed shape paths", () => {
        for (const k of TOPOLOGY_NODE_KINDS) {
            expect(shapePath(NODE_STYLE[k].shape, 10, 10, 5)).toMatch(/^M.*Z$/);
        }
    });
});
