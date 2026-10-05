import { describe, expect, it } from "vitest";
import { derivePipeline } from "../../src/inference3d/derive";
import { at } from "../helpers";

const runtime = { name: "sonder-runtime", version: "1", node_id: "n", instance_id: "rt", role: "runtime", synthetic: true };
const inference = { ...runtime, name: "sonder-inference", instance_id: "inf", role: "inference" };
const parent = at(1, "request.started", { request_id: "R", run_id: "run", producer: runtime });
const child = at(3, "request.started", { request_id: "child", run_id: "run", producer: inference, attributes: { parent_request_id: "R" } });

describe("telemetry-grounded 3D parent links", () => {
    it("refuses a known conflicting run", () => {
        expect(derivePipeline([parent, { ...child, run_id: "other" }]).links).toEqual([]);
    });

    it("keeps the compatible Runtime instance despite a later same-ID conflicting candidate", () => {
        const wrong = at(2, "request.started", { request_id: "R", event_id: "wrong-instance", run_id: "other", producer: { ...runtime, instance_id: "rt-other" } });
        const model = derivePipeline([parent, wrong, child]);
        expect(model.links).toEqual([{ from: model.requests.find(r => r.evidence.includes(parent.event_id))!.id, to: model.requests.find(r => r.requestId === "child")!.id }]);
    });

    it("withholds a link when multiple compatible Runtime instances make its target ambiguous", () => {
        const duplicate = at(2, "request.started", { request_id: "R", run_id: "run", event_id: "other-instance", producer: { ...runtime, instance_id: "rt-other" } });
        expect(derivePipeline([parent, duplicate, child]).links).toEqual([]);
    });

    it.each(["parent", "child", "both"])("accepts a unique candidate when %s omits run metadata", omitted => {
        const p = omitted === "child" ? parent : { ...parent, run_id: null };
        const c = omitted === "parent" ? child : { ...child, run_id: null };
        expect(derivePipeline([p, c]).links).toHaveLength(1);
    });

    it("withholds multiple observed parent IDs instead of selecting the first", () => {
        const conflicting = at(4, "request.completed", { request_id: "child", run_id: "run", producer: inference, attributes: { parent_request_id: "other-parent" } });
        const model = derivePipeline([parent, child, conflicting]);
        expect(model.links).toEqual([]);
        expect(model.requests.find(r => r.requestId === "child")?.parentRequestId).toBeNull();
    });

    it("withholds conflicting observed runs within a request", () => {
        const conflicting = at(4, "request.completed", { request_id: "child", run_id: "other", producer: inference });
        expect(derivePipeline([parent, child, conflicting]).links).toEqual([]);
    });

    it("withholds a parent entity that reports conflicting runs", () => {
        const conflict = at(4, "request.completed", { request_id: "R", run_id: "other", producer: runtime });
        expect(derivePipeline([parent, child, conflict]).links).toEqual([]);
    });

    it("does not inherit parents between requests and does not mutate input evidence", () => {
        const unset = at(4, "request.started", { request_id: "unset", run_id: "run", producer: inference });
        const events = [parent, child, unset];
        const before = JSON.stringify(events);
        const model = derivePipeline(events);
        expect(model.links).toHaveLength(1);
        expect(model.requests.find(r => r.requestId === "unset")?.parentRequestId).toBeNull();
        expect(JSON.stringify(events)).toBe(before);
    });
});
