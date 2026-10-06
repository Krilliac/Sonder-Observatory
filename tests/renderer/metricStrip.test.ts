import { describe, expect, it, vi } from "vitest";
import { ollamaPoolFixture } from "../../src/inference3d/fixtures";
import { deriveMetrics } from "../../src/query/metrics";
import { stripSeries } from "../../src/query/series";
import { renderMetricStrip, stripItems, type StripItem } from "../../src/renderer/metricStrip";
import type { ObservatoryEvent } from "../../src/protocol/events";
import { makeEvent } from "../helpers";

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

// A document adapter for the public renderer's output contract. This models only
// the DOM operations used by dom.ts; real browser behavior is tested separately.
interface StripNodeSnapshot {
    tag: string;
    namespace: string | null;
    attrs: Record<string, string>;
    text: string;
    children: (StripNodeSnapshot | string)[];
}

class StripDocumentNode {
    readonly attrs: Record<string, string> = {};
    textContent = "";
    readonly children: (StripDocumentNode | string)[] = [];
    constructor(readonly tag: string, readonly namespace: string | null = null) {}
    set className(value: string) { this.attrs.class = value; }
    setAttribute(name: string, value: string): void { this.attrs[name] = value; }
    append(...children: (StripDocumentNode | string)[]): void { this.children.push(...children); }
    replaceChildren(...children: (StripDocumentNode | string)[]): void {
        this.children.splice(0, this.children.length, ...children);
    }
    snapshot(): StripNodeSnapshot {
        return { tag: this.tag, namespace: this.namespace, attrs: { ...this.attrs }, text: this.textContent,
            children: this.children.map((child) => typeof child === "string" ? child : child.snapshot()) };
    }
}

function withStripDocument(check: (container: StripDocumentNode) => void): void {
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
        createElement: (tag: string) => new StripDocumentNode(tag),
        createElementNS: (namespace: string, tag: string) => new StripDocumentNode(tag, namespace),
    } });
    try { check(new StripDocumentNode("section")); }
    finally {
        if (original) { Object.defineProperty(globalThis, "document", original); }
        else { Reflect.deleteProperty(globalThis, "document"); }
    }
}

function latencyItem(id: string, points: number[]): StripItem {
    return Object.freeze({ id, title: id, value: "synthetic", sub: "synthetic reported latency",
        tone: "latency", trend: "synthetic latency samples", points });
}

// Native spread is the small oracle. The large oracle bounds every spread to
// 4096 values, then combines at most 32 chunk extrema for 131072 points.
function nativePath(points: readonly number[], chunked = false): string {
    let max: number;
    let min: number;
    if (chunked) {
        const maxima: number[] = [];
        const minima: number[] = [];
        for (let offset = 0; offset < points.length; offset += 4096) {
            const chunk = points.slice(offset, offset + 4096);
            maxima.push(Math.max(...chunk));
            minima.push(Math.min(...chunk));
        }
        max = Math.max(...maxima);
        min = Math.min(0, ...minima);
    } else {
        max = Math.max(...points);
        min = Math.min(0, ...points);
    }
    const range = max - min || 1;
    return points.map((value, index) =>
        `${(index * (96 / (points.length - 1))).toFixed(1)},${(24 - ((value - min) / range) * 22).toFixed(1)}`).join(" ");
}

