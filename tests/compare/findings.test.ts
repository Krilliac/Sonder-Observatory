import { describe, expect, it } from "vitest";
import { compareSessions } from "../../src/compare/compare";
import { diffFindings, findingSignature } from "../../src/compare/findings";
import type { Finding } from "../../src/diagnostics";
import type { ObservatoryEvent } from "../../src/protocol/events";
import { at } from "../helpers";

function finding(kind: Finding["kind"], facts: Finding["facts"], startNs = 0): Finding {
    return {
        id: `${kind}:${startNs}`,
        kind,
        severity: "warning",
        startNs,
        endNs: startNs,
        summary: "",
        evidenceEventIds: [`e${startNs}`],
        facts,
        provenance: "derived",
    };
}

describe("findings diff subjects", () => {
    it("does not pair latency outliers on different requests", () => {
        const a = [finding("latency-outlier", { request_id: "req-x", duration_ms: 900 })];
        const b = [finding("latency-outlier", { request_id: "req-y", duration_ms: 950 })];
        const d = diffFindings(a, b);
        expect(d.persisting).toEqual([]);
        expect(d.resolved.map((f) => f.facts.request_id)).toEqual(["req-x"]);
        expect(d.added.map((f) => f.facts.request_id)).toEqual(["req-y"]);
    });

    it("pairs a latency outlier on the same request", () => {
        const d = diffFindings([finding("latency-outlier", { request_id: "req-x" })], [finding("latency-outlier", { request_id: "req-x" }, 5)]);
        expect(d.persisting).toHaveLength(1);
    });

    it("does not pair retry storms on disjoint targets, and ignores target order", () => {
        const a = [finding("retry-storm", { retries: 4, targets: "call-1, call-2" })];
        const b = [finding("retry-storm", { retries: 4, targets: "call-3" })];
        const d = diffFindings(a, b);
        expect(d.persisting).toEqual([]);
        expect([d.resolved.length, d.added.length]).toEqual([1, 1]);
        expect(findingSignature(finding("retry-storm", { targets: "b, a" }))).toBe(findingSignature(finding("retry-storm", { targets: "a, b" })));
    });

    it("maps B request ids onto A through a subject map (requests aligned by position)", () => {
        const a = [finding("latency-outlier", { request_id: "a-1" })];
        const b = [finding("latency-outlier", { request_id: "b-1" }), finding("retry-storm", { targets: "b-2" })];
        const map = new Map([
            ["b-1", "a-1"],
            ["b-2", "a-2"],
        ]);
        const d = diffFindings(a, b, (id) => map.get(id) ?? id);
        expect(d.persisting.map((p) => p.b.facts.request_id)).toEqual(["b-1"]);
        expect(findingSignature(b[1]!, (id) => map.get(id) ?? id)).toBe("retry-storm|targets=a-2");
    });

    // Eight requests; `slow` (index) takes 3200 ms, the rest ~400 ms.
    const stream = (prefix: string, slow: number): ObservatoryEvent[] => {
        const out: ObservatoryEvent[] = [];
        let t = 0;
        for (let i = 0; i < 8; i += 1) {
            const d = i === slow ? 3200 : 400 + (i % 3) * 10;
            out.push(at(t, "request.started", { request_id: `${prefix}${i}`, event_id: `${prefix}s${i}` }));
            out.push(at(t + d, "request.completed", { request_id: `${prefix}${i}`, event_id: `${prefix}c${i}` }));
            t += d + 100;
        }
        return out;
    };
    const outliers = (c: ReturnType<typeof compareSessions>) => ({
        persisting: c.findings.persisting.filter((p) => p.a.kind === "latency-outlier").length,
        added: c.findings.added.filter((f) => f.kind === "latency-outlier").length,
        resolved: c.findings.resolved.filter((f) => f.kind === "latency-outlier").length,
    });

    it("compareSessions pairs an outlier on the position-aligned request when ids differ", () => {
        const c = compareSessions(stream("a_req_", 7), stream("b_req_", 7), "request");
        expect(c.alignment.matchedBy).toBe("position");
        expect(outliers(c)).toEqual({ persisting: 1, added: 0, resolved: 0 });
        // Same result in another view mode (the findings diff uses the request alignment).
        expect(outliers(compareSessions(stream("a_req_", 7), stream("b_req_", 7), "run"))).toEqual(outliers(c));
    });

    it("compareSessions reports resolved + new when the outlier moves to another request", () => {
        const c = compareSessions(stream("req_", 7), stream("req_", 6), "request");
        expect(c.alignment.matchedBy).toBe("id");
        expect(outliers(c)).toEqual({ persisting: 0, added: 1, resolved: 1 });
    });
});
