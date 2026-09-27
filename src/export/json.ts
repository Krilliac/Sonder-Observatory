/** JSON export of findings and metrics (machine-readable, stable key order). */
import type { Report } from "./report";

export interface JsonExport {
    format: Report["format"];
    title: string;
    generated_at: string;
    source: Report["source"];
    metrics: Report["metrics"];
    findings: Report["findings"];
}

export function toJsonExportObject(report: Report): JsonExport {
    return {
        format: report.format,
        title: report.title,
        generated_at: report.generatedAt,
        source: report.source,
        metrics: report.metrics,
        findings: report.findings,
    };
}

export function renderJson(report: Report): string {
    return `${JSON.stringify(toJsonExportObject(report), null, 2)}\n`;
}
