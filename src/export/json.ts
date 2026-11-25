/** JSON export of findings and metrics (machine-readable, stable key order). */
import type { Report, ReportGpuSummary } from "./report";

export interface JsonExport {
    format: Report["format"];
    title: string;
    generated_at: string;
    source: Report["source"];
    metrics: Report["metrics"];
    findings: Report["findings"];
    /** Present when exported events include GPU/UMA device or backend GPU telemetry (Wave 2+). */
    gpu?: ReportGpuSummary;
}

export function toJsonExportObject(report: Report): JsonExport {
    return {
        format: report.format,
        title: report.title,
        generated_at: report.generatedAt,
        source: report.source,
        metrics: report.metrics,
        findings: report.findings,
        ...(report.gpu ? { gpu: report.gpu } : {}),
    };
}

export function renderJson(report: Report): string {
    return `${JSON.stringify(toJsonExportObject(report), null, 2)}\n`;
}
