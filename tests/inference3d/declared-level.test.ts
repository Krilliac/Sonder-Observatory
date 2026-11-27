import { describe, expect, it } from "vitest";
import { derivePipeline } from "../../src/inference3d/derive";
import type { PanelId, PipelineModel } from "../../src/inference3d/model";
import { SCHEMA_ID, type ObservatoryEvent } from "../../src/protocol/events";

const INSTANCE = "inf-1";
const ev = (seq: number, type: string, attributes: Record<string, unknown> = {}, request: string | null = null): ObservatoryEvent => ({
    schema: SCHEMA_ID,
    event_id: `e-${seq}`,
    sequence: seq,
    event_type: type,
    wall_time: new Date(Date.UTC(2026, 10, 1) + seq).toISOString(),
    mono_ns: 1_000_000 + seq * 1000,
    session_id: "s",
    run_id: null,
    request_id: request,
    agent_id: null,
    task_id: null,
    model_instance_id: null,
    device_id: null,
    producer: { name: "sonder-inference", version: "0.1.0", node_id: "node1", instance_id: INSTANCE, role: "inference" },
    sampling: { level: "metrics", sampled: true },
    attributes,
});

const caps = (m: PipelineModel) => m.capabilities.find((c) => c.producer === "sonder-inference")!;
const panel = (m: PipelineModel, id: PanelId) => caps(m).panels.find((p) => p.panel === id)!;

describe("declared telemetry level", () => {
    const idle = [ev(0, "session.created", { model: "m", backend: "llama" }), ev(1, "backend.registered", { backend: "llama", capabilities: ["token_logits"] })];

    it("falls back to the highest level seen when nothing is declared", () => {
        expect(caps(derivePipeline(idle)).level).toBe("metrics");
    });

    it("prefers the declared level over the highest seen", () => {
        const m = derivePipeline(idle, { declaredLevels: new Map([[INSTANCE, "standard"]]) });
        expect(caps(m).level).toBe("standard");
    });

    it("ignores an unknown declared level", () => {
        const m = derivePipeline(idle, { declaredLevels: new Map([[INSTANCE, "bogus"]]) });
        expect(caps(m).level).toBe("metrics");
    });

    it("uses the declared level in the layer hint", () => {
        const withLayers = [ev(0, "session.created", { model: "m", backend: "llama" }), ev(1, "backend.registered", { backend: "llama", capabilities: ["layer_telemetry"] })];
        const m = derivePipeline(withLayers, { declaredLevels: new Map([[INSTANCE, "standard"]]) });
        expect(panel(m, "layers").reason).toContain("`standard`");
        const deep = derivePipeline(withLayers, { declaredLevels: new Map([[INSTANCE, "deep"]]) });
        expect(panel(deep, "layers").status).toBe("waiting");
    });

    it("does not tell a deep producer to restart at deep when the backend lacks layer_telemetry", () => {
        const m = derivePipeline(idle, { declaredLevels: new Map([[INSTANCE, "deep"]]) });
        const reason = panel(m, "layers").reason;
        expect(reason).toContain("does not expose layer telemetry");
        expect(reason).not.toContain("--telemetry-level deep");
    });
});

describe("probability events without token_logits", () => {
    const events = [
        ev(0, "session.created", { model: "m", backend: "plain" }),
        ev(1, "backend.registered", { backend: "plain", capabilities: [] }),
        ev(2, "inference.decode.started", {}, "r"),
        ev(3, "inference.token.generated", { index: 0, probability: 0.8 }, "r"),
    ];
    const m = derivePipeline(events);

    it("probabilities stay available because events carry them", () => {
        expect(panel(m, "probabilities").status).toBe("available");
    });

    it("alternatives do not claim the backend exposes no logits", () => {
        const p = panel(m, "alternatives");
        expect(p.status).toBe("unavailable");
        expect(p.reason).toContain("emits token probabilities");
        expect(p.reason).toContain("token_logits");
    });
});
