import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateEvents } from "../../scripts/gen-large-fixture.mjs";
import type { ObservatoryEvent } from "../../src/protocol/events";
import { deriveMetrics } from "../../src/query/metrics";
import { getMetricsIndex, METRICS_CHECKPOINT, MetricsIndex, metricsAt } from "../../src/query/metricsIndex";
import { parseNdjson } from "../../src/recording/ndjson";
import { ReplayCursor } from "../../src/replay/controller";
import { orderEvents } from "../../src/replay/order";
import { SessionStore } from "../../src/replay/session";
import { at } from "../helpers";

const root = fileURLToPath(new URL("../..", import.meta.url));
const m1Events = orderEvents(parseNdjson(readFileSync(join(root, "fixtures/synthetic-session.ndjson"), "utf8")).events).events;
const large = orderEvents([...generateEvents(40_000, 5)] as ObservatoryEvent[]).events;

const producerB = { name: "producer-b", version: "1", node_id: "n2" };

/** Hand-made corner cases of deriveMetrics, in the order given (not re-sorted). */
function cornerCases(): ObservatoryEvent[] {
    return [
        at(1, "session.started", { attributes: { text_capture: "off" } }),
        // Outcome and tokens before any start: no span; the tokens are loose.
        at(2, "request.completed", { request_id: "r1" }),
        at(3, "inference.token.generated", { request_id: "r1", attributes: { count: 2 } }),
        at(4, "request.started", { request_id: "r1", agent_id: "a1" }),
        // A session model named after the request started still applies from its position on.
        at(40, "session.created", { attributes: { model: "m-session" } }),
        at(5, "agent.spawned", { agent_id: "a1" }),
        at(6, "inference.token.generated", { request_id: "r1", attributes: { unit: "chunk" } }),
        at(7, "inference.token.generated", { request_id: "r1", attributes: { unit: "token", count: 3 } }),
        // Backend reports: the first `model` attribute wins over the session model; the latest report wins.
        at(41, "backend.timing.prefill", { request_id: "r1", attributes: { model: "m-attr", prompt_eval_count: 35, prompt_eval_cached_count: 34 } }),
        at(8, "tool.called", { attributes: { tool_call_id: "t1" } }),
        // The same request_id from another producer is another span.
        at(9, "request.started", { request_id: "r1", producer: producerB }),
        at(10, "inference.token.generated", { request_id: "r1", producer: producerB }),
        at(45, "request.completed", { request_id: "r1", producer: producerB, attributes: { draft_n: 2, draft_n_accepted: 2 } }),
        at(11, "inference.decode.completed", { request_id: "r1", attributes: { backend_eval_ms: 40 } }),
        at(12, "request.completed", { request_id: "r1", attributes: { completion_tokens: 9, token_counts_from_backend: true, total_ms: 50, ttft_ms: 5 } }),
        // A second outcome is ignored; a later eval report still applies.
        at(13, "request.failed", { request_id: "r1" }),
        at(14, "inference.decode.completed", { request_id: "r1", attributes: { backend_eval_ms: 45 } }),
        // Reports after the outcome still belong to the span.
        at(43, "inference.decode.completed", { request_id: "r1", attributes: { backend_draft_tokens: 4, backend_draft_accepted_tokens: 3 } }),
        at(42, "backend.timing.prefill", { request_id: "r1", attributes: { prompt_eval_count: 40, prompt_eval_cached_count: 0 } }),
        // A report for a request that never started is ignored.
        at(46, "backend.timing.prefill", { request_id: "nospan", attributes: { prompt_eval_count: 5, prompt_eval_cached_count: 1 } }),
        at(15, "tool.failed", { attributes: { tool_call_id: "t1" } }),
        at(16, "telemetry.dropped", { attributes: { dropped_events: 3 } }),
        at(17, "device.memory.sample", { device_id: "gpu0", attributes: { used_bytes: 5, total_bytes: 10 } }),
        at(18, "device.compute.sample", { attributes: { utilization: 0.5 } }),
        // A restart of the same span key replaces the span but keeps its position.
        at(19, "request.started", { request_id: "r1", agent_id: "a1" }),
        // The restarted span starts without the old span's reports.
        at(44, "inference.prefill.completed", { request_id: "r1", attributes: { prompt_tokens: 10, backend_cached_tokens: 10 } }),
        at(47, "backend.timing.decode", { request_id: "r1", attributes: { model: "m-later" } }),
        at(20, "request.started", { request_id: "r2" }),
        at(21, "inference.token.generated", { request_id: "r1" }),
        at(22, "inference.token.generated", { request_id: "r1", attributes: { count: 4 } }),
        at(23, "request.failed", { request_id: "r2" }),
        at(24, "kv.pressure", {}),
        at(25, "telemetry.dropped", { attributes: { dropped_events: 7 } }),
        at(26, "device.memory.sample", { device_id: "gpu0", attributes: { used_bytes: 9, total_bytes: 10 } }),
        at(27, "agent.completed", { agent_id: "a1" }),
        at(28, "inference.token.generated", {}),
        at(29, "inference.token.generated", { attributes: { count: 5 } }),
        at(30, "request.cancelled", { request_id: "r1" }),
        at(31, "route.selected", { agent_id: "a1" }),
        // Out of time order (a clock step): the prefix-sum search falls back to a scan.
        at(12_000, "inference.token.generated", {}),
        at(6_000, "inference.token.generated", { attributes: { count: 2 } }),
        at(6_500, "inference.token.generated", { attributes: { count: 3 } }),
        at(12_001, "request.started", { request_id: "r3" }),
        at(12_002, "inference.token.generated", { request_id: "r3", attributes: { count: 2 } }),
        at(12_003, "inference.token.generated", { request_id: "r3", attributes: { count: 2 } }),
        // request.started reports for the span it opens; token events never carry reports.
        at(12_004, "request.started", { request_id: "r4", model_instance_id: "mi-4", attributes: { model: "m-start", prompt_tokens: 2, backend_cached_tokens: 1 } }),
        at(12_005, "inference.token.generated", { request_id: "r4", attributes: { prompt_tokens: 9, backend_cached_tokens: 9, draft_n: 3, draft_n_accepted: 1 } }),
        at(12_006, "request.started", { request_id: "r5", model_instance_id: "mi-5", session_id: "ses_other" }),
        at(12_007, "request.completed", { request_id: "r5", session_id: "ses_other", attributes: { prompt_tokens: 8, backend_cached_tokens: 2, backend_draft_tokens: 5, backend_draft_accepted_tokens: 5 } }),
    ];
}

