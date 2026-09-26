/**
 * Sonder-Inference (main b2170c0) event shapes through Observatory ingest.
 * The fixture is hand-built from Inference's emitter code (telemetry.cpp,
 * engine.cpp, session.cpp); it is not a recorded run. See
 * docs/telemetry-schema.md.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ObservatoryEvent } from "../src/protocol/events";
import { runDiagnostics } from "../src/diagnostics";
import {
    backendTokenCount,
    droppedCount,
    isRequestScopedLoadReport,
    memoryUsage,
    producerInstance,
} from "../src/query/attributes";
import { classifyEvent } from "../src/query/classify";
import { deriveMetrics } from "../src/query/metrics";
import { parseNdjson } from "../src/recording/ndjson";
import { orderEvents } from "../src/replay/order";
import { SessionStore } from "../src/replay/session";
import { deriveTopology } from "../src/topology";
import { at } from "./helpers";

const FIXTURE = new URL("./fixtures/sonder-inference-b2170c0.jsonl", import.meta.url);
const text = readFileSync(FIXTURE, "utf8");

function load(): ObservatoryEvent[] {
    const parsed = parseNdjson(text);
    expect(parsed.rejected).toEqual([]);
    return orderEvents(parsed.events).events;
}

describe("Sonder-Inference fixture", () => {
    it("validates every envelope against the v1 schema mirror", () => {
        const parsed = parseNdjson(text);
        expect(parsed.rejected).toEqual([]);
        expect(parsed.events).toHaveLength(26);
        expect(new Set(parsed.events.map((e) => e.producer.name))).toEqual(new Set(["sonder-inference"]));
    });

    it("spans engine, session and telemetry-instance session ids", () => {
        const ids = new Set(load().map((e) => e.session_id));
        expect([...ids].map((id) => id.split("-")[0]).sort()).toEqual(["engine", "sess", "tel"]);
    });

    it("reports no sequence gaps although one counter spans several session ids", () => {
        const ordered = orderEvents(parseNdjson(text).events);
        expect(ordered.gaps).toEqual([]);
        expect(ordered.duplicates).toBe(0);
    });

    it("still reports a real gap on the producer-instance stream", () => {
        const events = parseNdjson(text).events.filter((e) => e.sequence !== 9);
        const { gaps } = orderEvents(events);
        expect(gaps).toHaveLength(1);
        expect(gaps[0]).toMatchObject({ from: 9, to: 9 });
        expect(gaps[0]!.stream).toContain("#tel-3f9c2a7b1d4e5f60");
    });

    it("derives request latency, TTFT, outcomes and errors", () => {
        const m = deriveMetrics(load());
        expect(m.requests.map((r) => r.outcome)).toEqual(["completed", "cancelled", "failed"]);
        expect(m.requestLatency.count).toBe(3);
        expect(m.requestLatency.maxMs).toBe(241);
        expect(m.timeToFirstToken.count).toBe(2);
        expect(m.timeToFirstToken.maxMs).toBe(180);
        expect(m.errors.byType).toEqual({ "request.failed": 1 });
    });

    it("keeps streamed chunks and backend-reported token counts apart", () => {
        const m = deriveMetrics(load());
        expect(m.tokens.total).toBe(4);
        expect(m.tokens.backendReported).toBe(5);
        expect(m.requests.map((r) => [r.tokens, r.backendTokens])).toEqual([
            [3, 5],
            [1, null],
            [0, null],
        ]);
    });

    it("reads memory from total_bytes - available_bytes and drops from dropped_events", () => {
        const m = deriveMetrics(load());
        expect(m.resources.latest).toMatchObject({ deviceId: "cpu:0", fraction: 0.75, usedBytes: 25769803776 });
        expect(m.droppedEvents).toBe(2);
    });

    it("classifies engine lifecycle as session events", () => {
        const byType = new Map(load().map((e) => [e.event_type, classifyEvent(e)]));
        expect(byType.get("engine.started")).toBe("session");
        expect(byType.get("engine.stopped")).toBe("session");
        expect(byType.get("backend.registered")).toBe("inference");
        expect(byType.get("telemetry.dropped")).toBe("telemetry");
        expect(byType.get("request.failed")).toBe("error");
    });

    it("produces no diagnostics findings for a healthy short run", () => {
        expect(runDiagnostics(load())).toEqual([]);
    });

    it("maps the model instance into the topology", () => {
        const graph = deriveTopology(load());
        const models = [...graph.nodes.values()].filter((n) => n.kind === "model");
        expect(models.map((n) => [n.id, n.label])).toEqual([["model:model-0f1e2d3c4b5a6978", "llama3.2:3b"]]);
    });

    it("reads text_capture from session.created when present", () => {
        const store = new SessionStore();
        store.reset("file", "inference");
        store.append([at(0, "session.created", { attributes: { text_capture: "off" } })]);
        expect(store.capturePolicy).toBe("off");
    });
});

/**
 * Sonder-Inference 912503a: a recorded 46-event run of the CLI with the MOCK
 * backend (`sonder-infer` generate, mock:tiny, 8 tokens). Synthetic: the mock
 * backend performs no inference, so the numbers are not a quality or
 * performance signal. 912503a predates producer.role / producer.synthetic
 * (contract section 7.1); tests/README.md labels the file.
 */
