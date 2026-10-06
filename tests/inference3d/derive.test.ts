import { describe, expect, it } from "vitest";
import { derivePipeline, stageOfEvent } from "../../src/inference3d/derive";
import { deepSyntheticFixture, ollamaPoolFixture } from "../../src/inference3d/fixtures";
import type { PanelId, PipelineModel } from "../../src/inference3d/model";
import { validateEvent } from "../../src/protocol/validate";
import { SCHEMA_ID, type ObservatoryEvent } from "../../src/protocol/events";

const panel = (m: PipelineModel, producerNode: string, producer: string, id: PanelId) =>
    m.capabilities.find((c) => c.nodeId === producerNode && c.producer === producer)!.panels.find((p) => p.panel === id)!;

describe("3D inference fixtures", () => {
    it.each([
        ["ollama pool", ollamaPoolFixture()],
        ["deep synthetic", deepSyntheticFixture()],
    ])("%s events are valid envelopes in replay order", (_name, events) => {
        for (const e of events) {
            expect(validateEvent(e).ok, e.event_id).toBe(true);
        }
        for (let i = 1; i < events.length; i++) {
            expect(events[i]!.mono_ns).toBeGreaterThanOrEqual(events[i - 1]!.mono_ns);
        }
        expect(new Set(events.map((e) => e.event_id)).size).toBe(events.length);
    });
});

