/**
 * Recording/fixture loading orchestration: sync vs chunked/streamed parse,
 * superseding load tokens + AbortController, progress bar (#load-status),
 * cancel handling, and drag-and-drop mounting.
 */
import { loadRecording } from "../recording/sobs";
import { CHUNKED_LOAD_THRESHOLD_CHARS, loadRecordingChunked, loadRecordingStream, type ChunkedLoadOptions } from "./chunkedLoad";
import { byId } from "./dom";
import { mountDropZone } from "./dropZone";

export type LoadedRecording = ReturnType<typeof loadRecording>;

export interface RecordingLoaderHooks {
    afterLiveStopped(load: () => void): void;
    onLoaded(loaded: LoadedRecording, source: "fixture" | "file", label: string): void;
    onNotice(message: string): void;
    onRender(): void;
}

export class RecordingLoader {
    private readonly hooks: RecordingLoaderHooks;
    /** Bumped per load so a superseded chunked load is discarded. */
    private loadToken = 0;
    /** Aborts the running chunked/streamed parse when a newer load or connect wins. */
    private loadAbort: AbortController | null = null;
    private loadingLabel: string | null = null;

    constructor(hooks: RecordingLoaderHooks) {
        this.hooks = hooks;
    }

    get loading(): string | null {
        return this.loadingLabel;
    }

    mountDropTarget(win: Window, doc: Document): void {
        mountDropZone(win, doc, {
            onFile: (file) => this.openFile(file),
            onReject: (message) => this.hooks.onNotice(message),
        });
    }

    openFile(file: File): void {
        this.hooks.afterLiveStopped(() => {
            if (file.size >= CHUNKED_LOAD_THRESHOLD_CHARS) {
                // Stream large files: no giant string, UI stays responsive.
                this.loadChunked((opts) => loadRecordingStream(file.stream(), { ...opts, totalBytes: file.size }), "file", file.name);
                return;
            }
            const token = this.supersede();
            void file.text().then(
                (text) => {
                    if (token === this.loadToken) {
                        this.loadText(text, "file", file.name);
                    }
                },
                (error: unknown) => {
                    this.hooks.onNotice(`could not read ${file.name}: ${(error as Error)?.message ?? String(error)}`);
                },
            );
        });
    }

    openTextAfterLive(text: string, source: "fixture" | "file", label: string): void {
        this.hooks.afterLiveStopped(() => this.loadText(text, source, label));
    }

    openStreamAfterLive(stream: ReadableStream<Uint8Array>, label: string): void {
        this.hooks.afterLiveStopped(() => this.loadChunked((opts) => loadRecordingStream(stream, opts), "file", label));
    }

    loadText(text: string, source: "fixture" | "file", label: string): void {
        if (text.length < CHUNKED_LOAD_THRESHOLD_CHARS) {
            this.supersede();
            this.hooks.onLoaded(loadRecording(text), source, label);
            return;
        }
        this.loadChunked((opts) => loadRecordingChunked(text, opts), source, label);
    }

    /** Invalidates the running load (discard its result, abort its parse) and returns the new token. */
    supersede(): number {
        this.loadAbort?.abort();
        this.loadAbort = null;
        this.setLoading(null);
        return ++this.loadToken;
    }

    cancel(): void {
        const label = this.loadingLabel;
        this.supersede();
        if (label) {
            this.hooks.onNotice(`Loading ${label} was cancelled; the previous source is still shown.`);
            return;
        }
        this.hooks.onRender();
    }

    private setLoading(label: string | null, progress?: { pct: number | null; events: number }): void {
        this.loadingLabel = label;
        const box = document.getElementById("load-status");
        if (!box) {
            return;
        }
        box.hidden = label === null;
        if (label === null) {
            return;
        }
        const bar = byId("load-progress");
        const pct = progress?.pct ?? null;
        byId("load-label").textContent = `Loading ${label}${progress ? ` · ${progress.events} events` : ""}`;
        if (pct === null) {
            bar.removeAttribute("aria-valuenow");
            bar.setAttribute("aria-valuetext", progress ? `${progress.events} events read` : "starting");
            bar.classList.add("indeterminate");
        } else {
            bar.setAttribute("aria-valuenow", String(pct));
            bar.setAttribute("aria-valuetext", `${pct}%, ${progress?.events ?? 0} events`);
            bar.classList.remove("indeterminate");
        }
        (bar.firstElementChild as HTMLElement).style.width = pct === null ? "" : `${pct}%`;
    }

    /** Large recordings parse in slices so the UI keeps painting; a newer load or connect wins. */
    private loadChunked(run: (options: ChunkedLoadOptions) => Promise<LoadedRecording>, source: "fixture" | "file", label: string): void {
        const token = this.supersede();
        const abort = new AbortController();
        this.loadAbort = abort;
        this.setLoading(label);
        run({
            signal: abort.signal,
            onProgress: (p) => {
                if (token === this.loadToken) {
                    this.setLoading(label, { pct: p.totalBytes > 0 ? Math.round((p.bytesDone / p.totalBytes) * 100) : null, events: p.events });
                }
            },
        }).then(
            (loaded) => {
                if (token === this.loadToken) {
                    this.loadAbort = null;
                    this.setLoading(null);
                    this.hooks.onLoaded(loaded, source, label);
                }
            },
            (error: unknown) => {
                if (token === this.loadToken) {
                    this.loadAbort = null;
                    this.setLoading(null);
                    this.hooks.onNotice(`failed to load ${label}: ${(error as Error)?.message ?? String(error)}`);
                }
            },
        );
    }
}
