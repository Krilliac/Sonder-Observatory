/** Summary metric rows shared by the HTML and markdown reports. */
import type { Metrics } from "../query/metrics";
import { fmtBytes, fmtMs, fmtPct, fmtRate } from "../renderer/format";

export interface MetricRow {
    label: string;
    value: string;
}

export function metricRows(m: Metrics): MetricRow[] {
    const open = m.requests.filter((r) => r.outcome === "open").length;
    const errorTypes = Object.entries(m.errors.byType)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([t, n]) => `${t} ×${n}`)
        .join(", ");
    const peak = m.resources.peak;
    return [
        { label: "Events", value: String(m.eventCount) },
        { label: "Requests", value: `${m.requests.length} (${m.requestLatency.count} finished, ${open} open)` },
        { label: "Request latency p50 / p95 / max", value: `${fmtMs(m.requestLatency.p50Ms)} / ${fmtMs(m.requestLatency.p95Ms)} / ${fmtMs(m.requestLatency.maxMs)}` },
        { label: "Time to first token p50 / p95", value: `${fmtMs(m.timeToFirstToken.p50Ms)} / ${fmtMs(m.timeToFirstToken.p95Ms)}` },
        {
            label: "Tokens (decode rate)",
            value:
                m.tokens.provenance === "unavailable"
                    ? `— (${m.tokens.chunks > 0 ? `${m.tokens.chunks} output chunks, no token count reported` : "no token events"})`
                    : `${m.tokens.total} ${m.tokens.provenance} (${fmtRate(m.tokens.overallRate)} tok/s over ${fmtMs(m.tokens.activeDecodeMs)} of decode)${m.tokens.chunks > 0 ? `, ${m.tokens.chunks} output chunks not counted` : ""}`,
        },
        { label: "Errors", value: m.errors.total === 0 ? "0" : `${m.errors.total} (${errorTypes})` },
        { label: "Agents spawned / completed", value: `${m.agents.spawned} / ${m.agents.completed}` },
        { label: "Tools called / completed / failed", value: `${m.tools.called} / ${m.tools.completed} / ${m.tools.failed}` },
        {
            label: "Peak memory",
            value: peak ? `${fmtPct(peak.fraction)} (${fmtBytes(peak.usedBytes)} of ${fmtBytes(peak.totalBytes)}${peak.deviceId ? `, ${peak.deviceId}` : ""})` : "—",
        },
        { label: "Resource pressure events", value: String(m.resources.pressureEvents) },
        { label: "Dropped events", value: String(m.droppedEvents) },
    ];
}

export function severityCounts(findings: readonly { severity: string }[]): string {
    const c = { critical: 0, warning: 0, info: 0 } as Record<string, number>;
    for (const f of findings) {
        c[f.severity] = (c[f.severity] ?? 0) + 1;
    }
    return `${c.critical} critical · ${c.warning} warning · ${c.info} info`;
}
