import { describe, expect, it } from "vitest";
import { ollamaPoolFixture } from "../../src/inference3d/fixtures";
import { deriveMetrics } from "../../src/query/metrics";
import { stripSeries } from "../../src/query/series";
import { stripItems } from "../../src/renderer/metricStrip";

describe("metric strip", () => {
    const events = ollamaPoolFixture();
    const m = deriveMetrics(events);
    const s = stripSeries(events, m);

    it("derives sparklines only from reported data", () => {
        expect(s.tokensPerSec.length).toBe(24);
        // Two completed Inference requests with backend eval windows carry all the tokens.
        const decodeTokens = m.requests.filter((r) => r.decode).reduce((n, r) => n + r.decode!.tokens, 0);
        expect(decodeTokens).toBe(463 + 201);
        expect(s.tokensPerSec.some((v) => v > 0)).toBe(true);
        expect(s.latencyP50.length).toBe(m.requests.filter((r) => r.endNs !== null).length);
        expect(s.kvLatest).toMatchObject({ source: "blocks", usedBlocks: 24, totalBlocks: 8192, producers: 2 });
        expect(s.kv.every((v) => v >= 0 && v <= 1)).toBe(true);
        expect(s.agentActivity.reduce((a, b) => a + b, 0)).toBe(3); // three route.selected
        expect(s.activeModel).toMatchObject({ model: "qwen3:14b", distinct: 2 });
    });

    it("shows a dash and says why when a metric has no evidence", () => {
        const empty = deriveMetrics([]);
        const items = stripItems(empty, stripSeries([], empty));
        expect(items.map((i) => i.title)).toEqual(["Tokens / sec", "Latency p50", "Latency p95", "KV cache", "Active model", "Agent activity"]);
        const byId = Object.fromEntries(items.map((i) => [i.id, i]));
        expect(byId.tokens!.value).toBe("—");
        expect(byId.kv!.value).toBe("—");
        expect(byId.kv!.sub).toContain("not reported");
        expect(byId.model!.value).toBe("—");
        expect(items.every((i) => i.points.length === 0)).toBe(true);
    });

    it("formats the live-like pool", () => {
        const byId = Object.fromEntries(stripItems(m, s).map((i) => [i.id, i]));
        expect(byId.tokens!.value).not.toBe("—");
        expect(byId.kv!.value).toBe("0%");
        expect(byId.kv!.sub).toBe("24 / 8192 logical blocks");
        expect(byId.model!.value).toBe("qwen3:14b");
    });
});
