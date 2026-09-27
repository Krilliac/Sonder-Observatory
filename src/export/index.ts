/**
 * Export & reports. Entry point for the renderer's "Export" menu (see
 * docs/integration/export.md):
 *
 *   await exportWithConfirmation("html", { events: store.events, range }, confirmSensitiveExport);
 *
 * All renderers are pure (string in, string out) and deterministic when
 * `generatedAt` is fixed; only saveText() touches the environment, and it is
 * reached only through exportSession(), which refuses sensitive exports
 * (full text capture / tool payloads) without an explicit acknowledgement.
 */
import { renderHtml } from "./html";
import { renderJson } from "./json";
import { renderMarkdown } from "./markdown";
import { buildReport, type ReportInput } from "./report";
import { saveText, suggestedFileName, type ExportFormat, type SaveOptions, type SaveResult } from "./save";
import { assessExportSensitivity, SensitiveExportError, type ExportSensitivity } from "./sensitivity";
import { renderSobs } from "./sobs";

export * from "./filter";
export * from "./report";
// saveText / downloadText are deliberately not re-exported: every write goes
// through exportSession(), which enforces the sensitive-data acknowledgement.
export { browserDownloadHost, EXPORT_FORMAT_IDS, EXPORT_FORMATS, suggestedFileName, type DownloadHost, type ExportFormat, type SaveOptions, type SaveResult } from "./save";
export * from "./sensitivity";
export { confirmSensitiveExport } from "./confirmDialog";
export { renderHtml, REPORT_CSP } from "./html";
export { renderJson, toJsonExportObject, type JsonExport } from "./json";
export { renderMarkdown, mdEscape, type MarkdownOptions } from "./markdown";
export { renderSobs, type SobsExportOptions } from "./sobs";
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

export interface ExportOptions extends SaveOptions {
    /**
     * Set only after the user accepted the sensitive-data warning
     * (sensitiveExportWarning / confirmSensitiveExport). Without it a session
     * with full text capture or unredacted tool payloads is not written.
     */
    acknowledgeSensitive?: boolean;
}

/**
 * Renders and saves (native dialog on desktop, download in a browser). Null if
 * cancelled or nothing to export. Throws SensitiveExportError, before
 * rendering or writing anything, for a sensitive export that was not acknowledged.
 */
export async function exportSession(format: ExportFormat, input: ReportInput, options: ExportOptions = {}): Promise<SaveResult | null> {
    if (input.events.length === 0) {
        return null;
    }
    const assessment = assessExportSensitivity(input.events, input.range);
    if (assessment.sensitive && options.acknowledgeSensitive !== true) {
        throw new SensitiveExportError(assessment);
    }
    const out = renderExport(format, input);
    return saveText(out.fileName, out.content, format, options);
}

/**
 * exportSession() with the warning step: when the export is sensitive,
 * `confirm` is awaited (e.g. confirmSensitiveExport) and nothing is written
 * unless it resolves true. Returns null when declined, cancelled or empty.
 */
export async function exportWithConfirmation(
    format: ExportFormat,
    input: ReportInput,
    confirm: (assessment: ExportSensitivity) => Promise<boolean>,
    options: SaveOptions = {},
): Promise<SaveResult | null> {
    if (input.events.length === 0) {
        return null;
    }
    const assessment = assessExportSensitivity(input.events, input.range);
    if (assessment.sensitive && !(await confirm(assessment))) {
        return null;
    }
    return exportSession(format, input, { ...options, acknowledgeSensitive: assessment.sensitive });
}
