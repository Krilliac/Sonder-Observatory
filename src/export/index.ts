/**
 * Export & reports. Entry point for the renderer's "Export" menu (see
 * docs/integration/export.md):
 *
 *   await exportSession("html", { events: store.events, range }, {});
 *
 * All renderers are pure (string in, string out) and deterministic when
 * `generatedAt` is fixed; only saveText() touches the environment.
 */
import { renderHtml } from "./html";
import { renderJson } from "./json";
import { renderMarkdown } from "./markdown";
import { buildReport, type ReportInput } from "./report";
import { saveText, suggestedFileName, type ExportFormat, type SaveOptions, type SaveResult } from "./save";
import { renderSobs } from "./sobs";

export * from "./filter";
export * from "./report";
export * from "./save";
export { renderHtml, REPORT_CSP } from "./html";
export { renderJson, toJsonExportObject, type JsonExport } from "./json";
export { renderMarkdown, mdEscape, type MarkdownOptions } from "./markdown";
export { renderSobs } from "./sobs";
export { renderTimelineSvg, renderTopologySvg, resolveColor } from "./svg";
export { metricRows } from "./summary";

export interface RenderedExport {
    format: ExportFormat;
    fileName: string;
    content: string;
}

/** Renders one export format for the given events / range. */
export function renderExport(format: ExportFormat, input: ReportInput): RenderedExport {
    const at = input.generatedAt ?? new Date();
    const withStamp = { ...input, generatedAt: at };
    const sessionId = input.events[0]?.session_id;
    const fileName = suggestedFileName(format, sessionId, at);
    if (format === "sobs") {
        return { format, fileName, content: renderSobs(input.events, input.range, at) };
    }
    const report = buildReport(withStamp);
    const content = format === "html" ? renderHtml(report) : format === "markdown" ? renderMarkdown(report) : renderJson(report);
    return { format, fileName, content };
}

/** Renders and saves (native dialog on desktop, download in a browser). Null if cancelled or nothing to export. */
export async function exportSession(format: ExportFormat, input: ReportInput, options: SaveOptions = {}): Promise<SaveResult | null> {
    if (input.events.length === 0) {
        return null;
    }
    const out = renderExport(format, input);
    return saveText(out.fileName, out.content, format, options);
}
