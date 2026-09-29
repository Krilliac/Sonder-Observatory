import { describe, expect, it } from "vitest";
import { generateEvents } from "../../scripts/gen-large-fixture.mjs";
import { relatedGroups } from "../../src/inspector/related";
import type { ObservatoryEvent } from "../../src/protocol/events";
import { orderEvents } from "../../src/replay/order";
import { SessionStore } from "../../src/replay/session";
import { at } from "../helpers";

const runtime = { name: "sonder-runtime", version: "1", node_id: "n1" };
const inference = { name: "sonder-inference", version: "1", node_id: "n1" };

/** Parent/child requests across producers and runs, tool calls, agents and ids that are shared or empty. */
function crossProducer(): ObservatoryEvent[] {
    return [
        at(1, "request.started", { request_id: "R", run_id: "run1", agent_id: "a1", producer: runtime }),
        at(2, "request.queued", { request_id: "inf-1", run_id: "run1", producer: inference, attributes: { parent_request_id: "R" } }),
        at(3, "request.started", { request_id: "inf-1", run_id: "run1", producer: inference, attributes: { parent_request_id: "R" } }),
        at(4, "request.started", { request_id: "inf-2", producer: inference, attributes: { parent_request_id: "R" } }),
        // A child from another run is not related; nor is a parent candidate from another run.
        at(5, "request.started", { request_id: "inf-3", run_id: "run2", producer: inference, attributes: { parent_request_id: "R" } }),
        at(6, "request.started", { request_id: "R", run_id: "run2", producer: inference }),
        at(7, "tool.called", { request_id: "R", run_id: "run1", agent_id: "a1", producer: runtime, attributes: { tool_call_id: "tc1" } }),
        at(8, "tool.completed", { request_id: "R", run_id: "run1", agent_id: "a1", producer: runtime, attributes: { tool_call_id: "tc1" } }),
        at(9, "tool.called", { agent_id: "", request_id: "", run_id: "", attributes: { tool_call_id: "" } }),
        at(10, "request.completed", { request_id: "inf-1", run_id: "run1", producer: inference }),
        at(11, "request.completed", { request_id: "R", run_id: "run1", agent_id: "a1", producer: runtime }),
        at(12, "agent.completed", { agent_id: "a1", run_id: "run1" }),
    ];
}

/** relatedGroups over an unmarked copy takes the full-scan path. */
function scan(event: ObservatoryEvent, events: readonly ObservatoryEvent[], limit?: number) {
    return relatedGroups(event, [...events], limit);
}

describe("relatedGroups with the correlation index equals a full scan", () => {
    it("for every event of a cross-producer session", () => {
        const events = orderEvents(crossProducer()).events;
        for (const e of events) {
            expect(relatedGroups(e, events)).toEqual(scan(e, events));
            expect(relatedGroups(e, events, 1)).toEqual(scan(e, events, 1));
        }
        // The parent and child groups are actually exercised.
        const kinds = new Set(events.flatMap((e) => relatedGroups(e, events).map((g) => g.kind)));
        expect([...kinds].sort()).toEqual(["agent", "children", "parent", "request", "run", "tool_call"]);
    });

    it("for an event that is not in the session", () => {
        const events = orderEvents(crossProducer()).events;
        const outsider = at(99, "request.started", { request_id: "R", run_id: "run1", producer: runtime, attributes: { parent_request_id: "inf-1" } });
        expect(relatedGroups(outsider, events)).toEqual(scan(outsider, events));
    });

    it("on a large session", () => {
        const events = orderEvents([...generateEvents(30_000, 3)] as ObservatoryEvent[]).events;
        for (let k = 0; k < 60; k += 1) {
            const e = events[Math.floor((events.length * k) / 60)]!;
            expect(relatedGroups(e, events)).toEqual(scan(e, events));
        }
    });

    it("across in-order live appends (shared index) and a merge (rebuilt)", () => {
        const all = orderEvents([...generateEvents(12_000, 9)] as ObservatoryEvent[]).events;
        const store = new SessionStore();
        store.reset("live", "test");
        const probe = all[5_000]!;
        const arrays: (readonly ObservatoryEvent[])[] = [];
        for (let i = 0; i < 9_000; i += 1_000) {
            store.append(all.slice(i, i + 1_000));
            relatedGroups(probe, store.events);
            arrays.push(store.events);
        }
        store.append(all.slice(10_000, 11_000));
        store.append(all.slice(9_000, 10_000));
        arrays.push(store.events);
        for (const events of arrays) {
            for (const e of [probe, events[0]!, events.at(-1)!]) {
                expect(relatedGroups(e, events)).toEqual(scan(e, events));
            }
        }
    });
});
