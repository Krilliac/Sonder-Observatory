import { describe, expect, it } from "vitest";
import { runDiagnostics } from "../../src/diagnostics";
import { buildReport, describeRange, filterEvents, isFullRange } from "../../src/export";
import { classifyEvent } from "../../src/query/classify";
import { deriveMetrics } from "../../src/query/metrics";
import { fixtureEvents, GENERATED_AT } from "./fixture";

const events = fixtureEvents();

describe("export range filter", () => {
    it("returns the input array for a full range", () => {
        expect(isFullRange({})).toBe(true);
        expect(isFullRange({ cls: "all", text: "  " })).toBe(true);
        expect(filterEvents(events, {})).toBe(events);
    });

    it("filters by class, text and inclusive time window like the event table", () => {
        const errors = filterEvents(events, { cls: "error" });
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.every((e) => classifyEvent(e) === "error")).toBe(true);

        const tool = filterEvents(events, { text: "TOOL." });
        expect(tool.length).toBeGreaterThan(0);
        expect(tool.every((e) => `${e.event_type} ${e.event_id}`.toLowerCase().includes("tool."))).toBe(true);

        const from = events[10]!.mono_ns;
        const to = events[20]!.mono_ns;
        const window = filterEvents(events, { fromNs: from, toNs: to });
        expect(window[0]!.mono_ns).toBe(from);
        expect(window[window.length - 1]!.mono_ns).toBe(to);
        expect(window.every((e, i) => i === 0 || e.mono_ns >= window[i - 1]!.mono_ns)).toBe(true);
    });

    it("describes ranges relative to the session origin", () => {
        const o = events[0]!.mono_ns;
        expect(describeRange({}, o)).toBe("full session");
        expect(describeRange({ cls: "error", text: "tool", fromNs: o + 1e9, toNs: o + 4e9 }, o)).toBe('class=error · text="tool" · 1.000 s–4.000 s');
        expect(describeRange({ toNs: o + 2.5e9 }, o)).toBe("start–2.500 s");
    });
});

describe("buildReport (fixture)", () => {
    const report = buildReport({ events, generatedAt: GENERATED_AT });

    it("uses the public metrics and diagnostics APIs unchanged", () => {
        expect(report.metrics).toEqual(deriveMetrics(events));
        expect(report.findings.map((f) => f.id)).toEqual(runDiagnostics(events).map((f) => f.id));
        expect(report.findings.length).toBeGreaterThan(0);
    });

    it("resolves every cited evidence event", () => {
        const ids = new Set(events.map((e) => e.event_id));
        for (const f of report.findings) {
            expect(f.evidence.map((e) => e.eventId)).toEqual(f.evidenceEventIds);
            for (const ev of f.evidence) {
                expect(ids.has(ev.eventId)).toBe(true);
                expect(ev.relS).not.toBeNull();
                expect(ev.eventType).not.toBe("unknown");
            }
            expect(f.endRelS).toBeGreaterThanOrEqual(f.startRelS);
        }
    });

    it("includes topology and a timeline snapshot covering every event", () => {
        expect(report.topology.nodes.length).toBeGreaterThan(0);
        expect(report.topology.edges.length).toBeGreaterThan(0);
        expect(report.timeline.total).toBe(events.length);
        const sum = report.timeline.counts.flat().reduce((a, b) => a + b, 0);
        expect(sum).toBe(events.length);
        expect(report.timeline.counts.every((row) => row.length === report.timeline.width)).toBe(true);
    });

    it("describes the source", () => {
        expect(report.source.sessionIds).toEqual(["ses_synthetic_0001"]);
        expect(report.source.exportedEvents).toBe(events.length);
        expect(report.source.synthetic).toBe(true);
        expect(report.generatedAt).toBe("2026-09-26T12:00:00.000Z");
    });

    it("covers only the selected range when filtered", () => {
        const cut = events[Math.floor(events.length / 2)]!.mono_ns;
        const r = buildReport({ events, range: { toNs: cut }, generatedAt: GENERATED_AT });
        expect(r.source.exportedEvents).toBeLessThan(events.length);
        expect(r.source.totalEvents).toBe(events.length);
        expect(r.metrics.eventCount).toBe(r.source.exportedEvents);
        for (const f of r.findings) {
            expect(f.endNs).toBeLessThanOrEqual(cut);
        }
    });

    it("handles an empty session", () => {
        const r = buildReport({ events: [], generatedAt: GENERATED_AT });
        expect(r.findings).toEqual([]);
        expect(r.source.durationS).toBe(0);
        expect(r.timeline.total).toBe(0);
    });
});