describe("derivePipeline: live-like Ollama pool (qwen3:14b + deepseek-r1:14b on workstation, qwen3:14b on node1)", () => {
    const events = ollamaPoolFixture();
    const m = derivePipeline(events);

    it("groups lanes by node, then model, with the model name from session.created / route.selected", () => {
        expect(m.nodes).toEqual(["node1", "workstation"]);
        expect(m.lanes.map((l) => `${l.nodeId}/${l.model}`)).toEqual(["node1/qwen3:14b", "workstation/deepseek-r1:14b", "workstation/qwen3:14b"]);
        const wsQwen = m.lanes.find((l) => l.nodeId === "workstation" && l.model === "qwen3:14b")!;
        // The Runtime turns and the Inference requests for qwen3:14b share one lane.
        expect(wsQwen.producers.sort()).toEqual(["sonder-inference", "sonder-runtime"]);
        expect(wsQwen.roles.sort()).toEqual(["inference", "runtime"]);
        expect(m.lanes.find((l) => l.nodeId === "node1")!.nodeIndex).toBe(0);
        expect(m.lanes.find((l) => l.model === "deepseek-r1:14b")!.nodeIndex).toBe(1);
    });

    it("places each request in the stage its latest events report", () => {
        const byId = new Map(m.requests.map((r) => [r.requestId, r]));
        expect(byId.get("req-ws-1")).toMatchObject({ stage: "output", state: "completed", completionTokens: 463, promptTokens: 212, outputEvents: 15 });
        expect(byId.get("req-ws-2")).toMatchObject({ stage: "decode", state: "active", completionTokens: null, outputEvents: 12, model: "deepseek-r1:14b" });
        expect(byId.get("req-ws-3")).toMatchObject({ stage: "queue", state: "active" });
        expect(byId.get("req-n1-1")).toMatchObject({ stage: "output", state: "completed", nodeId: "node1", completionTokens: 201 });
        expect(byId.get("req-n1-2")).toMatchObject({ stage: "output", state: "failed" });
        expect(byId.get("turn-1")).toMatchObject({ stage: "output", state: "completed", role: "runtime" });
        expect(byId.get("turn-2")).toMatchObject({ stage: "route", state: "active" });
        // Evidence ids are real event ids of that request.
        const ids = new Set(events.map((e) => e.event_id));
        for (const r of m.requests) {
            expect(r.evidence.length).toBeGreaterThan(0);
            expect(r.evidence.every((id) => ids.has(id))).toBe(true);
        }
    });

    it("links Runtime turns to Inference requests through parent_request_id", () => {
        const requests = new Map(m.requests.map((r) => [r.id, r.requestId]));
        const pairs = m.links.map((l) => `${requests.get(l.from)}->${requests.get(l.to)}`).sort();
        expect(pairs).toEqual(["turn-1->req-ws-1", "turn-2->req-ws-2", "turn-3->req-ws-3"]);
    });

    it("counts in-flight requests per stage and never counts chunks as tokens", () => {
        const s = Object.fromEntries(m.stages.map((x) => [x.id, x]));
        expect(Object.keys(s)).toEqual(["route", "queue", "prefill", "decode", "output"]);
        expect(s.route!.requests).toBe(2); // turn-2, turn-3
        expect(s.queue!.requests).toBe(1);
        expect(s.decode!.requests).toBe(1);
        expect(s.output!.requests).toBe(4);
        expect(m.hasLayers).toBe(false);
        expect(m.chunks.every((c) => c.unit === "chunk" && c.tokens === null && c.text === null)).toBe(true);
        expect(m.chunks.length).toBe(15 + 12 + 9);
    });

    it("tracks the logical KV pool per producer instance", () => {
        const ws = m.kvPools.find((p) => p.nodeId === "workstation")!;
        const n1 = m.kvPools.find((p) => p.nodeId === "node1")!;
        expect(ws.totalBlocks).toBe(4096);
        // req-ws-1 freed; req-ws-2 still holds ceil(380/16) = 24 blocks.
        expect(ws.usedBlocks).toBe(24);
        expect(n1.usedBlocks).toBe(0);
    });

    it("reports every internal panel as not available with the backend and its capabilities", () => {
        expect(panel(m, "workstation", "sonder-inference", "pipeline").status).toBe("available");
        const layers = panel(m, "workstation", "sonder-inference", "layers");
        expect(layers.status).toBe("unavailable");
        expect(layers.reason).toContain("backend `ollama` does not expose layer telemetry");
        const probs = panel(m, "node1", "sonder-inference", "probabilities");
        expect(probs.status).toBe("unavailable");
        expect(probs.reason).toContain("backend `ollama` does not expose token logits");
        expect(panel(m, "node1", "sonder-inference", "alternatives").status).toBe("unavailable");
        expect(panel(m, "workstation", "sonder-inference", "kv").status).toBe("available");
        expect(panel(m, "workstation", "sonder-inference", "output-text").reason).toContain("text capture is `off`");
        const runtime = m.capabilities.find((c) => c.producer === "sonder-runtime")!;
        expect(runtime.panels.find((p) => p.panel === "layers")!.status).toBe("not-applicable");
        const ws = m.capabilities.find((c) => c.producer === "sonder-inference" && c.nodeId === "workstation")!;
        expect(ws.backends).toEqual(["ollama"]);
        expect(ws.backendCapabilities.ollama).toEqual({ capabilities: ["remote_process", "streaming"], source: "backend.registered" });
        expect(ws.samplers).toEqual(["backend"]);
        expect(m.synthetic).toBe(false);
    });

    it("reflects the replay cursor: earlier state, not the end state", () => {
        const at = events.find((e) => e.event_type === "inference.decode.started" && e.request_id === "req-ws-1")!.mono_ns;
        const early = derivePipeline(events.filter((e) => e.mono_ns <= at));
        const r1 = early.requests.find((r) => r.requestId === "req-ws-1")!;
        expect(r1).toMatchObject({ stage: "decode", state: "active", completionTokens: null });
        expect(early.requests.some((r) => r.requestId === "req-ws-3")).toBe(false);
        // nowNs cuts off later events even when they are passed in.
        const cut = derivePipeline(events, { nowNs: at });
        expect(cut.requests.find((r) => r.requestId === "req-ws-1")!.stage).toBe("decode");
    });

    it("uses health capabilities when the stream has no backend.registered event", () => {
        const stripped = events.filter((e) => e.event_type !== "backend.registered");
        const unknown = derivePipeline(stripped);
        expect(panel(unknown, "workstation", "sonder-inference", "layers").reason).toContain("capabilities are not advertised");
        const withHealth = derivePipeline(stripped, {
            health: new Map([["tel-ws0000000001", [{ name: "ollama", available: true, capabilities: ["streaming", "remote_process"] }]]]),
        });
        const ws = withHealth.capabilities.find((c) => c.nodeId === "workstation" && c.producer === "sonder-inference")!;
        expect(ws.backendCapabilities.ollama!.source).toBe("health");
        expect(ws.panels.find((p) => p.panel === "layers")!.reason).toContain("does not expose layer telemetry");
    });
});