describe("Sonder-Inference 912503a mock run (recorded)", () => {
    const text912 = readFileSync(new URL("./fixtures/sonder-inference-912503a.jsonl", import.meta.url), "utf8");
    const load912 = (): ObservatoryEvent[] => {
        const parsed = parseNdjson(text912);
        expect(parsed.rejected).toEqual([]);
        return orderEvents(parsed.events).events;
    };

    it("validates all 46 envelopes from one producer instance without gaps", () => {
        const parsed = parseNdjson(text912);
        expect(parsed.rejected).toEqual([]);
        expect(parsed.events).toHaveLength(46);
        const ordered = orderEvents(parsed.events);
        expect(ordered.gaps).toEqual([]);
        expect(ordered.duplicates).toBe(0);
        expect(new Set(parsed.events.map(producerInstance))).toEqual(new Set(["tel-cd5730d4b371a49d"]));
        expect(ordered.events.map((e) => e.sequence)).toEqual([...Array(46).keys()]);
    });

    it("is a mock-backend run", () => {
        const events = load912();
        const load = events.find((e) => e.event_type === "model.load.completed")!;
        expect(load.attributes).toMatchObject({ backend: "mock", model: "mock:tiny" });
        expect(events.find((e) => e.event_type === "session.created")!.attributes.text_capture).toBe("off");
        // 912503a has no producer.role / producer.synthetic yet (added by the serve work, contract 7.1).
        expect(events.every((e) => !("role" in e.producer) && !("synthetic" in e.producer))).toBe(true);
    });

    it("derives one completed request with streamed and backend-reported tokens", () => {
        const m = deriveMetrics(load912());
        expect(m.requests).toHaveLength(1);
        expect(m.requests[0]).toMatchObject({ outcome: "completed", producer: "sonder-inference", tokens: 8, backendTokens: 8 });
        expect(m.tokens.total).toBe(8);
        expect(m.tokens.backendReported).toBe(8);
        expect(m.requestLatencyByProducer["sonder-inference"]!.count).toBe(1);
        expect(m.timeToFirstToken.count).toBe(1);
        expect(m.droppedEvents).toBe(0);
        expect(m.errors.total).toBe(0);
    });

    it("classifies the scheduler and engine events and raises no diagnostics", () => {
        const events = load912();
        const byType = new Map(events.map((e) => [e.event_type, classifyEvent(e)]));
        expect(byType.get("engine.started")).toBe("session");
        expect(byType.get("request.completed")).toBe("request");
        expect(runDiagnostics(events)).toEqual([]);
    });

    it("replays through a SessionStore and records the producer", () => {
        const store = new SessionStore();
        store.reset("file", "sonder-inference-912503a.jsonl");
        store.append(parseNdjson(text912).events);
        expect(store.events).toHaveLength(46);
        expect(store.gaps).toEqual([]);
        expect(store.capturePolicy).toBe("off");
    });
});

