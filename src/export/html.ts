/**
 * Self-contained HTML session report: one file, inline CSS, inline SVG, no
 * scripts and no external requests. A Content-Security-Policy meta tag
 * (`default-src 'none'`) makes the "no network" property enforced by the
 * browser, not just by construction.
 */
import { fmtBytes, fmtPct } from "../renderer/format";
import type { Report, ReportFinding, ReportGpuSummary } from "./report";
import { metricRows, severityCounts } from "./summary";
import { esc, renderTimelineSvg, renderTopologyLegend, renderTopologySvg, trackColor } from "./svg";

export const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

const VALID_SEVERITIES = new Set(["critical", "warning", "info"]);
const MAX_HEADER_LIST = 50;
const MAX_FACTS_PER_FINDING = 64;
const DEFAULT_MAX_FINDINGS = 500;
const DEFAULT_MAX_EVIDENCE = 200;

const CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; background: #0B1220; color: #E2E8F0; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1200px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 28px 0 10px; border-bottom: 1px solid #24334A; padding-bottom: 4px; }
.muted { color: #94A3B8; }
.warn { color: #F59E0B; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #1E293B; vertical-align: top; }
th { color: #94A3B8; font-weight: 600; }
.metrics td:first-child { color: #94A3B8; width: 40%; }
.finding { border: 1px solid #24334A; border-left-width: 4px; border-radius: 6px; padding: 10px 12px; margin: 10px 0; background: #0F172A; }
.finding.critical { border-left-color: #EF4444; }
.finding.warning { border-left-color: #F59E0B; }
.finding.info { border-left-color: #3B82F6; }
.finding header { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.sev { font-weight: 700; text-transform: uppercase; font-size: 11px; letter-spacing: .04em; }
.critical .sev { color: #EF4444; } .warning .sev { color: #F59E0B; } .info .sev { color: #3B82F6; }
.facts { margin: 6px 0; display: flex; flex-wrap: wrap; gap: 4px 12px; }
.evidence td { padding: 2px 8px; font-size: 12px; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
.figure { overflow-x: auto; background: #0F172A; border: 1px solid #24334A; border-radius: 6px; padding: 8px; }
.legend { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 12px; color: #94A3B8; }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
.badge { display: inline-block; min-width: 14px; margin-right: 6px; text-align: center; }
footer { margin-top: 32px; font-size: 12px; color: #94A3B8; }
@media print { body { background: #fff; color: #000; } .finding, .figure { background: #fff; } }
`;

function secs(s: number | null): string {
    return s === null || !Number.isFinite(s) ? "—" : `${s.toFixed(3)} s`;
}

function clampNonNegInt(value: number | undefined, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function safeSeverityClass(severity: string): string {
    return VALID_SEVERITIES.has(severity) ? severity : "info";
}

function boundedList(items: readonly string[], fmt: (s: string) => string): string {
    const shown = items.slice(0, MAX_HEADER_LIST).map(fmt);
    if (items.length > MAX_HEADER_LIST) {
        shown.push(`<span class="muted">+${items.length - MAX_HEADER_LIST} more</span>`);
    }
    return shown.join(", ");
}

function renderGpuSection(gpu: ReportGpuSummary | undefined): string {
    if (!gpu || (gpu.nodes.length === 0 && gpu.backends.length === 0)) {
        return "";
    }
    const parts: string[] = [];
    if (gpu.nodes.length > 0) {
        const rows: string[] = [];
        for (const node of gpu.nodes) {
            for (const dev of node.devices) {
                const cls = dev.gpuClass === "integrated-uma" ? "integrated UMA" : dev.gpuClass;
                const usage =
                    dev.effectiveUsedBytes !== null && dev.effectiveTotalBytes !== null
                        ? `${fmtBytes(dev.effectiveUsedBytes)} / ${fmtBytes(dev.effectiveTotalBytes)}${dev.usedFraction !== null ? ` (${fmtPct(dev.usedFraction)})` : ""}`
                        : dev.effectiveTotalBytes !== null
                          ? fmtBytes(dev.effectiveTotalBytes)
                          : "—";
                const peak = dev.peakUsedBytes !== null ? fmtBytes(dev.peakUsedBytes) : "—";
                const weights = dev.carryingModelWeights ? `yes (${dev.weightsEvidence})` : "no";
                rows.push(
                    `<tr><td><code>${esc(node.nodeId)}</code></td><td>${esc(dev.name)}</td><td>${esc(cls)}</td><td class="mono">${esc(usage)}</td><td class="mono">${esc(peak)}</td><td>${esc(weights)}</td></tr>`,
                );
            }
            if (node.combinedPool) {
                const p = node.combinedPool;
                const usage =
                    p.combinedUsedBytes !== null && p.combinedTotalBytes !== null
                        ? `${fmtBytes(p.combinedUsedBytes)} / ${fmtBytes(p.combinedTotalBytes)}${p.combinedUsedFraction !== null ? ` (${fmtPct(p.combinedUsedFraction)})` : ""}`
                        : p.combinedTotalBytes !== null
                          ? fmtBytes(p.combinedTotalBytes)
                          : "—";
                const kind = p.isHybridDiscreteUma ? "hybrid discrete + UMA pool" : "multi-GPU pool";
                const weights = p.bothCarryingWeights ? `both active (${p.weightsEvidence})` : p.multiGpuActive ? `multi-GPU (${p.weightsEvidence})` : "—";
                rows.push(
                    `<tr><td><code>${esc(node.nodeId)}</code></td><td><strong>Combined pool</strong></td><td>${esc(kind)}</td><td class="mono">${esc(usage)}</td><td class="mono">—</td><td>${esc(weights)}</td></tr>`,
                );
            }
        }
        parts.push(
            `<table><thead><tr><th>Node</th><th>Device</th><th>Class</th><th>Used / Effective</th><th>Peak</th><th>Weights</th></tr></thead><tbody>${rows.join("\n")}</tbody></table>`,
        );
    }
    if (gpu.backends.length > 0) {
        const rows = gpu.backends.map((b) => {
            const dedicated = b.dedicatedBytes !== null ? fmtBytes(b.dedicatedBytes) : "—";
            const shared = b.sharedBytes !== null ? fmtBytes(b.sharedBytes) : "—";
            const spilled = b.spilled === true ? "yes" : b.spilled === false ? "no" : "—";
            const ctx = b.fittedCtx !== null ? String(b.fittedCtx) : "—";
            const warns = b.warningCount > 0 ? `${b.warningCount} (${b.warningCodes.join(", ")})` : "0";
            return `<tr><td><code>${esc(b.nodeId)}</code></td><td>${esc(b.backend ?? b.producer)}</td><td class="mono">${esc(dedicated)}</td><td class="mono">${esc(shared)}</td><td>${esc(spilled)}</td><td class="mono">${esc(ctx)}</td><td>${esc(warns)}</td></tr>`;
        });
        parts.push(
            `<table><thead><tr><th>Node</th><th>Backend</th><th>Dedicated</th><th>Shared</th><th>Spilled</th><th>Fitted ctx</th><th>Warnings</th></tr></thead><tbody>${rows.join("\n")}</tbody></table>`,
        );
    }
    return `\n<section><h2>GPU &amp; UMA memory</h2>\n${parts.join("\n")}\n</section>`;
}

function renderFinding(f: ReportFinding, maxEvidence: number): string {
    const factEntries = Object.entries(f.facts);
    const facts = factEntries
        .slice(0, MAX_FACTS_PER_FINDING)
        .map(([k, v]) => `<span><span class="muted">${esc(k)}</span> <code>${esc(v)}</code></span>`)
        .join("");
    const rows = f.evidence
        .slice(0, maxEvidence)
        .map(
            (e) =>
                `<tr><td class="mono">${secs(e.relS)}</td><td>${e.cls ? `<span class="dot" style="background:${trackColor(e.cls)}"></span>` : ""}<code>${esc(
                    e.eventType,
                )}</code></td><td class="mono">${esc(e.eventId)}</td></tr>`,
        )
        .join("");
    const more = f.evidence.length > maxEvidence ? `<p class="muted">…${f.evidence.length - maxEvidence} more evidence events (see the JSON export).</p>` : "";
    return `<article class="finding ${safeSeverityClass(f.severity)}" id="${esc(`finding-${f.id}`)}">
<header><span class="sev">${esc(f.severity)}</span><code>${esc(f.kind)}</code><span class="muted">${secs(f.startRelS)}–${secs(f.endRelS)} · ${esc(f.provenance)}</span></header>
<p>${esc(f.summary)}</p>
${facts ? `<div class="facts">${facts}</div>` : ""}
<details><summary>Evidence (${f.evidence.length} events)</summary><table class="evidence"><thead><tr><th>Time</th><th>Type</th><th>Event id</th></tr></thead><tbody>${rows}</tbody></table>${more}</details>
</article>`;
}

export interface HtmlOptions {
    maxFindings?: number;
    maxEvidencePerFinding?: number;
}

export function renderHtml(report: Report, options: HtmlOptions = {}): string {
    const maxFindings = clampNonNegInt(options.maxFindings, DEFAULT_MAX_FINDINGS);
    const maxEvidence = clampNonNegInt(options.maxEvidencePerFinding, DEFAULT_MAX_EVIDENCE);
    const s = report.source;
    const metrics = metricRows(report.metrics, report.gpu)
        .map((r) => `<tr><td>${esc(r.label)}</td><td>${esc(r.value)}</td></tr>`)
        .join("\n");
    const shownFindings = report.findings.slice(0, maxFindings);
    const moreFindings =
        report.findings.length > shownFindings.length
            ? `\n<p class="muted">…and ${report.findings.length - shownFindings.length} more findings (see the JSON export).</p>`
            : "";
    const findings =
        report.findings.length === 0
            ? `<p class="muted">No findings.</p>`
            : `<p>${esc(severityCounts(report.findings))}</p>\n${shownFindings.map((f) => renderFinding(f, maxEvidence)).join("\n")}${moreFindings}`;
    const trackLegend = report.timeline.tracks
        .map((t) => `<li><span class="swatch" style="background:${trackColor(t)}"></span>${esc(t)}</li>`)
        .join("");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Sonder Observatory (${esc(report.format)})">
<title>${esc(report.title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>${esc(report.title)}</h1>
<p class="muted">Session ${boundedList(s.sessionIds, (id) => `<code>${esc(id)}</code>`) || "—"} · ${s.exportedEvents}${
        s.exportedEvents !== s.totalEvents ? ` of ${s.totalEvents}` : ""
    } events · ${secs(s.durationS)} · range: ${esc(s.range)}</p>
<p class="muted">Producers: ${boundedList(s.producers, esc) || "—"}${s.firstWallTime ? ` · ${esc(s.firstWallTime)} → ${esc(s.lastWallTime ?? "")}` : ""}</p>
${s.synthetic ? `<p class="warn">⚠ This session contains synthetic (generated) data.</p>` : ""}
<section><h2>Summary metrics</h2>
<table class="metrics"><tbody>
${metrics}
</tbody></table></section>${renderGpuSection(report.gpu)}
<section><h2>Diagnostics findings (${report.findings.length})</h2>
${findings}
</section>
<section><h2>Topology</h2>
<p class="muted">${report.topology.nodes.length} nodes, ${report.topology.edges.length} edges. Columns: agents by delegation depth, then models, tools, memory.</p>
<div class="figure">${renderTopologySvg(report.topology)}</div>
${renderTopologyLegend(report.topology)}
</section>
<section><h2>Timeline snapshot</h2>
<p class="muted">Event density per track over the exported range (${report.timeline.total} events, ${report.timeline.width} columns).</p>
<div class="figure">${renderTimelineSvg(report.timeline)}</div>
<ul class="legend">${trackLegend}</ul>
</section>
<footer>Generated by Sonder Observatory at ${esc(report.generatedAt)}. Self-contained file: no scripts, no external resources.</footer>
</main>
</body>
</html>
`;
}
