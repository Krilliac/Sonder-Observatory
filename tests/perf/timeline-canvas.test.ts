import { describe, expect, it } from "vitest";
import { deriveMetrics } from "../../src/query/metrics";
import { drawTimeline, timelineGeometry, type TimelineContext } from "../../src/renderer/timelineCanvas";
import { bucketize, getEventIndex, TRACKS } from "../../src/renderer/timelineModel";
import { largeEvents } from "./helpers";

/** Records draw calls instead of painting. */
function fakeContext(): TimelineContext & { calls: Record<string, number> } {
    const calls: Record<string, number> = {};
    const count = (name: string) => () => {
        calls[name] = (calls[name] ?? 0) + 1;
    };
    return {
        calls,
        fillStyle: "",
        strokeStyle: "",
        globalAlpha: 1,
        lineWidth: 1,
        font: "",
        textBaseline: "alphabetic",
        fillRect: count("fillRect"),
        strokeRect: count("strokeRect"),
        clearRect: count("clearRect"),
        fillText: count("fillText"),
        beginPath: count("beginPath"),
        moveTo: count("moveTo"),
        lineTo: count("lineTo"),
        stroke: count("stroke"),
        setLineDash: count("setLineDash"),
    };
}

describe("drawTimeline", () => {
    it("bounds draw calls by tracks x width, not by event count", () => {
        const events = largeEvents(10_000);
        const index = getEventIndex(events);
        const g = timelineGeometry(1200);
        const buckets = bucketize(index, g.plotW);
        const ctx = fakeContext();
        const selected = events[1234]!.event_id;
        const stats = drawTimeline(ctx, {
            geometry: g,
            index,
            buckets,
            cursorRel: index.durationNs / 2,
            requests: deriveMetrics(events).requests,
            selectedId: selected,
            highlighted: new Set(events.slice(0, 50).map((e) => e.event_id)),
        });
        expect(stats.tickRects).toBeGreaterThan(0);
        expect(stats.tickRects).toBeLessThanOrEqual(TRACKS.length * g.plotW);
        expect(stats.evidenceRects).toBe(50);
        expect(ctx.calls.fillText).toBe(TRACKS.length);
        expect(ctx.calls.fillRect!).toBeLessThan(TRACKS.length * g.plotW + stats.spanRects + 200);
    });

    it("draws nothing but chrome for an empty session", () => {
        const index = getEventIndex([]);
        const g = timelineGeometry(400);
        const stats = drawTimeline(fakeContext(), {
            geometry: g,
            index,
            buckets: bucketize(index, g.plotW),
            cursorRel: 0,
            requests: [],
            selectedId: null,
            highlighted: new Set(),
        });
        expect(stats).toEqual({ tickRects: 0, spanRects: 0, evidenceRects: 0 });
    });
});