describe("Ollama timing helper shapes (ollama_telemetry.cpp)", () => {
    const ctx = { session_id: "sess-1", request_id: "req-1", model_instance_id: "model-1" };
    const load = (ms: number) =>
        at(ms, "model.load.completed", {
            ...ctx,
            attributes: { backend: "ollama", model: "llama3.2:3b", load_duration_ns: 12_000_000 },
        });

    it("treats request-scoped load reports as timing, not model churn", () => {
        const events = [0, 1000, 2000, 3000, 4000, 5000].map(load);
        expect(events.every(isRequestScopedLoadReport)).toBe(true);
        expect(runDiagnostics(events, { kinds: ["model-churn"] })).toEqual([]);
    });

    it("still counts engine-scoped loads and unloads as churn", () => {
        const events = [0, 1000, 2000, 3000].map((ms, i) =>
            at(ms, i % 2 === 0 ? "model.load.completed" : "model.unload", { model_instance_id: "model-1" }),
        );
        expect(events.some(isRequestScopedLoadReport)).toBe(false);
        expect(runDiagnostics(events, { kinds: ["model-churn"] })).toHaveLength(1);
    });
});

describe("attribute readers", () => {
    it("memoryUsage prefers used_bytes, then available_bytes, then used_fraction", () => {
        const mem = (attributes: Record<string, unknown>) => memoryUsage(at(0, "device.memory.sample", { attributes }));
        expect(mem({ used_bytes: 3, total_bytes: 4, available_bytes: 3 })).toMatchObject({ fraction: 0.75, source: "used_bytes" });
        expect(mem({ total_bytes: 4, available_bytes: 1 })).toMatchObject({ usedBytes: 3, fraction: 0.75, source: "available_bytes" });
        expect(mem({ total_bytes: 4, available_bytes: 5 })).toBeNull();
        expect(mem({ used_fraction: 0.5 })).toMatchObject({ usedBytes: null, fraction: 0.5, source: "used_fraction" });
        expect(mem({ total_bytes: 0, available_bytes: 0 })).toBeNull();
    });

    it("droppedCount accepts dropped_count and dropped_events", () => {
        expect(droppedCount(at(0, "telemetry.dropped", { attributes: { dropped_count: 3 } }))).toBe(3);
        expect(droppedCount(at(0, "telemetry.dropped", { attributes: { dropped_events: 4 } }))).toBe(4);
        expect(droppedCount(at(0, "telemetry.dropped", { attributes: {} }))).toBeNull();
    });

    it("backendTokenCount requires token_counts_from_backend", () => {
        expect(backendTokenCount(at(0, "request.completed", { attributes: { completion_tokens: 7, token_counts_from_backend: true } }))).toBe(7);
        expect(backendTokenCount(at(0, "request.completed", { attributes: { completion_tokens: 7, token_counts_from_backend: false } }))).toBeNull();
        expect(backendTokenCount(at(0, "request.completed", { attributes: { completion_tokens: 1.5, token_counts_from_backend: true } }))).toBeNull();
    });

    it("producerInstance uses producer.instance_id or an <instance>-<sequence> event id", () => {
        const base = { sequence: 12 };
        expect(producerInstance(at(0, "x", { ...base, event_id: "tel-abc-12" }))).toBe("tel-abc");
        expect(producerInstance(at(0, "x", { ...base, event_id: "tel-abc-13" }))).toBeNull();
        expect(producerInstance(at(0, "x", { ...base, event_id: "tel-abc-012" }))).toBeNull();
        expect(producerInstance(at(0, "x", { ...base, event_id: "evt_syn_000013" }))).toBeNull();
        expect(
            producerInstance(
                at(0, "x", { ...base, event_id: "e1", producer: { name: "p", version: "1", node_id: "n", instance_id: "i-1" } }),
            ),
        ).toBe("i-1");
    });
});
