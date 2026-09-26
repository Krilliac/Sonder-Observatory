import { describe, expect, it } from "vitest";
import { classifyEvent } from "../../src/query/classify";
import { bucketize, columnOf, getEventIndex, nearestInTrack, TimelineLod, TRACKS } from "../../src/renderer/timelineModel";
import { rng } from "../../scripts/gen-large-fixture.mjs";
import { largeEvents } from "./helpers";

describe("timeline level-of-detail model", () => {
    const events = largeEvents(10_000);
    const index = getEventIndex(events);

    it("indexes class and relative time once per events array", () => {
        expect(getEventIndex(events)).toBe(index);
        expect(index.rel.length).toBe(events.length);
        for (let i = 0; i < events.length; i += 97) {
            expect(TRACKS[index.cls[i]!]).toBe(classifyEvent(events[i]!));
            expect(index.rel[i]).toBe(events[i]!.mono_ns - events[0]!.mono_ns);
        }
    });

    it("buckets match a naive per-event count", () => {
        const width = 613;
        const t0 = index.durationNs * 0.2;
        const t1 = index.durationNs * 0.7;
        const b = bucketize(index, width, t0, t1);
        const naive = new Uint32Array(TRACKS.length * width);
        let total = 0;
        for (let i = 0; i < events.length; i += 1) {
            const rel = index.rel[i]!;
            if (rel < t0 || rel > t1) {
                continue;
            }
            total += 1;
            naive[index.cls[i]! * width + columnOf(rel, t0, t1, width)]! += 1;
        }
        expect(b.total).toBe(total);
        expect([...b.counts]).toEqual([...naive]);
    });

    it("caches buckets across cursor moves", () => {
        const lod = new TimelineLod();
        const a = lod.get(index, 800);
        for (let i = 0; i < 50; i += 1) {
            expect(lod.get(index, 800)).toBe(a);
        }
        expect(lod.misses).toBe(1);
        expect(lod.get(index, 801)).not.toBe(a);
    });

    it("nearestInTrack agrees with a linear scan", () => {
        const rand = rng(99);
        for (let q = 0; q < 300; q += 1) {
            const t = rand() * index.durationNs;
            const track = q % 3 === 0 ? -1 : Math.floor(rand() * TRACKS.length);
            const maxDist = index.durationNs * 0.01;
            let bestD = Infinity;
            for (let i = 0; i < events.length; i += 1) {
                if (track >= 0 && index.cls[i] !== track) {
                    continue;
                }
                const d = Math.abs(index.rel[i]! - t);
                if (d < bestD) {
                    bestD = d;
                }
            }
            const got = nearestInTrack(index, t, track, maxDist);
            if (bestD > maxDist) {
                expect(got).toBe(-1);
            } else {
                expect(Math.abs(index.rel[got]! - t)).toBe(bestD);
                expect(track < 0 || index.cls[got] === track).toBe(true);
            }
        }
    });

    it("handles empty sessions", () => {
        const empty = getEventIndex([]);
        expect(empty.durationNs).toBe(0);
        expect(bucketize(empty, 100).total).toBe(0);
        expect(nearestInTrack(empty, 0, -1)).toBe(-1);
    });
});
