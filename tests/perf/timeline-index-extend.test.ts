import { describe, expect, it } from "vitest";
import { generateEvents } from "../../scripts/gen-large-fixture.mjs";
import type { ObservatoryEvent } from "../../src/protocol/events";
import { orderEvents } from "../../src/replay/order";
import { SessionStore } from "../../src/replay/session";
import { eventPosition, getEventIndex } from "../../src/renderer/timelineModel";

const all = orderEvents([...generateEvents(20_000, 13)] as ObservatoryEvent[]).events;

/** A fresh index of an unmarked copy: no ancestor, own id map. */
function fresh(events: readonly ObservatoryEvent[]) {
    return getEventIndex([...events]);
}

describe("event index across live appends", () => {
    it("an extended index and its id lookups equal a fresh build", () => {
        const store = new SessionStore();
        store.reset("live", "test");
        const arrays: (readonly ObservatoryEvent[])[] = [];
        for (let i = 0; i < 16_000; i += 2_000) {
            store.append(all.slice(i, i + 2_000));
            // Index only every other array: extension also works across unindexed appends.
            if ((i / 2_000) % 2 === 0) {
                eventPosition(getEventIndex(store.events), all[0]!.event_id);
            }
            arrays.push(store.events);
        }
        store.append(all.slice(18_000, 20_000));
        store.append(all.slice(16_000, 18_000)); // merged into the middle: rebuilt
        arrays.push(store.events);
        const probes = [all[0]!, all[1_999]!, all[7_000]!, all[15_999]!, all[17_000]!, all[19_999]!].map((e) => e.event_id);
        probes.push("not-an-id");
        // Newest first: the shared id map then already holds ids past the older arrays' ends.
        for (const events of [...arrays].reverse()) {
            const index = getEventIndex(events);
            const ref = fresh(events);
            expect(index.originNs).toBe(ref.originNs);
            expect(index.durationNs).toBe(ref.durationNs);
            expect(Array.from(index.rel)).toEqual(Array.from(ref.rel));
            expect(Array.from(index.cls)).toEqual(Array.from(ref.cls));
            for (const id of probes) {
                expect(eventPosition(index, id)).toBe(eventPosition(ref, id));
            }
        }
    });
});