function expectedStrip(items: readonly StripItem[], chunked = false): StripNodeSnapshot {
    const node = (tag: string, attrs: Record<string, string> = {}, text = "", children: StripNodeSnapshot[] = [],
        namespace: string | null = null): StripNodeSnapshot => ({ tag, namespace, attrs, text, children });
    const svgNS = "http://www.w3.org/2000/svg";
    return node("section", {}, "", items.map((item) => {
        const path = item.points.length >= 2 ? nativePath(item.points, chunked) : null;
        const main = [node("span", { class: "strip-value", title: item.value }, item.value)];
        if (path !== null) {
            main.push(node("svg", { class: "spark", viewBox: "0 0 96 26", preserveAspectRatio: "none", height: "26",
                "aria-hidden": "true", focusable: "false" }, "", [
                node("polyline", { class: "spark-area", points: `0,26 ${path} 96,26` }, "", [], svgNS),
                node("polyline", { class: "spark-line", points: path }, "", [], svgNS),
            ], svgNS));
        }
        const children = [node("h3", {}, item.title), node("div", { class: "strip-main" }, "", main),
            node("div", { class: "strip-sub" }, item.sub)];
        if (path !== null) { children.push(node("span", { class: "sr-only" }, `Trend: ${item.trend}.`)); }
        return node("article", { class: `strip-card tone-${item.tone}`, "data-metric": item.id }, "", children);
    }));
}

function renderedLine(snapshot: StripNodeSnapshot, card: number): string {
    const main = snapshot.children[card] as StripNodeSnapshot;
    const body = main.children[1] as StripNodeSnapshot;
    const spark = body.children[1] as StripNodeSnapshot;
    return (spark.children[1] as StripNodeSnapshot).attrs.points!;
}

