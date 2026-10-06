import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { analyzeSession } from "../../src/compare/summary";
import { CompareController } from "../../src/compare/controller";
import { parseNdjson } from "../../src/recording/ndjson";
import { makeEvent } from "../helpers";
import { validateEvent } from "../../src/protocol/validate";

function largeText(): string {
    const lines = new Array<string>(131072);
    for (let i = 0; i < lines.length; i += 1) {
        lines[i] = JSON.stringify({ schema: "sonder.observatory.event/1", event_id: `compare_min_evt_${String(i).padStart(6, "0")}`, sequence: i, event_type: "request.started", wall_time: "2026-10-06T00:00:00.000Z", mono_ns: 1000 + i, session_id: "compare_min_session", run_id: "compare_min_run", agent_id: null, task_id: null, request_id: `compare_min_req_${String(i).padStart(6, "0")}`, parent_request_id: null, model_instance_id: null, producer: { name: "compare-minimum-synthetic", version: "1", node_id: "synthetic-node", instance_id: "fixed-instance", synthetic: true }, attributes: { turn_id: "compare_min_turn" } });
    }
    return lines.join("\n") + "\n";
}

describe("Compare minimum over complete request facts", () => {
    it("keeps an empty session at zero with unknown metrics", () => {
        const a = analyzeSession([]);
        expect(a.eventCount).toBe(0);
        expect(a.totals.firstNs).toBe(0);
        expect(a.totals.requests).toBe(0);
        expect(a.totals.completionTokens).toBeNull();
        expect(a.totals.ttftMs).toBeNull();
        for (const g of Object.values(a.groups)) expect(g.units).toEqual([]);
    });

    it("keeps fact attribution and native signed-zero request reduction", () => {
        const events = [
            makeEvent({ event_type: "test.event", mono_ns: 0, request_id: null, run_id: null, attributes: {} }),
            makeEvent({ event_type: "request.started", mono_ns: 10, request_id: "r", run_id: null, attributes: {} }),
            makeEvent({ event_type: "request.completed", mono_ns: 20, request_id: "r", run_id: "R", attributes: { turn_id: "T" } }),
        ];
        const a = analyzeSession([...events].reverse());
        expect(a.totals.firstNs).toBe(0);
        expect(a.groups.run.units).toHaveLength(1);
        expect(a.groups.turn.units).toHaveLength(1);
        for (const g of [a.groups.run, a.groups.turn]) {
            expect(g.units[0]!.firstNs).toBe(10);
            expect(g.units[0]!.events).toBe(2);
            expect(g.units[0]!.requests).toBe(1);
            expect(g.units[0]!.completionTokens).toBeNull();
        }
        expect(a.requests[0]!.startNs).toBe(10);
        expect(a.requests[0]!.runId).toBe("R");
        expect(a.requests[0]!.turn).toBe("T");
        expect(a.groups.request.units[0]!.events).toBe(2);
        expect(a.groups.request.units[0]!.firstNs).toBe(10);


        // Complete facts also attribute the earlier start to R/T; this is continuity,
        // not an earlier-than-group-seed control. Direct objects retain signed zero.
        const signed = [
            makeEvent({ event_type: "test.event", event_id: "minimum_plus_zero", sequence: 0, mono_ns: +0, request_id: null, run_id: "R", attributes: { turn_id: "T" } }),
            makeEvent({ event_type: "request.started", event_id: "minimum_minus_zero", sequence: 1, mono_ns: -0, request_id: "zero-request", run_id: "R", attributes: { turn_id: "T" } }),
        ];
        for (const event of signed) expect(validateEvent(event).ok).toBe(true);
        expect(Object.is(signed[0]!.mono_ns, +0)).toBe(true);
        expect(Object.is(signed[1]!.mono_ns, -0)).toBe(true);
        const zero = analyzeSession(signed);
        expect(Object.is(zero.totals.firstNs, -0)).toBe(true);
        for (const group of [zero.groups.run, zero.groups.turn]) {
            expect(group.units).toHaveLength(1);
            expect(group.units[0]!.events).toBe(2);
            expect(group.units[0]!.requests).toBe(1);
            expect(Object.is(group.units[0]!.firstNs, -0)).toBe(true);
        }
        expect(Object.is(signed[1]!.mono_ns, -0)).toBe(true);
    });

    it("retains every parsed request in a complete large analysis", () => {
        const text = largeText(), parsed = parseNdjson(text), count = 131072;
        expect(parsed.rejected).toEqual([]);
        expect(parsed.records).toEqual([]);
        expect(parsed.events).toHaveLength(count);
        const before = createHash("sha256").update(JSON.stringify(parsed.events)).digest("hex");
        const a = analyzeSession(parsed.events);
        expect(a.synthetic).toBe(true);
        expect(a.eventCount).toBe(count);
        expect(a.totals.events).toBe(count);
        expect(a.totals.requests).toBe(count);
        expect(a.totals.firstNs).toBe(1000);
        expect(a.requests).toHaveLength(count);
        expect(a.groups.request.units).toHaveLength(count);
        for (const mode of ["run", "turn"] as const) {
            expect(a.groups[mode].units).toHaveLength(1);
            expect(a.groups[mode].units[0]!.requests).toBe(count);
            expect(a.groups[mode].units[0]!.events).toBe(count);
            expect(a.groups[mode].units[0]!.firstNs).toBe(1000);
        }
        for (let i = 0; i < count; i += 1) {
            const id = `compare_min_req_${String(i).padStart(6, "0")}`;
            if (a.requests[i]!.requestId !== id || a.groups.request.units[i]!.key !== id || a.requests[i]!.startNs !== 1000 + i) throw new Error(`Complete request order lost at ${i}`);
        }
        for (const key of ["ttftMs", "ttftP95Ms", "decodeTokPerSec", "promptTokens", "completionTokens", "costUsd", "budgetPeakFraction", "cacheHitRate"] as const) expect(a.totals[key]).toBeNull();
        for (const g of Object.values(a.groups)) expect(g.unattributedEvents).toBe(0);
        expect(createHash("sha256").update(JSON.stringify(parsed.events)).digest("hex")).toBe(before);
        expect(a.findings).toEqual([]);
        expect(a.topology).toEqual({ nodes: [], edges: [], unattachedDiagnostics: [], atMonoNs: null, consideredEvents: count, mappedEvents: 0, unmappedEventIds: [] });
    });

    it("keeps current and recorded analyses stable until source replacement", () => {
        const events = [makeEvent({ event_type: "request.started", request_id: "r", mono_ns: 10 })];
        const c = new CompareController();
        c.setCurrent(events);
        const first = c.analysis("b");
        expect(c.analysis("b")).toBe(first);
        c.setRecording("a", events, "synthetic recording");
        expect(c.analysis("a")).toEqual(first);
        c.setCurrent([makeEvent({ event_type: "request.started", request_id: "replacement", mono_ns: 3 })]);
        const next = c.analysis("b");
        expect(next).not.toBe(first);
        expect(next!.totals.firstNs).toBe(3);
        expect(next!.requests[0]!.requestId).toBe("replacement");
    });
});
