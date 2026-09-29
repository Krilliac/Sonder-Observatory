import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateEvents } from "../../scripts/gen-large-fixture.mjs";
import type { ObservatoryEvent } from "../../src/protocol/events";
import { parseNdjson } from "../../src/recording/ndjson";
import { orderEvents } from "../../src/replay/order";
import { SessionStore } from "../../src/replay/session";
import { deriveTopology, getTopologyTimeline, isTopologyEvent, TOPOLOGY_SNAPSHOT_EVERY, TopologyTimeline } from "../../src/topology/derive";
import { topologyFixtureEvents } from "../../src/topology/fixtures/topology-synthetic";

const root = fileURLToPath(new URL("../..", import.meta.url));
const m1Events = parseNdjson(readFileSync(join(root, "fixtures/synthetic-session.ndjson"), "utf8")).events;
// Enough topology events (~2.6% of the large fixture) for several snapshots.
const large = orderEvents([...generateEvents(60_000, 7)] as ObservatoryEvent[]).events;

/** Cursor times worth checking: before the first event, every k-th event time, just after it, and the end. */
function probeTimes(events: readonly ObservatoryEvent[], samples: number): number[] {
    const sorted = orderEvents(events).events;
    const out = [sorted[0]!.mono_ns - 1];
    const step = Math.max(1, Math.floor(sorted.length / samples));
    for (let i = 0; i < sorted.length; i += step) {
        out.push(sorted[i]!.mono_ns, sorted[i]!.mono_ns + 1);
    }
    out.push(sorted.at(-1)!.mono_ns, sorted.at(-1)!.mono_ns + 1e12);
    return out;
}

describe("TopologyTimeline equals deriveTopology", () => {
    it.each([
        ["M1 synthetic fixture", m1Events],
        ["topology fixture", topologyFixtureEvents()],
    ] as const)("%s, unordered input with duplicates", (_name, events) => {
        const shuffled = [...events].reverse();
        shuffled.push(shuffled[3]!);
        const timeline = new TopologyTimeline(shuffled);
        expect(timeline.graphAt(null)).toEqual(deriveTopology(shuffled));
        for (const t of probeTimes(events, 60)) {
            expect(timeline.graphAt(t)).toEqual(deriveTopology(shuffled, { atMonoNs: t }));
        }
    });

    it("on a large session with snapshots, scrubbing in any order", () => {
        const topo = large.filter((e) => isTopologyEvent(e.event_type)).length;
        expect(topo).toBeGreaterThan(3 * TOPOLOGY_SNAPSHOT_EVERY);
        const timeline = getTopologyTimeline(large);
        const times = probeTimes(large, 40);
        for (const t of [...times].reverse()) {
            expect(timeline.graphAt(t)).toEqual(deriveTopology(large, { atMonoNs: t }));
        }
        expect(timeline.graphAt(null)).toEqual(deriveTopology(large));
    });

    it("graphs are independent copies (mutating one does not change the next)", () => {
        const timeline = getTopologyTimeline(large);
        const t = large[Math.floor(large.length / 2)]!.mono_ns;
        const a = timeline.graphAt(t);
        a.nodes[0]!.evidence.push("mutated");
        a.nodes[0]!.status = "failed";
        a.unmappedEventIds.push("mutated");
        expect(timeline.graphAt(t)).toEqual(deriveTopology(large, { atMonoNs: t }));
        expect(timeline.graphAt(null)).toEqual(deriveTopology(large));
    });

    it("continues across in-order live appends and restarts after out-of-order ones", () => {
        const store = new SessionStore();
        store.reset("live", "test");
        const arrays: (readonly ObservatoryEvent[])[] = [];
        for (let i = 0; i < 20_000; i += 1_700) {
            store.append(large.slice(i, i + 1_700));
            // Build (and extend) the timeline for every intermediate array, as the panel does.
            getTopologyTimeline(store.events).graphAt(null);
            arrays.push(store.events);
        }
        // A late batch merges into the middle: not a prefix extension.
        store.append(large.slice(25_000, 26_000));
        store.append(large.slice(20_000, 25_000));
        arrays.push(store.events);
        for (const events of arrays) {
            const timeline = getTopologyTimeline(events);
            expect(timeline.graphAt(null)).toEqual(deriveTopology(events));
            const mid = events[Math.floor(events.length / 2)]!.mono_ns;
            expect(timeline.graphAt(mid)).toEqual(deriveTopology(events, { atMonoNs: mid }));
        }
    });

    it("is empty for an empty session", () => {
        expect(new TopologyTimeline([]).graphAt(null)).toEqual(deriveTopology([]));
        expect(new TopologyTimeline([]).graphAt(0)).toEqual(deriveTopology([], { atMonoNs: 0 }));
    });
});

describe("TopologyTimeline cost", () => {
    it("replays at most one snapshot interval of topology events per scrub", () => {
        const timeline = getTopologyTimeline(large);
        let worst = 0;
        for (const t of probeTimes(large, 200)) {
            timeline.graphAt(t);
            worst = Math.max(worst, timeline.lastReplayed);
        }
        expect(worst).toBeGreaterThan(0);
        expect(worst).toBeLessThanOrEqual(TOPOLOGY_SNAPSHOT_EVERY);
    });
});
