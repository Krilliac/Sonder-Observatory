import { describe, expect, it } from "vitest";
import { classifyEvent, isErrorEvent } from "../src/query/classify";
import { deriveMetrics, percentile } from "../src/query/metrics";
import { at } from "./helpers";

describe("percentile", () => {
    it("uses nearest rank", () => {
        expect(percentile([], 50)).toBeNull();
        expect(percentile([5], 95)).toBe(5);
        expect(percentile([4, 1, 3, 2], 50)).toBe(2);
        expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    });
});

describe("deriveMetrics", () => {
    it("returns unavailable (null) values for an empty stream", () => {
        const m = deriveMetrics([]);
        expect(m.eventCount).toBe(0);
        expect(m.requestLatency).toEqual({ count: 0, p50Ms: null, p95Ms: null, maxMs: null });
        expect(m.tokens.overallRate).toBeNull();
        expect(m.tokens.recentRate).toBeNull();
        expect(m.resources.latest).toBeNull();
    });

    it("derives request latency and time to first token from request ids", () => {
        const m = deriveMetrics([
            at(0, "request.started", { request_id: "r1" }),
            at(100, "inference.token.generated", { request_id: "r1" }),
            at(150, "inference.token.generated", { request_id: "r1" }),
            at(200, "request.completed", { request_id: "r1" }),
            at(300, "request.started", { request_id: "r2" }),
            at(340, "inference.token.generated", { request_id: "r2" }),
            at(700, "request.failed", { request_id: "r2" }),
            at(800, "request.started", { request_id: "r3" }),
        ]);
        expect(m.requests.map((r) => r.outcome)).toEqual(["completed", "failed", "open"]);
        expect(m.requestLatency.count).toBe(2);
        expect(m.requestLatency.p50Ms).toBe(200);
        expect(m.requestLatency.maxMs).toBe(400);
        expect(m.timeToFirstToken.p50Ms).toBe(40);
        expect(m.timeToFirstToken.p95Ms).toBe(100);
        expect(m.requests[0]!.tokens).toBe(2);
    });

    it("ignores completion events for unknown requests", () => {
        const m = deriveMetrics([at(10, "request.completed", { request_id: "ghost" })]);
        expect(m.requests).toEqual([]);
        expect(m.requestLatency.count).toBe(0);
    });

    it("computes token rates, honouring an explicit batch count", () => {
        const events = [];
        for (let i = 0; i <= 10; i += 1) {
            events.push(at(i * 100, "inference.token.generated"));
        }
        events.push(at(1000.5 * 1, "inference.token.generated", { event_id: "batch", attributes: { count: 9 } }));
        const m = deriveMetrics(events);
        expect(m.tokens.total).toBe(20);
        expect(m.tokens.overallRate).toBeCloseTo(20 / 1.0005, 3);
        // All 20 tokens fall inside the trailing 5 s window.
        expect(m.tokens.recentRate).toBe(4);
    });

    it("counts errors including retries and guards", () => {
        const events = [
            at(1, "tool.failed"),
            at(2, "retry.scheduled"),
            at(3, "guard.no_progress"),
            at(4, "request.failed", { request_id: "r" }),
            at(5, "tool.completed"),
        ];
        const m = deriveMetrics(events);
        expect(m.errors.total).toBe(4);
        expect(m.errors.byType).toEqual({ "tool.failed": 1, "retry.scheduled": 1, "guard.no_progress": 1, "request.failed": 1 });
        expect(m.errors.eventIds).toHaveLength(4);
        expect(events.filter(isErrorEvent)).toHaveLength(4);
    });

    it("tracks active agents and tool calls through transitions", () => {
        const m = deriveMetrics([
            at(1, "agent.spawned", { agent_id: "a1" }),
            at(2, "agent.spawned", { agent_id: "a2" }),
            at(3, "route.selected", { agent_id: "a1" }),
            at(4, "tool.called", { attributes: { tool_call_id: "t1" } }),
            at(5, "tool.called", { attributes: { tool_call_id: "t2" } }),
            at(6, "tool.failed", { attributes: { tool_call_id: "t1" } }),
            at(7, "agent.completed", { agent_id: "a1" }),
            at(8, "agent.cancelled", { agent_id: "a2" }),
            at(9, "agent.started", { agent_id: "a3" }),
        ]);
        expect(m.agents.active).toEqual(["a3"]);
        expect(m.agents.spawned).toBe(2);
        expect(m.agents.completed).toBe(1);
        expect(m.agents.transitions).toBe(6);
        expect(m.tools).toEqual({ active: ["t2"], called: 2, completed: 0, failed: 1 });
    });

    it("reports latest and peak memory pressure from device samples", () => {
        const sample = (ms: number, used: number) =>
            at(ms, "device.memory.sample", { device_id: "gpu0", attributes: { used_bytes: used, total_bytes: 100 } });
        const m = deriveMetrics([
            sample(1, 40),
            sample(2, 95),
            at(3, "kv.pressure"),
            sample(4, 60),
            at(5, "device.compute.sample", { attributes: { utilization: 0.7 } }),
            at(6, "device.memory.sample", { attributes: { used_bytes: 5 } }), // no total: ignored
            at(7, "telemetry.dropped", { attributes: { dropped_count: 4 } }),
            at(8, "telemetry.dropped"),
        ]);
        expect(m.resources.latest!.fraction).toBe(0.6);
        expect(m.resources.peak!.fraction).toBe(0.95);
        expect(m.resources.pressureEvents).toBe(1);
        expect(m.resources.latestComputeUtilization).toBe(0.7);
        expect(m.droppedEvents).toBe(5);
    });
});

describe("classifyEvent", () => {
    it("maps taxonomy prefixes to tracks and keeps unknown types visible", () => {
        expect(classifyEvent(at(1, "inference.decode.started"))).toBe("inference");
        expect(classifyEvent(at(1, "kv.evicted"))).toBe("resource");
        expect(classifyEvent(at(1, "memory.retrieval.started"))).toBe("agent");
        expect(classifyEvent(at(1, "tool.failed"))).toBe("error");
        expect(classifyEvent(at(1, "vendor.custom.thing"))).toBe("other");
    });
});
