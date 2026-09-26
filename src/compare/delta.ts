/**
 * Metric deltas between two UnitStats (A = baseline, B = candidate).
 */
import type { UnitStats } from "./summary";

export type MetricKey =
    | "requests"
    | "failedRequests"
    | "ttftMs"
    | "ttftP95Ms"
    | "decodeTokPerSec"
    | "promptTokens"
    | "completionTokens"
    | "costUsd"
    | "costBudgetFraction"
    | "budgetPeakFraction"
    | "retries"
    | "cacheHitRate"
    | "errors";

export type MetricUnit = "count" | "ms" | "tok/s" | "tokens" | "usd" | "fraction";

/** Which direction is an improvement. "neutral" metrics are reported as changed, not better/worse. */
export type Polarity = "lower" | "higher" | "neutral";

export type Verdict = "better" | "worse" | "changed" | "same" | "only-a" | "only-b" | "n/a";

export interface MetricDef {
    key: MetricKey;
    label: string;
    unit: MetricUnit;
    polarity: Polarity;
    /** Relative change below which two values count as the same (0 = exact). */
    tolerance: number;
    group: "latency" | "tokens" | "cost" | "reliability" | "cache" | "volume";
}

export const METRICS: readonly MetricDef[] = [
    { key: "requests", label: "Requests", unit: "count", polarity: "neutral", tolerance: 0, group: "volume" },
    { key: "ttftMs", label: "TTFT p50", unit: "ms", polarity: "lower", tolerance: 0.005, group: "latency" },
    { key: "ttftP95Ms", label: "TTFT p95", unit: "ms", polarity: "lower", tolerance: 0.005, group: "latency" },
    { key: "decodeTokPerSec", label: "Decode rate", unit: "tok/s", polarity: "higher", tolerance: 0.005, group: "latency" },
    { key: "promptTokens", label: "Prompt tokens", unit: "tokens", polarity: "neutral", tolerance: 0, group: "tokens" },
    { key: "completionTokens", label: "Completion tokens", unit: "tokens", polarity: "neutral", tolerance: 0, group: "tokens" },
    { key: "costUsd", label: "Cost", unit: "usd", polarity: "lower", tolerance: 0.005, group: "cost" },
    { key: "costBudgetFraction", label: "Cost budget used", unit: "fraction", polarity: "lower", tolerance: 0.005, group: "cost" },
    { key: "budgetPeakFraction", label: "Context budget peak", unit: "fraction", polarity: "lower", tolerance: 0.005, group: "cost" },
    { key: "retries", label: "Retries", unit: "count", polarity: "lower", tolerance: 0, group: "reliability" },
    { key: "failedRequests", label: "Failed requests", unit: "count", polarity: "lower", tolerance: 0, group: "reliability" },
    { key: "errors", label: "Error events", unit: "count", polarity: "lower", tolerance: 0, group: "reliability" },
    { key: "cacheHitRate", label: "Cache hit rate", unit: "fraction", polarity: "higher", tolerance: 0.005, group: "cache" },
];

export interface MetricDelta {
    key: MetricKey;
    label: string;
    unit: MetricUnit;
    polarity: Polarity;
    a: number | null;
    b: number | null;
    /** b - a, or null when either side is unavailable. */
    delta: number | null;
    /** (b - a) / |a|, or null when a is 0 or unavailable. */
    relative: number | null;
    verdict: Verdict;
}

export function metricDelta(def: MetricDef, a: number | null, b: number | null): MetricDelta {
    const base = { key: def.key, label: def.label, unit: def.unit, polarity: def.polarity, a, b };
    if (a === null || b === null) {
        const verdict: Verdict = a === null && b === null ? "n/a" : a === null ? "only-b" : "only-a";
        return { ...base, delta: null, relative: null, verdict };
    }
    const delta = b - a;
    const relative = a !== 0 ? delta / Math.abs(a) : null;
    let verdict: Verdict;
    if (delta === 0 || (def.tolerance > 0 && relative !== null && Math.abs(relative) < def.tolerance)) {
        verdict = "same";
    } else if (def.polarity === "neutral") {
        verdict = "changed";
    } else {
        const improved = def.polarity === "lower" ? delta < 0 : delta > 0;
        verdict = improved ? "better" : "worse";
    }
    return { ...base, delta, relative, verdict };
}

/** Deltas for every metric (A or B may be null for a one-sided unit). */
export function deltas(a: UnitStats | null, b: UnitStats | null, metrics: readonly MetricDef[] = METRICS): MetricDelta[] {
    return metrics.map((def) => metricDelta(def, a ? a[def.key] : null, b ? b[def.key] : null));
}
