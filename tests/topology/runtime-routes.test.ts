import { describe, expect, it } from "vitest";
import { deriveTopology } from "../../src/topology/derive";
import { at } from "../helpers";

/**
 * Sonder-Runtime's route events (runtime_telemetry.py): no agent_id and no
 * model instance; route.selected carries `provider` (+ `model` name) and
 * route.changed carries `from_provider` / `to_provider`.
 */
describe("topology from Sonder-Runtime route events", () => {
    const selected = (ms: number, provider: string, model: string) =>
        at(ms, "route.selected", { request_id: "turn-1", attributes: { provider, model, operation: "chat", attempt: 1, status: "ok" } });

    it("maps route.selected to the provider it selected", () => {
        const g = deriveTopology([selected(1, "ollama", "qwen3:8b")]);
        expect(g.unmappedEventIds).toEqual([]);
        const n = g.nodes.find((x) => x.id === "model:ollama");
        expect(n?.label).toBe("ollama · qwen3:8b");
        expect(n?.status).toBe("active");
        // No agent is reported, so no agent edge is invented.
        expect(g.edges).toEqual([]);
    });

    it("maps route.changed to a provider-change edge", () => {
        const g = deriveTopology([
            selected(1, "ollama", "qwen3:8b"),
            at(2, "route.changed", { request_id: "turn-1", attributes: { from_provider: "ollama", to_provider: "openai", reason_code: "timeout", attempt: 2 } }),
            selected(3, "openai", "gpt-x"),
        ]);
        expect(g.unmappedEventIds).toEqual([]);
        const change = g.edges.find((e) => e.id === "route_change:model:ollama->model:openai");
        expect(change?.evidence).toEqual(["evt_route.changed_2"]);
    });

    it("keeps agent routes working when an agent_id is present", () => {
        const g = deriveTopology([at(1, "route.selected", { agent_id: "a", attributes: { provider: "ollama", model: "m" } })]);
        expect(g.edges.map((e) => e.id)).toEqual(["route:agent:a->model:ollama"]);
    });
});
