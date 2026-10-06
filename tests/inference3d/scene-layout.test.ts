import { describe, expect, it } from "vitest";
import { derivePipeline } from "../../src/inference3d/derive";
import { producerStreamKey, tupleKey } from "../../src/query/identity";
import { makeEvent } from "../helpers";
import { deepSyntheticFixture, ollamaPoolFixture } from "../../src/inference3d/fixtures";
import type { RequestEntity } from "../../src/inference3d/model";
import { ageOpacity, layoutScene, pulseHz, requestRadius } from "../../src/inference3d/scene";

describe("3D scene layout (pure)", () => {
    it("puts stage planes along x in pipeline order and groups lanes into node bands", () => {
        const layout = layoutScene(derivePipeline(ollamaPoolFixture()));
        expect(layout.planes.map((p) => p.label)).toEqual(["Route", "Queue", "Prefill", "Decode", "Output"]);
        const xs = layout.planes.map((p) => p.x);
        expect([...xs].sort((a, b) => a - b)).toEqual(xs);
        expect(layout.bands.map((b) => b.nodeId)).toEqual(["node1", "workstation"]);
        // node1 has one lane, workstation two; bands do not overlap and contain their lanes.
        const [n1, ws] = layout.bands;
        expect(n1!.yMin).toBeGreaterThan(ws!.yMax);
        for (const lane of layout.lanes) {
            const band = layout.bands.find((b) => b.nodeId === lane.nodeId)!;
            expect(lane.y).toBeGreaterThan(band.yMin);
            expect(lane.y).toBeLessThan(band.yMax);
        }
        expect(layout.lanes.filter((l) => l.nodeId === "workstation").map((l) => l.label)).toEqual(["deepseek-r1:14b", "qwen3:14b"]);
    });

    it("inserts one thin plane per reported layer between prefill and decode", () => {
        const layout = layoutScene(derivePipeline(deepSyntheticFixture(4, 2)));
        expect(layout.planes.map((p) => p.label)).toEqual(["Route", "Queue", "Prefill", "L0", "L1", "L2", "L3", "Decode", "Output"]);
        expect(layout.stageX.layers).toBeGreaterThan(layout.stageX.prefill!);
        expect(layout.stageX.decode).toBeGreaterThan(layout.planes.find((p) => p.label === "L3")!.x);
    });

    it("keeps one layer plane per producer stream when streams report the same layer indices", () => {
        const m = derivePipeline(deepSyntheticFixture(3, 1));
        const other = producerStreamKey(makeEvent({ producer: { name: "other-producer", version: "test", node_id: "node2", instance_id: "inf-2" } }));
        const layers = [...m.layers, ...m.layers.map((l) => ({ ...l, id: tupleKey("layer", other, String(l.layer)), stream: other }))];
        const layout = layoutScene({ ...m, layers });
        const layerPlanes = layout.planes.filter((p) => p.stage === "layers");
        // Every LayerEntity keeps its own pickable plane (its evidence stays reachable).
        expect(layerPlanes.map((p) => p.id).sort()).toEqual(layers.map((l) => l.id).sort());
        // Planes of different streams do not coincide.
        expect(new Set(layerPlanes.map((p) => p.x)).size).toBe(layerPlanes.length);
        // Each stream's layers stay in order and before decode.
        for (const stream of new Set(layers.map((l) => l.stream))) {
            const own = layerPlanes.filter((p) => layers.find((l) => l.id === p.id)!.stream === stream);
            expect(own.map((p) => p.layer)).toEqual([0, 1, 2]);
        }
        expect(layout.stageX.decode).toBeGreaterThan(Math.max(...layerPlanes.map((p) => p.x)));
    });

    it("maps tokens to size, age to opacity and event rate to pulse", () => {
        const r = (completionTokens: number | null, promptTokens: number | null) => ({ completionTokens, promptTokens }) as RequestEntity;
        expect(requestRadius(r(null, null))).toBeCloseTo(0.16);
        expect(requestRadius(r(463, 212))).toBeGreaterThan(requestRadius(r(null, 212)));
        expect(requestRadius(r(1e9, null))).toBe(0.62);
        expect(ageOpacity(0, 1000, 0.3)).toBe(1);
        expect(ageOpacity(500, 1000, 0.3)).toBeCloseTo(0.5);
        expect(ageOpacity(5000, 1000, 0.3)).toBe(0.3);
        expect(pulseHz(0)).toBe(0);
        expect(pulseHz(10)).toBeGreaterThan(pulseHz(1));
        expect(pulseHz(1e6)).toBe(2.5);
    });
});
