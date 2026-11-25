/** Summary metric rows shared by the HTML and markdown reports. */
import type { Metrics } from "../query/metrics";
import { fmtBytes, fmtMs, fmtPct, fmtRate } from "../renderer/format";
import type { ReportGpuSummary } from "./report";

export interface MetricRow {
    label: string;
    value: string;
}

function formatGpuSummaryRow(gpu: ReportGpuSummary): string {
    const parts: string[] = [];
    for (const node of gpu.nodes.slice(0, 8)) {
        const pool = node.combinedPool;
        if (pool) {
            const kindBits: string[] = [];
            if (pool.discreteCount > 0) kindBits.push(`${pool.discreteCount} discrete`);
            if (pool.integratedUmaCount > 0) kindBits.push(`${pool.integratedUmaCount} integrated UMA`);
            if (pool.unknownCount > 0) kindBits.push(`${pool.unknownCount} GPU`);
            const usage =
                pool.combinedUsedBytes !== null && pool.combinedTotalBytes !== null
                    ? `${fmtBytes(pool.combinedUsedBytes)} / ${fmtBytes(pool.combinedTotalBytes)}${pool.combinedUsedFraction !== null ? ` (${fmtPct(pool.combinedUsedFraction)})` : ""}`
                    : pool.combinedTotalBytes !== null
                      ? fmtBytes(pool.combinedTotalBytes)
                      : "—";
            parts.push(`${node.nodeId}: ${pool.isHybridDiscreteUma ? "hybrid " : ""}${kindBits.join(" + ")} ${usage}`);
        } else {
            for (const dev of node.devices.slice(0, 4)) {
                const cls = dev.gpuClass === "integrated-uma" ? "UMA" : dev.gpuClass === "discrete" ? "discrete" : "GPU";
                const usage =
                    dev.effectiveUsedBytes !== null && dev.effectiveTotalBytes !== null
                        ? `${fmtBytes(dev.effectiveUsedBytes)} / ${fmtBytes(dev.effectiveTotalBytes)}`
                        : dev.effectiveTotalBytes !== null
                          ? fmtBytes(dev.effectiveTotalBytes)
                          : "—";
                parts.push(`${node.nodeId}/${dev.name} (${cls}): ${usage}`);
            }
        }
    }
    if (parts.length === 0) {
        for (const b of gpu.backends.slice(0, 8)) {
            const label = `${b.nodeId}/${b.backend ?? b.producer}`;
            const mem = [
                b.dedicatedBytes !== null ? `dedicated ${fmtBytes(b.dedicatedBytes)}` : null,
                b.sharedBytes !== null ? `shared ${fmtBytes(b.sharedBytes)}` : null,
                b.spilled === true ? "spilled" : null,
                b.fittedCtx !== null ? `ctx ${b.fittedCtx}` : null,
            ]
                .filter((x): x is string => x !== null)
                .join(", ");
            parts.push(`${label}: ${mem || "—"}`);
        }
    }
    return parts.join("; ") || "—";
}

export function metricRows(m: Metrics, gpu?: ReportGpuSummary): MetricRow[] {
    const open = m.requests.filter((r) => r.outcome === "open").length;
    const errorTypes = Object.entries(m.errors.byType)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([t, n]) => `${t} ×${n}`)
        .join(", ");
    const peak = m.resources.peak;
    const rows: MetricRow[] = [
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
            value:
                peak && Number.isFinite(peak.fraction) && Number.isFinite(peak.usedBytes) && Number.isFinite(peak.totalBytes)
                    ? `${fmtPct(peak.fraction)} (${fmtBytes(peak.usedBytes)} of ${fmtBytes(peak.totalBytes)}${peak.deviceId ? `, ${peak.deviceId}` : ""})`
                    : "—",
        },
        { label: "Resource pressure events", value: String(m.resources.pressureEvents) },
        { label: "Dropped events", value: String(m.droppedEvents) },
    ];

    // Wave 2 additive rows (omitted when absent so legacy session reports remain unchanged).
    const embedReqs = m.requests.filter((r) => r.requestKind === "embed");
    if (embedReqs.length > 0) {
        const embedOpen = embedReqs.filter((r) => r.outcome === "open").length;
        const embedFinished = embedReqs.length - embedOpen;
        rows.push({
            label: "Embedding requests",
            value: `${embedReqs.length} (${embedFinished} finished, ${embedOpen} open)`,
        });
    }

    const er = m.executionRoutes;
    if (er && er.total > 0) {
        const modes = (["single", "ensemble", "fanout", "agent"] as const)
            .filter((k) => er.byMode[k] > 0)
            .map((k) => `${k} ×${er.byMode[k]}`)
            .join(", ");
        const bands = (["quick", "standard", "hard", "multi_scope"] as const)
            .filter((k) => er.byBand[k] > 0)
            .map((k) => `${k} ×${er.byBand[k]}`)
            .join(", ");
        const selectionParts: string[] = [];
        if (er.autoCount > 0) selectionParts.push(`auto ${er.autoCount}`);
        if (er.manualCount > 0) selectionParts.push(`manual ${er.manualCount}`);
        const details = [modes, selectionParts.join(", "), bands ? `bands: ${bands}` : ""].filter(Boolean).join("; ");
        rows.push({
            label: "Execution routes",
            value: details ? `${er.total} (${details})` : String(er.total),
        });
    }

    const orch = m.orchestration;
    if (orch && (orch.fanout.total > 0 || orch.ensemble.total > 0)) {
        const parts: string[] = [];
        for (const [name, s] of [
            ["fanout", orch.fanout],
            ["ensemble", orch.ensemble],
        ] as const) {
            if (s.total === 0) continue;
            const lat = s.latency.p50Ms !== null ? `, p50 ${fmtMs(s.latency.p50Ms)}` : "";
            parts.push(`${name} ${s.total} (${s.completed} completed, ${s.failed} failed, ${s.open} open${lat})`);
        }
        rows.push({ label: "Orchestration", value: parts.join(" · ") });
    }

    if (gpu && (gpu.nodes.length > 0 || gpu.backends.length > 0)) {
        rows.push({ label: "GPU / UMA memory", value: formatGpuSummaryRow(gpu) });
    }

    return rows;
}

export function severityCounts(findings: readonly { severity: string }[]): string {
    const c = { critical: 0, warning: 0, info: 0 } as Record<string, number>;
    for (const f of findings) {
        if (Object.hasOwn(c, f.severity)) {
            c[f.severity] = (c[f.severity] ?? 0) + 1;
        }
    }
    return `${c.critical} critical · ${c.warning} warning · ${c.info} info`;
}
