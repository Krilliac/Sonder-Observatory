/**
 * Saving exports. Desktop (Tauri): native save dialog via the `save_export`
 * shell command (src/integrations/desktop.ts). Browser / Flutter WebView: a
 * Blob download through a temporary <a download>.
 */
import { isDesktop, saveTextNative } from "../integrations/desktop";
import { RECORDING_EXTENSION } from "../recording/sobs";

export const EXPORT_FORMATS = {
    html: { label: "HTML report", extension: "html", mime: "text/html;charset=utf-8" },
    markdown: { label: "Markdown summary", extension: "md", mime: "text/markdown;charset=utf-8" },
    json: { label: "Findings & metrics (JSON)", extension: "json", mime: "application/json" },
    sobs: { label: "Observatory recording (.sobs)", extension: RECORDING_EXTENSION.slice(1), mime: "application/x-ndjson" },
} as const;

export type ExportFormat = keyof typeof EXPORT_FORMATS;

export const EXPORT_FORMAT_IDS = Object.keys(EXPORT_FORMATS) as ExportFormat[];

export interface SaveResult {
    name: string;
    via: "desktop" | "download";
}

/** DOM surface used for browser downloads (injectable for tests). */
export interface DownloadHost {
    createObjectURL(blob: Blob): string;
    revokeObjectURL(url: string): void;
    /** Clicks a temporary `<a href download>`. */
    clickDownload(href: string, fileName: string): void;
    setTimeout(fn: () => void, ms: number): unknown;
}

export function browserDownloadHost(): DownloadHost {
    return {
        createObjectURL: (blob) => URL.createObjectURL(blob),
        revokeObjectURL: (url) => URL.revokeObjectURL(url),
        clickDownload: (href, fileName) => {
            const a = document.createElement("a");
            a.href = href;
            a.download = fileName;
            a.rel = "noopener";
            a.style.display = "none";
            document.body.append(a);
            a.click();
            a.remove();
        },
        setTimeout: (fn, ms) => setTimeout(fn, ms),
    };
}

/** Filesystem-safe name: `observatory-<session>-<stamp>.<ext>`. */
export function suggestedFileName(format: ExportFormat, sessionId: string | undefined, at: Date = new Date()): string {
    const session = (sessionId ?? "session").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64) || "session";
    const stamp = at.toISOString().replace(/\.\d+Z$/, "Z").replace(/[:]/g, "-");
    const suffix = format === "markdown" ? "-summary" : format === "json" ? "-findings" : format === "html" ? "-report" : "";
    return `observatory-${session}-${stamp}${suffix}.${EXPORT_FORMATS[format].extension}`;
}

export function downloadText(fileName: string, content: string, format: ExportFormat, host: DownloadHost = browserDownloadHost()): SaveResult {
    const url = host.createObjectURL(new Blob([content], { type: EXPORT_FORMATS[format].mime }));
    host.clickDownload(url, fileName);
    host.setTimeout(() => host.revokeObjectURL(url), 1000);
    return { name: fileName, via: "download" };
}

export interface SaveOptions {
    /** Override environment detection (tests). */
    desktop?: boolean;
    host?: DownloadHost;
}

/** Saves text through the native dialog on desktop, or as a download. Null when the user cancels. */
export async function saveText(fileName: string, content: string, format: ExportFormat, options: SaveOptions = {}): Promise<SaveResult | null> {
    if (options.desktop ?? isDesktop()) {
        const spec = EXPORT_FORMATS[format];
        const saved = await saveTextNative(fileName, content, { name: spec.label, extensions: [spec.extension] });
        return saved ? { name: saved.name, via: "desktop" } : null;
    }
    return downloadText(fileName, content, format, options.host);
}