describe("metricsAt equals deriveMetrics over the prefix", () => {
    it("for every prefix of the corner cases, queried in any order", () => {
        const events = cornerCases();
        const index = new MetricsIndex(events);
        const counts = [...Array(events.length + 1).keys()];
        for (const c of [...counts.reverse(), ...counts.reverse()]) {
            expect(index.at(c)).toEqual(deriveMetrics(events.slice(0, c)));
        }
    });

    it("for every prefix of the M1 synthetic fixture", () => {
        for (let c = 0; c <= m1Events.length; c += 1) {
            expect(metricsAt(m1Events, c)).toEqual(deriveMetrics(m1Events.slice(0, c)));
        }
    });

    it("on a large session, around checkpoints and scrubbing backwards", () => {
        const counts = [0, 1, 2, METRICS_CHECKPOINT - 1, METRICS_CHECKPOINT, METRICS_CHECKPOINT + 1, 3 * METRICS_CHECKPOINT + 7];
        for (let k = 1; k <= 12; k += 1) {
            counts.push(Math.floor((large.length * k) / 12));
        }
        const index = getMetricsIndex(large);
        for (const c of [...counts].reverse()) {
            expect(index.at(c)).toEqual(deriveMetrics(large.slice(0, c)));
        }
        // Past the end clamps, as slice does.
        expect(metricsAt(large, large.length + 10)).toEqual(deriveMetrics(large));
    });

    it("through the replay cursor", () => {
        const cursor = new ReplayCursor(large);
        for (const f of [0, 0.25, 0.5, 0.999, 1]) {
            cursor.seek(cursor.durationNs * f);
            expect(cursor.metrics()).toEqual(deriveMetrics(cursor.visibleEvents()));
        }
    });

    it("across in-order live appends (index extended) and out-of-order ones (rebuilt)", () => {
        const store = new SessionStore();
        store.reset("live", "test");
        const arrays: (readonly ObservatoryEvent[])[] = [];
        for (let i = 0; i < 12_000; i += 1_500) {
            store.append(large.slice(i, i + 1_500));
            metricsAt(store.events);
            arrays.push(store.events);
        }
        expect(getMetricsIndex(arrays[0]!)).toBe(getMetricsIndex(arrays.at(-1)!));
        store.append(large.slice(13_000, 14_000));
        store.append(large.slice(12_000, 13_000));
        arrays.push(store.events);
        for (const events of arrays) {
            expect(metricsAt(events)).toEqual(deriveMetrics(events));
            const mid = Math.floor(events.length / 2);
            expect(metricsAt(events, mid)).toEqual(deriveMetrics(events.slice(0, mid)));
        }
    });

    it("does not cache arrays that may be mutated", () => {
        const events = cornerCases();
        expect(metricsAt(events)).toEqual(deriveMetrics(events));
        events.push(at(50_000, "request.started", { request_id: "late" }));
        expect(metricsAt(events)).toEqual(deriveMetrics(events));
    });
});

