/**
 * Metric strip above the view tabs (concept board "metric cards with
 * sparklines"): tokens/sec, latency p50/p95, KV cache, active model and agent
 * activity. Values are the existing derived metrics; sparklines come from
 * src/query/series.ts. A metric without evidence shows "—" and says why.
 */
import type { Metrics } from "../query/metrics";
import type { StripSeries } from "../query/series";
import { h, svg } from "./dom";
import { fmtMs, fmtRate } from "./format";

export interface StripItem {
    id: string;
    title: string;
    value: string;
    sub: string;
    points: number[];
    tone: "token" | "latency" | "kv" | "model" | "agent";
    /** Accessible description of the sparkline (what the points are). */
    trend: string;
}

function trendWords(points: readonly number[]): string {
    if (points.length < 2) {
        return "not enough points for a trend";
    }
    const a = points[0]!;
    const b = points[points.length - 1]!;
    const d = b - a;
    const rel = Math.abs(d) / Math.max(Math.abs(a), 1e-9);
    return rel < 0.05 ? "flat" : d > 0 ? "rising" : "falling";
}

/** Pure model of the strip (unit-tested). */
export function stripItems(m: Metrics, s: StripSeries): StripItem[] {
    const t = m.tokens;
    const kv = s.kvLatest;
    const model = s.activeModel;
    return [
        {
            id: "tokens",
            title: "Tokens / sec",
            value: t.overallRate !== null ? fmtRate(t.overallRate) : "—",
            sub:
                t.overallRate !== null
                    ? `decode rate · last ${t.windowMs / 1000} s ${fmtRate(t.recentRate)}`
                    : t.chunks > 0
                      ? "chunks only; no token count yet"
                      : "no decode windows yet",
            points: s.tokensPerSec,
            tone: "token",
            trend: `decode tokens per second over the session, ${trendWords(s.tokensPerSec)}`,
        },
        {
            id: "latency-p50",
            title: "Latency p50",
            value: fmtMs(m.requestLatency.p50Ms),
            sub: m.requestLatency.count > 0 ? `${m.requestLatency.count} finished requests` : "no finished requests",
            points: s.latencyP50,
            tone: "latency",
            trend: `rolling p50 over the last 8 finished requests, ${trendWords(s.latencyP50)}`,
        },
        {
            id: "latency-p95",
            title: "Latency p95",
            value: fmtMs(m.requestLatency.p95Ms),
            sub: m.requestLatency.maxMs !== null ? `max ${fmtMs(m.requestLatency.maxMs)}` : "no finished requests",
            points: s.latencyP95,
            tone: "latency",
            trend: `rolling p95 over the last 8 finished requests, ${trendWords(s.latencyP95)}`,
        },
        {
            id: "kv",
            title: "KV cache",
            value: kv ? `${Math.round(kv.fraction * 100)}%` : "—",
            sub: kv
                ? kv.source === "blocks"
                    ? `${kv.usedBlocks} / ${kv.totalBlocks} logical blocks`
                    : `kv.pressure occupancy · ${kv.producers} producer(s)`
                : "not reported (no kv.* events)",
            points: s.kv,
            tone: "kv",
            trend: `KV blocks in use over the session, ${trendWords(s.kv)}`,
        },
        {
            id: "model",
            title: "Active model",
            value: model ? model.model : "—",
            sub: model ? `${model.nodeId} · ${model.source}${model.distinct > 1 ? ` · ${model.distinct} models` : ""}` : "no model named yet",
            points: [],
            tone: "model",
            trend: "",
        },
        {
            id: "agents",
            title: "Agent activity",
            value: `${m.agents.active.length} active`,
            sub: `${m.tools.active.length} tool call(s) running · ${m.agents.transitions} route/agent events`,
            points: s.agentActivity,
            tone: "agent",
            trend: `agent, route and tool events per time slice, ${trendWords(s.agentActivity)}`,
        },
    ];
}

const W = 96;
const H = 26;

function sparkline(points: readonly number[]): SVGElement | null {
    if (points.length < 2) {
        return null;
    }
    let max = -Infinity;
    for (const p of points) {
        max = Math.max(max, p);
    }
    let min = +0;
    for (const p of points) {
        min = Math.min(min, p);
    }
    const range = max - min || 1;
    const step = W / (points.length - 1);
    const coords = points.map((p, i) => `${(i * step).toFixed(1)},${(H - 2 - ((p - min) / range) * (H - 4)).toFixed(1)}`);
    const el = svg("svg", { class: "spark", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", height: H, "aria-hidden": "true", focusable: "false" });
    el.append(
        svg("polyline", { class: "spark-area", points: `0,${H} ${coords.join(" ")} ${W},${H}` }),
        svg("polyline", { class: "spark-line", points: coords.join(" ") }),
    );
    return el;
}

export function renderMetricStrip(container: HTMLElement, items: readonly StripItem[]): void {
    container.replaceChildren(
        ...items.map((it) =>
            h(
                "article",
                { class: `strip-card tone-${it.tone}`, "data-metric": it.id },
                h("h3", { text: it.title }),
                h("div", { class: "strip-main" }, h("span", { class: "strip-value", text: it.value, title: it.value }), sparkline(it.points)),
                h("div", { class: "strip-sub", text: it.sub }),
                it.points.length >= 2 ? h("span", { class: "sr-only", text: `Trend: ${it.trend}.` }) : null,
            ),
        ),
    );
}
