import { describe, expect, it } from "vitest";
import { derivePipeline } from "../../src/inference3d/derive";
import { producerStreamKey, tupleKey } from "../../src/query/identity";
import { makeEvent } from "../helpers";
import { validateEvent } from "../../src/protocol/validate";
import { deepSyntheticFixture, ollamaPoolFixture } from "../../src/inference3d/fixtures";
import type { LayerEntity, RequestEntity } from "../../src/inference3d/model";
import { ageOpacity, layoutScene, maxLayerActivationRms, pulseHz, requestRadius } from "../../src/inference3d/scene";

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


/** Native spread over small independent chunks: the oracle never fans out all layers. */
function nativeChunkBounds(values: readonly number[]): { min: number; max: number } {
    let min = 0;
    let max = 0;
    for (let start = 0; start < values.length; start += 1024) {
        const chunk = values.slice(start, start + 1024);
        min = Math.min(min, ...chunk);
        max = Math.max(max, ...chunk);
    }
    return { min, max };
}

describe("complete layer bounds without argument fan-out", () => {
    it("keeps every derived synthetic layer plane, evidence identity and endpoint at 131072 layers", () => {
        const count = 131072;
        const producer = { name: "scene-layer-scale", version: "test", node_id: "synthetic-node", instance_id: "scene-layer-scale-1", synthetic: true };
        const events = Array.from({ length: count }, (_, layer) => makeEvent({
            event_id: `synthetic-layer-${layer}`,
            sequence: layer,
            mono_ns: 1000 + layer,
            event_type: "backend.layer.completed",
            producer,
            attributes: { layer, layer_count: count, activation_rms: layer, duration_ms: 1 },
        }));
        expect(validateEvent(events[0]).ok).toBe(true);
        expect(validateEvent(events.at(-1)).ok).toBe(true);
        const model = derivePipeline(events);
        expect(model.synthetic).toBe(true);
        expect(model.layers).toHaveLength(count);
        expect(model.stages.find((stage) => stage.id === "layers")!.events).toBe(count);
        const layout = layoutScene(model);
        expect(layout.planes).toHaveLength(count + 5);
        const planes = layout.planes.filter((plane) => plane.stage === "layers");
        expect(planes).toHaveLength(count);
        expect(planes.every((plane, index) => plane.id === model.layers[index]!.id
            && plane.layer === index && plane.label === `L${index}`
            && plane.stream === model.layers[index]!.stream && plane.x === 15 + index * 0.9)).toBe(true);
        expect(model.layers.every((layer, index) => layer.layer === index && layer.events === 1
            && layer.evidence.length === 1 && layer.evidence[0] === events[index]!.event_id
            && layer.activationRms === index && layer.totalDurationMs === 1)).toBe(true);
        expect(events.every((event, index) => event.sequence === index && event.mono_ns === 1000 + index
            && event.attributes.layer === index && event.attributes.layer_count === count
            && event.attributes.activation_rms === index && event.producer === producer)).toBe(true);
        expect(layout.stageX.decode).toBe(15 + (count - 1) * 0.9 + 5);
        expect(layout.stageX.output).toBe(layout.stageX.decode! + 5);
        const expected = nativeChunkBounds(layout.planes.map((plane) => plane.x));
        expect(Object.is(layout.xMin, expected.min)).toBe(true);
        expect(Object.is(layout.xMax, expected.max)).toBe(true);
        expect(layout.xMin).toBe(0);
        expect(layout.xMax).toBe(layout.stageX.output);
        expect(maxLayerActivationRms(model.layers)).toBe(count - 1);
        expect(maxLayerActivationRms(model.layers)).toBe(nativeChunkBounds(model.layers.map((layer) => layer.activationRms ?? 0)).max);
    });

    it("matches the native zero-seeded RMS maximum for null, signed zero and direct nonfinite values", () => {
        const seed = derivePipeline(deepSyntheticFixture(1, 1)).layers[0]!;
        const cells: (number | null)[][] = [[], [null], [-0], [+0, -0], [-0, +0], [-4, -1],
            [null, 3, null, 2], [Infinity, 1], [-Infinity], [NaN, 2], [2, NaN], [Infinity, NaN, -Infinity]];
        for (const values of cells) {
            const layers: LayerEntity[] = values.map((activationRms, index) => ({ ...seed, id: `numeric-${index}`, activationRms }));
            const expected = Math.max(0, ...values.map((value) => value ?? 0));
            expect(Object.is(maxLayerActivationRms(layers), expected), String(values)).toBe(true);
            expect(layers.map((layer) => layer.activationRms)).toEqual(values);
        }
    });

    it("retains empty and ordinary multi-producer plane bounds against the native oracle", () => {
        const model = derivePipeline(deepSyntheticFixture(4, 1));
        const other = producerStreamKey(makeEvent({ producer: { name: "other", version: "test", node_id: "other-node", instance_id: "other-instance" } }));
        const second = model.layers.map((layer) => ({ ...layer, id: tupleKey("layer", other, String(layer.layer)), stream: other }));
        for (const input of [derivePipeline([]), { ...model, layers: [...model.layers, ...second] }]) {
            const layout = layoutScene(input);
            const xs = layout.planes.map((plane) => plane.x);
            expect(Object.is(layout.xMin, Math.min(0, ...xs))).toBe(true);
            expect(Object.is(layout.xMax, Math.max(0, ...xs))).toBe(true);
        }
        const empty = layoutScene({ ...derivePipeline([]), stages: [] });
        expect(empty.planes).toEqual([]);
        expect(Object.is(empty.xMin, +0)).toBe(true);
        expect(Object.is(empty.xMax, +0)).toBe(true);
    });
});
