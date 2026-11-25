import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deriveExecutionRoutes } from "../../src/query/executionRoute";
import { deriveNodeGpuMemory } from "../../src/query/gpuMemory";
import { derivePrefillDecode } from "../../src/query/prefillDecode";
import { parseNdjson } from "../../src/recording/ndjson";
import { orderEvents } from "../../src/replay/order";
import { nodeGpuCardModels } from "../../src/renderer/gpuCards";
import {
    prefillDecodeSplitModel,
    renderPrefillDecodeSplit,
    renderTtftBreakdown,
    ttftBreakdownModel,
} from "../../src/renderer/prefillDecodeCard";
import { routeCardModel } from "../../src/renderer/routeBadges";
import { at } from "../helpers";

class FakeNode {
    readonly attrs: Record<string, string> = {};
    textContent = "";
    readonly children: (FakeNode | string)[] = [];
    constructor(readonly tag: string) {}
    set className(v: string) {
        this.attrs.class = v;
    }
    setAttribute(k: string, v: string): void {
        this.attrs[k] = v;
    }
    append(...kids: (FakeNode | string)[]): void {
        this.children.push(...kids);
    }
}

function withFakeDocument<T>(fn: () => T): T {
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: { createElement: (tag: string) => new FakeNode(tag) },
    });
    try {
        return fn();
    } finally {
        if (original) Object.defineProperty(globalThis, "document", original);
        else Reflect.deleteProperty(globalThis, "document");
    }
}

describe("prefill/decode split and TTFT breakdown card models", () => {
    it("returns empty/null renderables when no timing evidence exists", () => {
        const empty = derivePrefillDecode([]);
        expect(prefillDecodeSplitModel(empty).hasData).toBe(false);
        expect(ttftBreakdownModel(empty).hasData).toBe(false);
        withFakeDocument(() => {
            expect(renderPrefillDecodeSplit(empty)).toBeNull();
            expect(renderTtftBreakdown(empty)).toBeNull();
        });
    });

    it("separates Prefill tok/s, Decode tok/s, Steady Prefill TTFT, and Model Reload TTFT cleanly", () => {
        const prod = { name: "sonder-inference", version: "0.4.0", node_id: "NODE1", instance_id: "tel-node1" };
        const pd = derivePrefillDecode([
            at(0, "request.started", { producer: prod, request_id: "r1" }),
            at(10_050, "inference.token.generated", { producer: prod, request_id: "r1", attributes: { unit: "chunk" } }),
            at(20_050, "inference.prefill.completed", { producer: prod, request_id: "r1", attributes: { prompt_tokens: 2426, backend_prompt_eval_ms: 10_000, ttft_ms: 10_050 } }),
            at(20_050, "inference.decode.completed", { producer: prod, request_id: "r1", attributes: { completion_tokens: 400, backend_eval_ms: 10_000 } }),
            at(20_050, "request.completed", { producer: prod, request_id: "r1", attributes: { completion_tokens: 400, token_counts_from_backend: true, ttft_ms: 10_050, total_ms: 20_050 } }),

            at(25_000, "request.started", { producer: prod, request_id: "r2" }),
            at(29_400, "inference.token.generated", { producer: prod, request_id: "r2", attributes: { unit: "chunk" } }),
            at(30_000, "backend.model.load.reported", { producer: prod, request_id: "r2", attributes: { backend: "llamaserver", model: "qwen3-80b", load_duration_ns: 4_100_000_000 } }),
            at(30_000, "inference.prefill.completed", { producer: prod, request_id: "r2", attributes: { prompt_tokens: 200, backend_prompt_eval_ms: 200, ttft_ms: 4400 } }),
            at(30_000, "inference.decode.completed", { producer: prod, request_id: "r2", attributes: { completion_tokens: 40, backend_eval_ms: 1000 } }),
            at(30_000, "request.completed", { producer: prod, request_id: "r2", attributes: { completion_tokens: 40, token_counts_from_backend: true, ttft_ms: 4400, total_ms: 5000 } }),
        ]);

        const split = prefillDecodeSplitModel(pd);
        expect(split.hasData).toBe(true);
        expect(split.prefill.label).toBe("Prefill");
        expect(split.prefill.value).toContain("tok/s");
        expect(split.decode.label).toBe("Decode");
        expect(split.decode.value).toBe("40.0 tok/s");
        expect(split.recent).toHaveLength(2);
        expect(split.recent[0]!.ttftClass).toBe("reload");
        expect(split.recent[0]!.badgeLabel).toBe("Reload (4.10 s)");
        expect(split.recent[1]!.ttftClass).toBe("steady-prefill");

        const ttft = ttftBreakdownModel(pd);
        expect(ttft.hasData).toBe(true);
        expect(ttft.latestBadge).toBe("Latest: Model reload");
        expect(ttft.latestTone).toBe("warn");
        expect(ttft.latestDetail).toBe("4.40 s TTFT (4.10 s load)");
        expect(ttft.rows.map((r) => r.kind)).toEqual(["steady-prefill", "reload"]);
        expect(ttft.rows[0]!.summary).toContain("1 req");
        expect(ttft.rows[1]!.summary).toContain("4.40 s");

        withFakeDocument(() => {
            const splitEl = renderPrefillDecodeSplit(pd) as unknown as FakeNode;
            const ttftEl = renderTtftBreakdown(pd) as unknown as FakeNode;
            expect(splitEl.attrs["data-testid"]).toBe("prefill-decode-split");
            expect(ttftEl.attrs["data-testid"]).toBe("ttft-breakdown");
        });
    });

    it("displays 100% cached when every prompt token came from cache without inventing tok/s", () => {
        const pd = derivePrefillDecode([
            at(0, "request.started", { request_id: "r-cache" }),
            at(10, "inference.prefill.completed", { request_id: "r-cache", attributes: { prompt_tokens: 2048, backend_cached_tokens: 2048, backend_prompt_eval_ms: 1.5, ttft_ms: 10 } }),
            at(20, "request.completed", { request_id: "r-cache" }),
        ]);
        const split = prefillDecodeSplitModel(pd);
        expect(split.hasData).toBe(true);
        expect(split.prefill.value).toBe("100% cached");
        expect(split.prefill.detail).toContain("1 full cache hit");
        expect(split.decode.value).toBe("—");
    });

    it("preserves legacy synthetic fixture card gating while surfacing prefill vs decode split", () => {
        const raw = readFileSync(new URL("../../fixtures/synthetic-session.ndjson", import.meta.url), "utf8");
        const events = orderEvents(parseNdjson(raw).events).events;
        // Legacy fixture uses kind="vram" and plain route.selected -> no extra GPU/route cards added.
        expect(nodeGpuCardModels(deriveNodeGpuMemory(events))).toEqual([]);
        expect(routeCardModel(deriveExecutionRoutes(events))).toBeNull();
        // Prefill vs Decode split still derives cleanly from synthetic fixture's inference.prefill.completed.
        const pd = derivePrefillDecode(events);
        const split = prefillDecodeSplitModel(pd);
        expect(split.hasData).toBe(true);
        expect(split.prefill.available).toBe(true);
        expect(split.decode.available).toBe(true);
    });
});
