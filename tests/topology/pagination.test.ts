import { describe, expect, it } from "vitest";
import { topologyPage, TOPOLOGY_PAGE_SIZE } from "../../src/topology/pagination";
import { getTopologyTimeline } from "../../src/topology/derive";
import { SessionStore } from "../../src/replay/session";
import { at } from "../helpers";

describe("topology presentation pages", () => {
    it("keeps every evidence position reachable without exceeding the DOM row bound", () => {
        for (const total of [0, 1, 49, 50, 51, 101, 5_000, 100_000]) {
            let next = 0;
            const pages = topologyPage(0, total).pages;
            for (let index = 0; index < pages; index += 1) {
                const page = topologyPage(index, total);
                expect(page.start).toBe(next);
                expect(page.end - page.start).toBeLessThanOrEqual(TOPOLOGY_PAGE_SIZE);
                next = page.end;
            }
            expect(next).toBe(total);
        }
    });

    it("clamps a last-page selection when replay or retention shrinks the visible list", () => {
        expect(topologyPage(99, 5_000)).toMatchObject({ start: 4_950, end: 5_000 });
        expect(topologyPage(99, 51)).toMatchObject({ index: 1, start: 50, end: 51 });
        expect(topologyPage(99, 20)).toMatchObject({ index: 0, start: 0, end: 20 });
        expect(topologyPage(99, 0)).toEqual({ index: 0, pages: 0, start: 0, end: 0 });
    });

    it("clamps invalid or fractional page indices without dropping list positions", () => {
        for (const index of [-1, NaN, Infinity, -Infinity]) {
            expect(topologyPage(index, 101)).toMatchObject({ index: 0, start: 0, end: 50 });
        }
        expect(topologyPage(1.8, 101)).toMatchObject({ index: 1, start: 50, end: 100 });
    });

    it("recognizes actual Store append continuity while rejecting replacement, reorder and retention", () => {
        const store = new SessionStore({ maxLiveEvents: 200 });
        store.reset("live", "synthetic paging control");
        store.append(Array.from({ length: 120 }, (_, index) => at(index + 1, "guard.budget_pressure", { agent_id: "paging" })));
        const previous = getTopologyTimeline(store.events);
        store.append([at(121, "guard.budget_pressure", { agent_id: "paging" })]);
        const appended = getTopologyTimeline(store.events);
        expect(appended).not.toBe(previous);
        expect(appended.continues(previous)).toBe(true);
        expect(previous.continues(appended)).toBe(false);
        store.append([at(0, "guard.budget_pressure", { agent_id: "paging" })]);
        const reordered = getTopologyTimeline(store.events);
        expect(reordered.continues(appended)).toBe(false);
        store.append(Array.from({ length: 200 }, (_, index) => at(index + 122, "guard.budget_pressure", { agent_id: "paging" })));
        const retained = getTopologyTimeline(store.events);
        expect(retained.continues(reordered)).toBe(false);
        store.reset("file", "replacement");
        store.append([at(1, "guard.budget_pressure", { agent_id: "paging" })]);
        expect(getTopologyTimeline(store.events).continues(retained)).toBe(false);
    });
});