describe("metric strip public render output", () => {
    it.each([
        ["negative", [-3, -1, -2]], ["positive", [1, 3, 2]], ["equal", [2, 2, 2]],
        ["late extrema", [2, 2, -7, 11]], ["signed zero", [-0, +0, -0]],
        ["NaN", [1, NaN, 2]], ["infinities", [-Infinity, 2, Infinity]],
        ["negative infinity", [-Infinity, -Infinity]], ["positive infinity", [Infinity, Infinity]],
    ] as const)("matches the complete native render oracle for %s", (_label, values) => {
        const points = Object.freeze([...values]) as unknown as number[];
        const items = Object.freeze([latencyItem("latency-p50", points), latencyItem("latency-p95", points)]);
        const expected = expectedStrip(items);
        withStripDocument((container) => {
            renderMetricStrip(container as unknown as HTMLElement, items);
            expect(container.snapshot()).toEqual(expected);
            renderMetricStrip(container as unknown as HTMLElement, items);
            expect(container.snapshot()).toEqual(expected);
            expect(points.length).toBe(values.length);
            expect(points.every((value, index) => Object.is(value, values[index]))).toBe(true);
            expect(items.every((item) => item.points === points)).toBe(true);
        });
    });

    it.each([{ values: [] as number[] }, { values: [7] }])("omits SVG and trend for $values without leaving prior cards", ({ values }) => {
        const items = [latencyItem("latency-p50", values)];
        withStripDocument((container) => {
            renderMetricStrip(container as unknown as HTMLElement, [latencyItem("latency-p95", [1, 2])]);
            renderMetricStrip(container as unknown as HTMLElement, items);
            expect(container.snapshot()).toEqual(expectedStrip(items));
            renderMetricStrip(container as unknown as HTMLElement, []);
            expect(container.snapshot()).toEqual(expectedStrip([]));
        });
    });

    it.each([
        ["negative-zero pair", -0, -0], ["mixed zero", +0, -0], ["positive-zero pair", +0, +0],
    ] as const)("preserves native signed extrema for %s", (_label, a, b) => {
        const points = [a, b];
        const nativeMin = Math.min;
        const nativeMax = Math.max;
        const expectedMin = nativeMin(0, ...points);
        const expectedMax = nativeMax(...points);
        const mins: number[] = [];
        const maxes: number[] = [];
        const minSpy = vi.spyOn(Math, "min").mockImplementation((...args) => {
            const value = nativeMin(...args); mins.push(value); return value;
        });
        try {
            const maxSpy = vi.spyOn(Math, "max").mockImplementation((...args) => {
                const value = nativeMax(...args); maxes.push(value); return value;
            });
            try {
                withStripDocument((container) => renderMetricStrip(container as unknown as HTMLElement,
                    [latencyItem("latency-p50", points)]));
                const actualMin = mins[mins.length - 1];
                const actualMax = maxes[maxes.length - 1];
                expect(mins.length).toBeGreaterThan(0);
                expect(maxes.length).toBeGreaterThan(0);
                expect(Object.is(actualMin, expectedMin)).toBe(true);
                expect(Object.is(actualMax, expectedMax)).toBe(true);
            } finally { maxSpy.mockRestore(); }
        } finally { minSpy.mockRestore(); }
    });

    it("renders both complete 131072-point latency paths without truncation", () => {
        const count = 131072;
        const p50 = Object.freeze(Array.from({ length: count }, (_, i) => i === count - 1 ? -41 : (i % 97) - 12)) as unknown as number[];
        const p95 = Object.freeze(Array.from({ length: count }, (_, i) => i === count - 2 ? 503 : (i % 173) + 1)) as unknown as number[];
        const items = [latencyItem("latency-p50", p50), latencyItem("latency-p95", p95)];
        const expected = expectedStrip(items, true);
        withStripDocument((container) => {
            renderMetricStrip(container as unknown as HTMLElement, items);
            const actual = container.snapshot();
            expect(actual).toEqual(expected);
            for (let card = 0; card < 2; card++) {
                expect(renderedLine(actual, card).split(" ")).toHaveLength(count);
                expect(renderedLine(actual, card).endsWith(renderedLine(expected, card).split(" ")[count - 1]!)).toBe(true);
            }
            expect(items[0]!.points).toBe(p50);
            expect(items[1]!.points).toBe(p95);
        });
    });

    it("keeps one rolling sample per each of 131072 complete request pairs", () => {
        const count = 131072;
        const producer = Object.freeze({ name: "synthetic-metric-strip", version: "1", node_id: "fixture", instance_id: "large-latency", synthetic: true });
        const attributes = Object.freeze({});
        const events: ObservatoryEvent[] = [];
        for (let index = 0; index < count; index++) {
            const start = index * 32_000_000;
            const common = { request_id: `synthetic-request-${index}`, session_id: "synthetic-latencies", producer, attributes };
            events.push(Object.freeze(makeEvent({ ...common, event_id: `synthetic-start-${index}`, sequence: index * 2,
                event_type: "request.started", mono_ns: start })));
            events.push(Object.freeze(makeEvent({ ...common, event_id: `synthetic-end-${index}`, sequence: index * 2 + 1,
                event_type: "request.completed", mono_ns: start + ((index % 17) + 1) * 1_000_000 })));
        }
        Object.freeze(events);
        const metrics = deriveMetrics(events);
        const series = stripSeries(events, metrics);
        expect(metrics.eventCount).toBe(count * 2);
        expect(metrics.requests).toHaveLength(count);
        expect(metrics.requestLatency.count).toBe(count);
        expect(metrics.requests.every((span, index) => span.requestId === `synthetic-request-${index}` && span.outcome === "completed")).toBe(true);
        const expected50: number[] = [];
        const expected95: number[] = [];
        for (let index = 0; index < count; index++) {
            const window = Array.from({ length: Math.min(8, index + 1) }, (_, offset) =>
                ((Math.max(0, index - 7) + offset) % 17) + 1).sort((a, b) => a - b);
            expected50.push(window[Math.ceil(window.length / 2) - 1]!);
            expected95.push(window[Math.ceil(window.length * 0.95) - 1]!);
        }
        expect(series.latencyP50).toEqual(expected50);
        expect(series.latencyP95).toEqual(expected95);
        const latencyCards = stripItems(metrics, series).filter((item) => item.tone === "latency");
        expect(latencyCards.map((item) => item.points.length)).toEqual([count, count]);
        expect(stripSeries(events, metrics)).toBe(series);
        expect(events.length).toBe(count * 2);
        expect(events.every((event, index) => event.sequence === index && event.event_id ===
            `synthetic-${index % 2 === 0 ? "start" : "end"}-${Math.floor(index / 2)}`)).toBe(true);
    });
});
