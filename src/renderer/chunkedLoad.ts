/**
 * Chunked, cooperative recording loader for large files.
 *
 * `loadRecordingChunked` produces exactly the same result as
 * `loadRecording` (src/recording/sobs.ts), including rejected-line numbers
 * and manifest handling, but parses the text in slices and yields to the
 * event loop between them so the UI keeps painting (and can show progress or
 * cancel). Slice size adapts toward `sliceBudgetMs` of work per slice.
 *
 * It reuses the existing ingest code (`parseNdjson`, `loadRecording`) per
 * slice instead of changing it. Moving parsing into a Worker is a possible
 * follow-up; see docs/integration/perf.md.
 */
import { parseNdjson, type RejectedLine } from "../recording/ndjson";
import { loadRecording, RECORDING_FORMAT, type LoadedRecording, type RecordingManifest } from "../recording/sobs";
import type { ObservatoryEvent } from "../protocol/events";

export interface LoadProgress {
    bytesDone: number;
    totalBytes: number;
    events: number;
    rejected: number;
}

export interface ChunkedLoadOptions {
    /** Target main-thread work per slice (ms). Default 8. */
    sliceBudgetMs?: number;
    /** Initial slice size in UTF-16 code units. Default 256 KiB. */
    initialChunkChars?: number;
    /** Fixed slice size (disables adaptation); mainly for tests. */
    chunkChars?: number;
    onProgress?: (progress: LoadProgress) => void;
    signal?: AbortSignal;
    /** How to give the event loop a turn between slices. */
    yieldToEventLoop?: () => Promise<void>;
    /** Clock (ms); injectable for tests. */
    now?: () => number;
}

/** Below this size the plain synchronous loader is used. */
export const CHUNKED_LOAD_THRESHOLD_CHARS = 2 * 1024 * 1024;

const MIN_CHUNK = 16 * 1024;
const MAX_CHUNK = 16 * 1024 * 1024;

/**
 * Yields a macrotask. MessageChannel avoids the ~4 ms clamp browsers apply to
 * nested setTimeout(0); `scheduler.yield()` is used where available.
 */
