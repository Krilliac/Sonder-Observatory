/**
 * Performance budgets on a deterministic 100k-event fixture.
 *
 * Thresholds are deliberately generous (several times the numbers measured on
 * the development box, see docs/integration/perf.md) so shared CI runners on
 * Node 20/22 do not flake; they exist to catch order-of-magnitude
 * regressions such as reintroducing per-render O(n) work in the timeline or
 * table. SOBS_PERF_BUDGET_SCALE multiplies every budget.
 */
import { describe, expect, it } from "vitest";
import { deriveMetrics } from "../../src/query/metrics";
import { loadRecording } from "../../src/recording/sobs";
import { loadRecordingChunked } from "../../src/renderer/chunkedLoad";
import { drawTimeline, timelineGeometry, type TimelineContext } from "../../src/renderer/timelineCanvas";
import { bucketize, getEventIndex, nearestInTrack, TimelineLod } from "../../src/renderer/timelineModel";
import { computeWindow, FilteredRows } from "../../src/renderer/virtualWindow";
import { BUDGET_SCALE, largeEvents, largeText, timeMs } from "./helpers";

const N = 100_000;
const budget = (ms: number) => ms * BUDGET_SCALE;
const LONG = 120_000;

const noopCtx: TimelineContext = {
    fillStyle: "",
    strokeStyle: "",
    globalAlpha: 1,
    lineWidth: 1,
    font: "",
    textBaseline: "alphabetic",
    fillRect: () => {},
    strokeRect: () => {},
    clearRect: () => {},
    fillText: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    setLineDash: () => {},
};

describe(`perf budgets (${N} events)`, () => {
    it("parses 100k events synchronously in under 15 s", () => {
        const text = largeText(N);
        const { ms, value } = timeMs(() => loadRecording(text));
        expect(value.events.length).toBe(N);
        expect(value.rejected).toEqual([]);
        expect(ms).toBeLessThan(budget(15_000));
    }, LONG);

    it("parses 100k events in chunks under 20 s with no slice over 250 ms", async () => {
        const text = largeText(N);
        let longest = 0;
        let last = performance.now();
        const started = last;
        const loaded = await loadRecordingChunked(text, {
            onProgress: () => {
                const now = performance.now();
                longest = Math.max(longest, now - last);
                last = now;
            },
            yieldToEventLoop: () =>
                new Promise((resolve) =>
                    setImmediate(() => {
                        last = performance.now();
                        resolve();
                    }),
                ),
        });
        expect(loaded.events.length).toBe(N);
        expect(performance.now() - started).toBeLessThan(budget(20_000));
        expect(longest).toBeLessThan(budget(250));
    }, LONG);

    it("builds the class/time index in under 1 s", () => {
        const events = largeEvents(N);
        const { ms } = timeMs(() => getEventIndex([...events]));
        expect(ms).toBeLessThan(budget(1_000));
    }, LONG);

    it("buckets 100k events for a 1600 px timeline in under 250 ms; cached scrub frames under 5 ms", () => {
        const events = largeEvents(N);
        const index = getEventIndex(events);
        const g = timelineGeometry(1600);
        const lod = new TimelineLod();
        const cold = timeMs(() => lod.get(index, g.plotW));
        expect(cold.value.total).toBe(N);
        expect(cold.ms).toBeLessThan(budget(250));
        const requests = deriveMetrics(events).requests;
        // Simulate scrubbing across the session: 60 cursor positions.
        const frames: number[] = [];
        for (let f = 0; f < 60; f += 1) {
            const cursorRel = (index.durationNs * f) / 59;
            frames.push(
                timeMs(() =>
                    drawTimeline(noopCtx, {
                        geometry: g,
                        index,
                        buckets: lod.get(index, g.plotW),
                        cursorRel,
                        requests,
                        selectedId: events[f * 1000]!.event_id,
                        highlighted: new Set(),
                    }),
                ).ms,
            );
        }
        frames.sort((a, b) => a - b);
        expect(lod.misses).toBe(1);
        expect(frames[Math.floor(frames.length * 0.95)]!).toBeLessThan(budget(5 * 4));
        expect(frames[Math.floor(frames.length / 2)]!).toBeLessThan(budget(5));
    }, LONG);

    it("zoomed re-bucketing and click hit-testing stay fast", () => {
        const index = getEventIndex(largeEvents(N));
        const zoom = timeMs(() => bucketize(index, 1500, index.durationNs * 0.4, index.durationNs * 0.45));
        expect(zoom.ms).toBeLessThan(budget(50));
        const clicks = timeMs(() => {
            for (let i = 0; i < 1_000; i += 1) {
                nearestInTrack(index, (index.durationNs * i) / 1000, i % 9, index.durationNs * 0.01);
            }
        });
        expect(clicks.ms).toBeLessThan(budget(250));
    }, LONG);

    it("computes the table render window in under 2 ms per scroll frame", () => {
        const events = largeEvents(N);
        const rows = new FilteredRows();
        rows.update(events, { cls: "all", text: "" });
        const { ms } = timeMs(() => {
            for (let f = 0; f < 1_000; f += 1) {
                const count = rows.countBefore(Math.floor((N * f) / 1000));
                const w = computeWindow({ scrollTop: f * 997, viewportHeight: 600, rowHeight: 22, rowCount: count });
                for (let r = w.start; r < w.end; r += 1) {
                    rows.positionOf(r);
                }
            }
        });
        expect(ms / 1_000).toBeLessThan(budget(2));
    }, LONG);

    it("filters 100k rows in under 500 ms and scrubs a filtered table in O(log n)", () => {
        const events = largeEvents(N);
        const rows = new FilteredRows();
        const filter = timeMs(() => rows.update(events, { cls: "all", text: "tool" }));
        expect(filter.value).toBeGreaterThan(0);
        expect(filter.ms).toBeLessThan(budget(500));
        const scrub = timeMs(() => {
            for (let f = 0; f < 10_000; f += 1) {
                rows.countBefore(Math.floor((N * f) / 10_000));
            }
        });
        expect(scrub.ms).toBeLessThan(budget(50));
    }, LONG);
});