describe("derivePipeline: synthetic deep producer (reserved layer/operator events, proposed shapes)", () => {
    const events = deepSyntheticFixture(8, 6);
    const m = derivePipeline(events);

    it("shows layer planes and operators only because the events arrived", () => {
        expect(m.hasLayers).toBe(true);
        expect(m.stages.map((s) => s.id)).toEqual(["route", "queue", "prefill", "layers", "decode", "output"]);
        expect(m.layers.map((l) => l.layer)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(m.layers[0]!.layerCount).toBe(8);
        expect(m.layers[0]!.events).toBe(2 * (1 + 6));
        expect(m.layers[3]!.activationRms).not.toBeNull();
        expect(m.operators.map((o) => `${o.operator}@${o.layer}`)).toEqual(["attention@0", "mlp@0", "attention@4", "mlp@4"]);
        expect(m.synthetic).toBe(true);
    });

    it("keeps token probabilities, alternatives and captured text", () => {
        expect(m.tokens.length).toBe(12);
        const t = m.tokens.at(-1)!;
        expect(t.probability).toBeGreaterThan(0.5);
        expect(t.alternatives!.length).toBe(5);
        expect(t.alternatives![0]!.probability).toBe(t.probability);
        expect(t.alternatives![0]!.text).not.toBeNull();
        expect(m.chunks.every((c) => c.unit === "token" && c.tokens === 1 && c.text !== null)).toBe(true);
        const caps = m.capabilities[0]!;
        expect(caps.synthetic).toBe(true);
        expect(caps.level).toBe("deep");
        for (const id of ["pipeline", "layers", "operators", "probabilities", "alternatives", "kv", "output-text"] as const) {
            expect(caps.panels.find((p) => p.panel === id)!.status, id).toBe("available");
        }
    });

    it("withholds text when the capture policy does not allow it", () => {
        const off = events.map((e) =>
            e.event_type === "engine.started" || e.event_type === "session.created" ? { ...e, attributes: { ...e.attributes, text_capture: "off" } } : e,
        );
        const m2 = derivePipeline(off);
        expect(m2.chunks.every((c) => c.text === null && c.textWithheld)).toBe(true);
        expect(m2.tokens.every((t) => t.alternatives!.every((a) => a.text === null))).toBe(true);
        expect(m2.capabilities[0]!.panels.find((p) => p.panel === "output-text")!.status).toBe("unavailable");
    });

    it("layers without deep telemetry: advertised capability but level too low", () => {
        const noLayers = events
            .filter((e) => !e.event_type.startsWith("backend."))
            .map((e) => ({ ...e, sampling: { level: "standard" as const, sampled: true } }));
        const withRegistration = [events.find((e) => e.event_type === "backend.registered")!, ...noLayers].sort((a, b) => a.mono_ns - b.mono_ns);
        const m3 = derivePipeline(withRegistration.map((e) => ({ ...e, sampling: { level: "standard" as const, sampled: true } })));
        const layers = m3.capabilities[0]!.panels.find((p) => p.panel === "layers")!;
        expect(layers.status).toBe("unavailable");
        expect(layers.reason).toContain("--telemetry-level deep");
        expect(m3.hasLayers).toBe(false);
    });
});

describe("stageOfEvent", () => {
    const e = (type: string, attributes: Record<string, unknown> = {}) => ({ event_type: type, attributes }) as unknown as ObservatoryEvent;
    it("maps Inference and Runtime events to pipeline stages", () => {
        expect(stageOfEvent(e("request.queued"), false)).toEqual({ stage: "queue", move: true });
        expect(stageOfEvent(e("request.started", { scheduled: true }), false)!.stage).toBe("queue");
        expect(stageOfEvent(e("request.started"), false)!.stage).toBe("prefill");
        expect(stageOfEvent(e("inference.prefill.completed"), false)).toEqual({ stage: "prefill", move: false });
        expect(stageOfEvent(e("inference.token.generated"), false)!.stage).toBe("decode");
        expect(stageOfEvent(e("request.completed"), false)!.stage).toBe("output");
        expect(stageOfEvent(e("request.started"), true)!.stage).toBe("route");
        expect(stageOfEvent(e("route.selected"), true)!.stage).toBe("route");
        expect(stageOfEvent(e("device.memory.sample"), false)).toBeNull();
    });

    it("a preempted request goes back to the queue; end-of-request facts do not move it", () => {
        const pool = ollamaPoolFixture();
        const r1 = pool.filter((x) => x.request_id === "req-ws-1");
        const decodeAt = r1.findIndex((x) => x.event_type === "inference.decode.started");
        const preempt: ObservatoryEvent = {
            ...r1[decodeAt]!,
            event_id: "x-preempt",
            sequence: 9999,
            event_type: "scheduler.preempted",
            mono_ns: r1[decodeAt]!.mono_ns + 1,
            attributes: { reason: "kv_pressure" },
        };
        const m = derivePipeline([...pool.filter((x) => x.mono_ns <= preempt.mono_ns - 1), preempt]);
        expect(m.requests.find((r) => r.requestId === "req-ws-1")!.stage).toBe("queue");
    });
});

describe("text capture policy is scoped to the producer stream", () => {
    // Two producer instances on one node that share a session_id: each stream's
    // declared policy governs only that stream's output text.
    const producer = (instance: string) => ({ name: "sonder-inference", version: "0.1.0", node_id: "node1", instance_id: instance, role: "inference" });
    const ev = (instance: string, seq: number, type: string, attributes: Record<string, unknown>, request: string | null = null): ObservatoryEvent => ({
        schema: SCHEMA_ID,
        event_id: `${instance}-${seq}`,
        sequence: seq,
        event_type: type,
        wall_time: new Date(Date.UTC(2026, 8, 27) + seq).toISOString(),
        mono_ns: 1_000_000 + seq * 1000 + (instance === "inf-b" ? 500 : 0),
        session_id: "shared-session",
        run_id: null,
        request_id: request,
        agent_id: null,
        task_id: null,
        model_instance_id: null,
        device_id: null,
        producer: producer(instance),
        sampling: { level: "metrics", sampled: true },
        attributes,
    });
    const streamEvents = (instance: string, policy: string | null) => [
        ev(instance, 0, "session.created", policy === null ? { model: "m" } : { model: "m", text_capture: policy }),
        ev(instance, 1, "inference.decode.started", {}, `req-${instance}`),
        ev(instance, 2, "inference.token.generated", { index: 0, text: `secret-${instance}`, probability: 0.9 }, `req-${instance}`),
        ev(instance, 3, "inference.sampling.candidates", { index: 0, candidates: [{ token_id: 1, probability: 0.9, text: `alt-${instance}` }] }, `req-${instance}`),
    ];
    const outputOf = (m: PipelineModel, instance: string) => {
        const req = m.requests.find((r) => r.requestId === `req-${instance}`)!;
        return {
            chunk: m.chunks.find((c) => c.requestEntityId === req.id)!,
            token: m.tokens.find((t) => t.requestEntityId === req.id)!,
        };
    };

    it("one stream's `full` policy does not expose another stream's text", () => {
        const events = [...streamEvents("inf-a", "full"), ...streamEvents("inf-b", null)].sort((x, y) => x.mono_ns - y.mono_ns);
        const m = derivePipeline(events);
        expect(outputOf(m, "inf-a").chunk.text).toBe("secret-inf-a");
        const b = outputOf(m, "inf-b");
        expect(b.chunk.text).toBeNull();
        expect(b.chunk.textWithheld).toBe(true);
        expect(b.token.text).toBeNull();
        expect(b.token.alternatives!.map((a) => a.text)).toEqual([null]);
    });

    it("one stream's restrictive policy does not hide text another stream enabled", () => {
        // inf-b declares `off` after inf-a declared `on` for the same session_id.
        const events = [...streamEvents("inf-a", "on"), ...streamEvents("inf-b", "off")].sort((x, y) => x.mono_ns - y.mono_ns);
        const m = derivePipeline(events);
        const a = outputOf(m, "inf-a");
        expect(a.chunk.text).toBe("secret-inf-a");
        expect(a.token.text).toBe("secret-inf-a");
        expect(a.token.alternatives!.map((x) => x.text)).toEqual(["alt-inf-a"]);
        expect(outputOf(m, "inf-b").chunk.text).toBeNull();
    });
});