export function yieldToEventLoop(): Promise<void> {
    const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (sched && typeof sched.yield === "function") {
        return sched.yield();
    }
    if (typeof MessageChannel !== "undefined") {
        return new Promise((resolve) => {
            const ch = new MessageChannel();
            ch.port1.onmessage = () => {
                ch.port1.close();
                resolve();
            };
            ch.port2.postMessage(null);
        });
    }
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function isManifestRecord(value: Record<string, unknown>): boolean {
    return value.format === RECORDING_FORMAT;
}

function abortError(): Error {
    const error = new Error("recording load aborted");
    error.name = "AbortError";
    return error;
}

/** Accumulates parse results across slices that each end on a line boundary. */
class SliceParser {
    readonly events: ObservatoryEvent[] = [];
    private readonly rejected: RejectedLine[] = [];
    private readonly records: { line: number; value: Record<string, unknown> }[] = [];
    private lineOffset = 0;

    /** `slice` must contain whole lines (it may omit the final newline only at end of input). */
    push(slice: string): void {
        const parsed = parseNdjson(slice, { isRecord: isManifestRecord });
        for (const e of parsed.events) {
            this.events.push(e);
        }
        for (const r of parsed.rejected) {
            this.rejected.push(this.lineOffset === 0 ? r : { ...r, line: r.line + this.lineOffset });
        }
        for (const r of parsed.records) {
            this.records.push({ line: r.line + this.lineOffset, value: r.value });
        }
        let newlines = 0;
        for (let i = slice.indexOf("\n"); i >= 0; i = slice.indexOf("\n", i + 1)) {
            newlines += 1;
        }
        this.lineOffset += newlines;
    }

    get rejectedCount(): number {
        return this.rejected.length;
    }

    /** Same manifest rules as loadRecording: one manifest, only on line 1. */
    finish(): LoadedRecording {
        let manifest: RecordingManifest | null = null;
        const late: RejectedLine[] = [];
        for (const record of this.records) {
            if (record.line !== 1 || manifest !== null) {
                late.push({ line: record.line, reason: "manifest record is only allowed on line 1", raw: JSON.stringify(record.value) });
                continue;
            }
            manifest = record.value as unknown as RecordingManifest;
        }
        return { manifest, events: this.events, rejected: [...this.rejected, ...late] };
    }
}

/** Parses `text` in adaptive time slices, yielding between them. */
async function parseSlices(
    text: string,
    parser: SliceParser,
    options: ChunkedLoadOptions,
    state: { chunk: number },
    progress: (done: number) => void,
): Promise<void> {
    const now = options.now ?? (() => performance.now());
    const pause = options.yieldToEventLoop ?? yieldToEventLoop;
    const budget = Math.max(1, options.sliceBudgetMs ?? 8);
    const total = text.length;
    let pos = 0;
    while (pos < total) {
        if (options.signal?.aborted) {
            throw abortError();
        }
        const started = now();
        let end = Math.min(total, pos + Math.max(1, state.chunk));
        if (end < total) {
            const nl = text.indexOf("\n", end - 1);
            end = nl < 0 ? total : nl + 1;
        }
        parser.push(text.slice(pos, end));
        const sliceLen = end - pos;
        pos = end;
        progress(pos);
        if (options.chunkChars === undefined) {
            const elapsed = Math.max(0.1, now() - started);
            const factor = Math.min(2, Math.max(0.5, budget / elapsed));
            state.chunk = Math.min(MAX_CHUNK, Math.max(MIN_CHUNK, Math.round(sliceLen * factor)));
        }
        if (pos < total) {
            await pause();
        }
    }
}

export async function loadRecordingChunked(text: string, options: ChunkedLoadOptions = {}): Promise<LoadedRecording> {
    if (text.startsWith("PK")) {
        return loadRecording(text);
    }
    const parser = new SliceParser();
    const state = { chunk: options.chunkChars ?? options.initialChunkChars ?? 256 * 1024 };
    await parseSlices(text, parser, options, state, (done) =>
        options.onProgress?.({ bytesDone: done, totalBytes: text.length, events: parser.events.length, rejected: parser.rejectedCount }),
    );
    return parser.finish();
}

/**
 * Streams a recording from bytes (for example `File.stream()`), so files
 * larger than the engine's maximum string length (about 512 MiB of text in
 * V8, roughly 1M events of this protocol) can still be opened. Results match
 * `loadRecording` on the decoded text. `totalBytes` enables percentages.
 */
export async function loadRecordingStream(
    stream: ReadableStream<Uint8Array>,
    options: ChunkedLoadOptions & { totalBytes?: number } = {},
): Promise<LoadedRecording> {
    const pause = options.yieldToEventLoop ?? yieldToEventLoop;
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8");
    const parser = new SliceParser();
    const state = { chunk: options.chunkChars ?? options.initialChunkChars ?? 256 * 1024 };
    const totalBytes = options.totalBytes ?? 0;
    let bytesRead = 0;
    let carry = "";
    let first = true;
    try {
        for (;;) {
            if (options.signal?.aborted) {
                throw abortError();
            }
            const { done, value } = await reader.read();
            let text = done ? carry + decoder.decode() : carry + decoder.decode(value, { stream: true });
            if (!done) {
                bytesRead += value.byteLength;
            }
            if (first && text.length >= 2) {
                first = false;
                if (text.startsWith("PK")) {
                    await reader.cancel();
                    return loadRecording("PK");
                }
            }
            if (!done) {
                const cut = text.lastIndexOf("\n");
                carry = cut < 0 ? text : text.slice(cut + 1);
                text = cut < 0 ? "" : text.slice(0, cut + 1);
            } else {
                carry = "";
            }
            if (text.length > 0) {
                await parseSlices(text, parser, options, state, () =>
                    options.onProgress?.({ bytesDone: bytesRead, totalBytes, events: parser.events.length, rejected: parser.rejectedCount }),
                );
            }
            if (done) {
                break;
            }
            // Stream reads can resolve as microtasks; give the UI a turn.
            await pause();
        }
    } finally {
        reader.releaseLock();
    }
    return parser.finish();
}
