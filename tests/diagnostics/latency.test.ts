import { describe, expect, it } from "vitest";
import { syntheticStream } from "../../src/diagnostics/fixtures";
import { assertEvidence, detect, getCase } from "./helpers";

describe("latency-outlier detector", () => {
    it("flags the slow request against the rolling p95", () => {
        const c = getCase("latency-outlier", "positive");
        const f = detect("latency-outlier", c.events);
        assertEvidence(f, c.events);
        expect(f).toHaveLength(1);
        expect(f[0]!.facts).toMatchObject({ request_id: "req_7", duration_ms: 3200, baseline_p95_ms: 420, baseline_requests: 7, outcome: "completed" });
        expect(f[0]!.severity).toBe("critical");
    });

    it("minBaseline and factor are configurable", () => {
        const c = getCase("latency-outlier", "positive");
        expect(detect("latency-outlier", c.events, { latency: { minBaseline: 10 } })).toEqual([]);
        expect(detect("latency-outlier", c.events, { latency: { factor: 5 } })[0]!.severity).toBe("warning");
    });

    it("cancelled and unfinished requests are excluded; failed requests are evaluated", () => {
        const e = syntheticStream("lat_misc");
        const events = [];
        for (let i = 0; i < 5; i++) {
            events.push(e(i * 1000, "request.started", {}, { request_id: `r${i}` }), e(i * 1000 + 100, "request.completed", {}, { request_id: `r${i}` }));
        }
        events.push(e(6000, "request.started", {}, { request_id: "cx" }), e(16000, "request.cancelled", {}, { request_id: "cx" }));
        events.push(e(17000, "request.started", {}, { request_id: "open" }));
        events.push(e(18000, "request.started", {}, { request_id: "bad" }), e(19000, "request.failed", {}, { request_id: "bad" }));
        const f = detect("latency-outlier", events);
        expect(f).toHaveLength(1);
        expect(f[0]!.facts.outcome).toBe("failed");
    });

    it("negative case: no findings", () => {
        expect(detect("latency-outlier", getCase("latency-outlier", "negative").events)).toEqual([]);
    });

    it("scopes request_id tracking per producer stream so one producer cancelling does not clear another", () => {
        const e = syntheticStream("lat_multi");
        const infA = { name: "sonder-inference", version: "1", node_id: "n1", instance_id: "tel-a" };
        const infB = { name: "sonder-inference", version: "1", node_id: "n2", instance_id: "tel-b" };
        const events = [];
        for (let i = 0; i < 5; i += 1) {
            events.push(
                e(i * 1000, "request.started", {}, { request_id: `r${i}`, producer: infA }),
                e(i * 1000 + 100, "request.completed", {}, { request_id: `r${i}`, producer: infA }),
            );
        }
        // Producer A starts shared-id; Producer B starts & cancels the same request_id; Producer A finishes slow.
        events.push(
            e(6000, "request.started", {}, { request_id: "shared-id", producer: infA }),
            e(6010, "request.started", {}, { request_id: "shared-id", producer: infB }),
            e(6020, "request.cancelled", {}, { request_id: "shared-id", producer: infB }),
            e(9000, "request.completed", {}, { request_id: "shared-id", producer: infA }),
        );
        const f = detect("latency-outlier", events);
        expect(f).toHaveLength(1);
        expect(f[0]!.facts.request_id).toBe("shared-id");
        expect(f[0]!.facts.duration_ms).toBe(3000);
    });
});
