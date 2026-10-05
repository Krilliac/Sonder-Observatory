import { describe, expect, it } from "vitest";
import { relatedGroups } from "../../src/inspector/related";
import { orderEvents } from "../../src/replay/order";
import { SessionStore } from "../../src/replay/session";
import { at } from "../helpers";
import type { ObservatoryEvent } from "../../src/protocol/events";

const runtime = { name: "sonder-runtime", version: "1", node_id: "n", instance_id: "rt", role: "runtime", synthetic: true };
const inference = { ...runtime, name: "sonder-inference", instance_id: "inf", role: "inference" };
const parent = at(1, "request.started", { request_id: "R", run_id: "run", producer: runtime });
const queued = at(2, "request.queued", { request_id: "child", run_id: "run", producer: inference, attributes: { parent_request_id: "R" } });
const output = at(3, "inference.token.generated", { request_id: "child", run_id: "run", producer: inference });
const parentGroup = (event: ObservatoryEvent, events: readonly ObservatoryEvent[], limit?: number) => relatedGroups(event, events, limit).find(g => g.kind === "parent");

describe("request-derived inspector parent lineage", () => {
    it.each(["inference.token.generated", "scheduler.admitted", "kv.allocated"])("resolves lifecycle evidence when selecting %s without changing wire events", type => {
        const selected = { ...output, event_type: type };
        const events = orderEvents([parent, queued, selected]).events;
        const before = JSON.stringify(events);
        expect(parentGroup(selected, events)?.events).toEqual([parent]);
        expect(parentGroup(selected, [...events])).toEqual(parentGroup(selected, events));
        expect(JSON.stringify(events)).toBe(before);
        expect(selected.attributes.parent_request_id).toBeUndefined();
    });

    it("does not inherit another request's parent or another instance's same request ID", () => {
        const unset = { ...output, request_id: "unset" };
        const collision = { ...output, producer: { ...inference, instance_id: "other" } };
        expect(parentGroup(unset, [parent, queued, unset])).toBeUndefined();
        expect(parentGroup(collision, [parent, queued, collision])).toBeUndefined();
    });

    it("withholds ambiguous parents and keeps their original evidence in Same request", () => {
        const conflicting = at(4, "request.completed", { request_id: "child", run_id: "run", producer: inference, event_id: "conflict", attributes: { parent_request_id: "other-parent" } });
        const events = orderEvents([parent, queued, output, conflicting]).events;
        expect(parentGroup(output, events)).toBeUndefined();
        expect(parentGroup(queued, events)).toBeUndefined();
        expect(relatedGroups(output, events).find(g => g.kind === "request")?.events).toEqual([queued, conflicting]);
    });

    it("uses observed request runs when the selected output omits its run", () => {
        const selected = { ...output, run_id: null };
        const wrongParent = { ...parent, run_id: "other", event_id: "wrong-parent" };
        expect(parentGroup(selected, [wrongParent, queued, selected])).toBeUndefined();
        expect(parentGroup(selected, [parent, queued, selected])?.events).toEqual([parent]);
        expect(parentGroup(selected, [{ ...parent, run_id: null }, queued, selected])?.events).toHaveLength(1);
    });

    it("withholds parent linkage for conflicting observed request runs", () => {
        const conflict = { ...queued, run_id: "other", event_id: "conflicting-run" };
        expect(parentGroup({ ...output, run_id: null }, [parent, queued, output, conflict])).toBeUndefined();
    });

    it("retains matching candidates across instances, limits rows and reports their total", () => {
        const other = { ...parent, producer: { ...runtime, instance_id: "rt-other" }, event_id: "other-instance" };
        const wrong = { ...parent, run_id: "other", event_id: "wrong" };
        const group = parentGroup(output, orderEvents([parent, other, wrong, queued, output]).events, 1)!;
        expect(group.events).toEqual([parent]);
        expect(group.total).toBe(2);
    });

    it("lists compatible parent evidence even when that parent also reports another run", () => {
        const conflict = at(4, "request.completed", { request_id: "R", run_id: "other", producer: runtime });
        const events = orderEvents([parent, queued, output, conflict]).events;
        expect(parentGroup(output, events)?.events).toEqual([parent]);
        expect(parentGroup(output, [...events])?.events).toEqual([parent]);
    });

    it("uses only each immutable indexed prefix through append, merge, and replacement", () => {
        const store = new SessionStore();
        store.reset("live", "lineage");
        store.append([parent]);
        const prefix = store.events;
        expect(parentGroup(output, prefix)).toBeUndefined();
        store.append([queued, output]);
        expect(parentGroup(output, store.events)?.events).toEqual([parent]);
        expect(parentGroup(output, prefix)).toBeUndefined();
        const conflict = at(2.5, "request.started", { request_id: "child", run_id: "run", producer: inference, attributes: { parent_request_id: "other-parent" } });
        store.append([conflict]);
        expect(parentGroup(output, store.events)).toBeUndefined();
        expect(parentGroup(output, [...store.events])).toBeUndefined();
        store.reset("file", "replacement");
        store.append([parent, output]);
        expect(parentGroup(output, store.events)).toBeUndefined();
    });

    it("does not scan unrelated requests once the ordered correlation index is warm", () => {
        let unrelatedReads = 0;
        let warm = false;
        const unrelated = Array.from({ length: 200 }, (_, i) => new Proxy(at(10 + i, "request.started", { request_id: `unrelated-${i}` }), {
            get(target, property, receiver) {
                if (warm) {
                    unrelatedReads += 1;
                }
                return Reflect.get(target, property, receiver);
            },
        }));
        const events = orderEvents([parent, queued, output, ...unrelated]).events;
        expect(parentGroup(output, events)?.events).toEqual([parent]);
        warm = true;
        expect(parentGroup(output, events)?.events).toEqual([parent]);
        expect(unrelatedReads).toBe(0);
    });

    it("keeps every Same request candidate after early parent ambiguity", () => {
        const conflict = at(4, "request.started", { request_id: "child", run_id: "run", producer: inference, attributes: { parent_request_id: "other-parent" } });
        const tail = Array.from({ length: 40 }, (_, i) => at(5 + i, "inference.token.generated", { request_id: "child", run_id: "run", producer: inference }));
        const events = orderEvents([parent, queued, output, conflict, ...tail]).events;
        const groups = relatedGroups(output, events, 3);
        expect(groups).toEqual(relatedGroups(output, [...events], 3));
        expect(groups.find(g => g.kind === "parent")).toBeUndefined();
        expect(groups.find(g => g.kind === "request")).toMatchObject({ events: [queued, conflict, tail[0]], total: 42 });
    });

    it("preserves outsider parent conflicts without borrowing another instance's facts", () => {
        const selected = at(99, "inference.token.generated", { request_id: "child", run_id: "run", producer: inference, attributes: { parent_request_id: "other-parent" } });
        const foreign = at(4, "request.started", { request_id: "child", run_id: "other", producer: { ...inference, instance_id: "foreign" }, attributes: { parent_request_id: "foreign-parent" } });
        const events = orderEvents([parent, queued, output, foreign]).events;
        const groups = relatedGroups(selected, events);
        expect(groups).toEqual(relatedGroups(selected, [...events]));
        expect(groups.find(g => g.kind === "parent")).toBeUndefined();
        expect(groups.find(g => g.kind === "request")?.events).toEqual([queued, output]);
    });

    it("observes a late known run after initial parent evidence with absent runs", () => {
        const initial = { ...queued, run_id: null };
        const selected = { ...output, run_id: null };
        const lateRun = at(4, "request.completed", { request_id: "child", run_id: "other", producer: inference });
        const store = new SessionStore();
        store.reset("live", "late run");
        store.append([parent, initial, selected]);
        const prefix = store.events;
        expect(parentGroup(selected, prefix)?.events).toEqual([parent]);
        store.append([lateRun]);
        expect(parentGroup(selected, store.events)).toBeUndefined();
        expect(relatedGroups(selected, store.events)).toEqual(relatedGroups(selected, [...store.events]));
        expect(parentGroup(selected, prefix)?.events).toEqual([parent]);
    });
});