/** The large session with backend prompt-cache and speculation reports on some requests (additive attributes). */
function withReports(events: readonly ObservatoryEvent[]): ObservatoryEvent[] {
    let n = 0;
    return events.map((e) => {
        if (e.event_type === "session.created" || e.event_type === "session.started") {
            return { ...e, attributes: { ...e.attributes, model: "large-model" } };
        }
        if (e.event_type !== "request.completed" && e.event_type !== "inference.decode.completed") {
            return e;
        }
        n += 1;
        const prompt = 50 + (n % 37);
        return n % 3 === 0
            ? e
            : { ...e, attributes: { ...e.attributes, prompt_tokens: prompt, backend_cached_tokens: n % 4 === 0 ? 0 : prompt - (n % 11), backend_draft_tokens: n % 5, backend_draft_accepted_tokens: n % 5 === 0 ? 0 : (n % 5) - 1 } };
    });
}

describe("metricsAt equals deriveMetrics with prompt-cache and speculation reports", () => {
    it("on the corner cases, reports are present", () => {
        const m = deriveMetrics(cornerCases());
        expect(m.promptCache.requests).toBeGreaterThan(0);
        expect(m.speculation.requests).toBeGreaterThan(0);
        expect(m.requests.map((r) => r.model)).toEqual(expect.arrayContaining(["m-later", "m-start", "mi-5"]));
    });

    it("on a large session with reports, around checkpoints", () => {
        const events = withReports(large);
        const counts = [0, 1, METRICS_CHECKPOINT - 1, METRICS_CHECKPOINT, METRICS_CHECKPOINT + 1, events.length];
        for (let k = 1; k <= 8; k += 1) {
            counts.push(Math.floor((events.length * k) / 9));
        }
        const index = new MetricsIndex(events);
        for (const c of counts.reverse()) {
            expect(index.at(c)).toEqual(deriveMetrics(events.slice(0, c)));
        }
        const full = index.at(events.length);
        expect(full.promptCache.requests).toBeGreaterThan(100);
        expect(full.speculation.requests).toBeGreaterThan(100);
    });
});

describe("metricsAt cost", () => {
    it("replays fewer than one checkpoint interval of events per scrub", () => {
        const index = getMetricsIndex(large);
        index.at(large.length);
        let worst = 0;
        for (let k = 1; k < 50; k += 1) {
            index.at(Math.floor((large.length * k) / 50) + k);
            worst = Math.max(worst, index.lastReplayed);
        }
        expect(worst).toBeGreaterThan(0);
        expect(worst).toBeLessThan(METRICS_CHECKPOINT);
    });

    it("keeps a scrubbed cursor prefix and the whole session memoized side by side", () => {
        // The Overview asks for the cursor prefix, the inspector's request lookup for the whole session.
        const index = new MetricsIndex(large);
        const mid = Math.floor(large.length / 2) + 7;
        const prefix = index.at(mid);
        const whole = index.at(large.length);
        for (let k = 0; k < 5; k += 1) {
            expect(index.at(mid)).toBe(prefix);
            expect(index.at(large.length)).toBe(whole);
        }
        // A third count evicts the least recently used one only.
        const third = index.at(mid - 3);
        expect(index.at(large.length)).toBe(whole);
        expect(index.at(mid)).not.toBe(prefix);
        expect(index.at(mid)).toEqual(deriveMetrics(large.slice(0, mid)));
        expect(third).toEqual(deriveMetrics(large.slice(0, mid - 3)));
    });
});
