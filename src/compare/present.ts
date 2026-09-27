/**
 * Formatting for the comparison view: turns Comparison values into display
 * strings. DOM-free so it is unit-testable in Node.
 */
import type { Finding } from "../diagnostics";
import { fmtMs, fmtRate } from "../renderer/format";
import type { TopologyEdge, TopologyNode } from "../topology";
import type { Alignment } from "./align";
import type { MetricDelta, MetricUnit, Verdict } from "./delta";

const NUMBER = new Intl.NumberFormat("en-US");

export function formatValue(unit: MetricUnit, value: number | null): string {
    if (value === null) {
        return "—";
    }
    switch (unit) {
        case "ms":
            return fmtMs(value);
        case "tok/s":
            return `${fmtRate(value)} tok/s`;
        case "tokens":
        case "count":
            return NUMBER.format(value);
        case "usd":
            return `$${value.toFixed(Math.abs(value) >= 1 ? 2 : 6)}`;
        case "fraction":
            return `${(value * 100).toFixed(1)}%`;
    }
}

function signed(text: string, negative: boolean): string {
    return `${negative ? "−" : "+"}${text}`;
}

/** "+134 ms (+95.7%)", "−6.4 tok/s (−21.6%)", "+4.0 pp", "±0". */
export function formatDelta(d: MetricDelta): string {
    if (d.delta === null) {
        return "—";
    }
    if (d.delta === 0) {
        return "±0";
    }
    const neg = d.delta < 0;
    const mag = Math.abs(d.delta);
    if (d.unit === "fraction") {
        return signed(`${(mag * 100).toFixed(1)} pp`, neg);
    }
    const abs = signed(formatValue(d.unit, mag), neg);
    return d.relative === null ? abs : `${abs} (${signed(`${(Math.abs(d.relative) * 100).toFixed(1)}%`, d.relative < 0)})`;
}

export const VERDICT_TEXT: Record<Verdict, string> = {
    better: "better",
    worse: "worse",
    changed: "changed",
    same: "same",
    "only-a": "only in A",
    "only-b": "only in B",
    "n/a": "n/a",
};

export interface MetricCell {
    key: string;
    label: string;
    a: string;
    b: string;
    delta: string;
    verdict: Verdict;
    verdictText: string;
}

export function presentDelta(d: MetricDelta): MetricCell {
    return {
        key: d.key,
        label: d.label,
        a: formatValue(d.unit, d.a),
        b: formatValue(d.unit, d.b),
        delta: formatDelta(d),
        verdict: d.verdict,
        verdictText: VERDICT_TEXT[d.verdict],
    };
}

export function describeAlignment(al: Alignment): string {
    const matched = al.pairs.filter((p) => p.status === "matched").length;
    const onlyA = al.pairs.filter((p) => p.status === "only-a").length;
    const onlyB = al.pairs.filter((p) => p.status === "only-b").length;
    const how =
        al.matchedBy === "id"
            ? `${al.mode} id`
            : al.inferred
              ? "position (turns inferred from request start order; no turn ids reported)"
              : `position (no shared ${al.mode} ids)`;
    return `Matched by ${how}: ${matched} matched, ${onlyA} only in A, ${onlyB} only in B.`;
}

export const SEVERITY_TEXT: Record<Finding["severity"], string> = { info: "INFO", warning: "WARN", critical: "CRIT" };

export function nodeText(n: TopologyNode): string {
    return `${n.kind} ${n.label}${n.role ? ` (${n.role})` : ""}`;
}

function endpoint(id: string): string {
    const i = id.indexOf(":");
    return i >= 0 ? id.slice(i + 1) : id;
}

export function edgeText(e: TopologyEdge): string {
    return `${e.kind.replace(/_/g, " ")}: ${endpoint(e.source)} → ${endpoint(e.target)}`;
}
