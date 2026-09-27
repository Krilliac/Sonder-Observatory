/**
 * Markdown summary for pasting into a PR or issue. Plain GitHub-flavoured
 * markdown (tables, <details>), kept within GitHub's 65 536-character comment
 * limit: findings and evidence lists are capped, every producer-controlled
 * string is clipped, and a final character budget truncates with a marker.
 */
import type { Report } from "./report";
import { metricRows, severityCounts } from "./summary";

export interface MarkdownOptions {
    maxFindings?: number;
    maxEvidencePerFinding?: number;
    /** Hard cap on the output length in UTF-16 code units. Default MARKDOWN_CHAR_LIMIT. */
    maxChars?: number;
}

/** GitHub's issue / PR comment limit. */
export const MARKDOWN_CHAR_LIMIT = 65_536;

/** Per-field caps for producer-controlled strings (applied before escaping). */
const CAP = { title: 200, id: 128, name: 128, label: 200, summary: 500, range: 300, list: 20 } as const;

const SEVERITY_LABEL: Record<string, string> = { critical: "🔴 critical", warning: "🟠 warning", info: "🔵 info" };

/** Escapes text for a markdown table cell / inline context. */
export function mdEscape(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[`*[\]<>]/g, (c) => `\\${c}`).replace(/\r?\n/g, " ");
}

/** Shortens `s` to at most `max` code units, marking the cut with "…" (never splits a surrogate pair). */
export function clip(s: string, max: number): string {
    if (s.length <= max) {
        return s;
    }
    let cut = s.slice(0, Math.max(0, max - 1));
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
        cut = cut.slice(0, -1);
    }
    return `${cut}…`;
}

/** At most CAP.list items, then "+N more". */
function list(items: readonly string[], fmt: (s: string) => string): string {
    const shown = items.slice(0, CAP.list).map(fmt);
    if (items.length > CAP.list) {
        shown.push(`+${items.length - CAP.list} more`);
    }
    return shown.join(", ");
}

/**
 * Final budget: cuts at a line boundary so the result, including the marker
 * (and a closing </details> if the cut fell inside one), is at most `maxChars`.
 */
function applyBudget(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
        return text;
    }
    const marker = `\n\n_…truncated: the summary exceeded ${maxChars} characters; see the HTML or JSON export for everything._\n`;
    const closeDetails = "\n\n</details>";
    let cut = text.slice(0, Math.max(0, maxChars - marker.length - closeDetails.length));
    const nl = cut.lastIndexOf("\n");
    if (nl > 0) {
        cut = cut.slice(0, nl);
    }
    const open = cut.split("<details>").length - cut.split("</details>").length;
    return `${cut}${open > 0 ? closeDetails : ""}${marker}`.slice(0, maxChars);
}

function code(s: string): string {
    return `\`${s.replace(/`/g, "'")}\``;
}

function secs(s: number | null): string {
    return s === null ? "—" : `${s.toFixed(3)} s`;
}

export function renderMarkdown(report: Report, options: MarkdownOptions = {}): string {
    const maxFindings = options.maxFindings ?? 50;
    const maxEvidence = options.maxEvidencePerFinding ?? 8;
    const s = report.source;
    const out: string[] = [];
    out.push(`## ${mdEscape(clip(report.title, CAP.title))}`, "");
    out.push(
        `**Session** ${list(s.sessionIds, (id) => code(clip(id, CAP.id))) || "—"} · **events** ${s.exportedEvents}${s.exportedEvents !== s.totalEvents ? ` of ${s.totalEvents}` : ""} · **duration** ${secs(s.durationS)} · **range** ${mdEscape(clip(s.range, CAP.range))}`,
    );
    out.push(`**Producers** ${list(s.producers, (p) => mdEscape(clip(p, CAP.name))) || "—"}${s.synthetic ? " · ⚠️ synthetic data" : ""}`, "");

    out.push("### Summary metrics", "", "| Metric | Value |", "| --- | --- |");
    for (const r of metricRows(report.metrics)) {
        out.push(`| ${mdEscape(clip(r.label, CAP.label))} | ${mdEscape(clip(r.value, CAP.label))} |`);
    }
    out.push("");

    out.push(`### Diagnostics findings (${report.findings.length})`, "");
    if (report.findings.length === 0) {
        out.push("No findings.", "");
    } else {
        out.push(severityCounts(report.findings), "");
        out.push("| Severity | Kind | Time | Summary | Evidence |", "| --- | --- | --- | --- | --- |");
        const shown = report.findings.slice(0, maxFindings);
        for (const f of shown) {
            out.push(
                `| ${SEVERITY_LABEL[f.severity] ?? mdEscape(clip(f.severity, CAP.name))} | ${code(clip(f.kind, CAP.name))} | ${secs(f.startRelS)}–${secs(f.endRelS)} | ${mdEscape(clip(f.summary, CAP.summary))} | ${f.evidence.length} |`,
            );
        }
        if (report.findings.length > shown.length) {
            out.push("", `_…and ${report.findings.length - shown.length} more findings (see the HTML or JSON export)._`);
        }
        out.push("", "<details><summary>Evidence events</summary>", "");
        for (const f of shown) {
            out.push(`- ${code(clip(f.id, CAP.id))} (${mdEscape(clip(f.provenance, CAP.name))})`);
            for (const ev of f.evidence.slice(0, maxEvidence)) {
                out.push(`  - ${secs(ev.relS)} ${code(clip(ev.eventType, CAP.name))} ${code(clip(ev.eventId, CAP.id))}`);
            }
            if (f.evidence.length > maxEvidence) {
                out.push(`  - …${f.evidence.length - maxEvidence} more`);
            }
        }
        out.push("", "</details>", "");
    }

    const t = report.topology;
    out.push(`### Topology`, "", `${t.nodes.length} nodes, ${t.edges.length} edges.`);
    const kinds = new Map<string, number>();
    for (const n of t.nodes) {
        kinds.set(n.kind, (kinds.get(n.kind) ?? 0) + 1);
    }
    if (kinds.size > 0) {
        out.push(`Nodes by kind: ${list([...kinds].map(([k, n]) => `${clip(k, CAP.name)} ${n}`), mdEscape)}.`);
    }
    out.push("", `<sub>Generated by Sonder Observatory at ${report.generatedAt} (${report.format}).</sub>`, "");
    return applyBudget(out.join("\n"), options.maxChars ?? MARKDOWN_CHAR_LIMIT);
}
