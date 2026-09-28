/**
 * Desktop (Tauri) bridge. Every function is safe to import in a plain browser
 * or the Flutter WebView: isDesktop() is false there, getLaunchInfo() returns
 * null and the recent-recordings helpers return empty results. Commands and
 * payloads are defined by src-tauri/ (see docs/integration/tauri-shell.md and
 * docs/integration/desktop.md).
 *
 * File access model: the native open dialog (tauri-plugin-dialog) runs on the
 * Rust side and turns the user's choice into a read-only *grant*. The webview
 * has no fs-plugin or dialog permission and never sees absolute paths.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ProducerEndpointInput } from "../ingest/live/manager";
import { MAX_RECORDING_BYTES, recordingTooLarge } from "../recording/limits";

export interface RecordingGrant {
    id: string;
    name: string;
    kind: "file" | "folder";
}

export interface LaunchInfo {
    /** First validated `--connect` URL (ws, wss, http or https). */
    connect: string | null;
    /**
     * Every validated `--connect` URL, in argument order (connect is the
     * first). Always sent by this shell; optional so launch info from older
     * shells still type-checks (see launchProducers).
     */
    connectAll?: string[];
    /**
     * Bearer token per connectAll entry (same length) or null. A token is
     * bound to the `--connect` it followed; never sent to ws(s) URLs. Keep in
     * memory only and never log it. Always sent by this shell.
     */
    connectTokens?: (string | null)[];
    session: string | null;
    /**
     * Legacy token not bound to a URL (from a token file, or the argv
     * `--capability`); keep it in memory and never log it. The shell already
     * applied a file-sourced one to connectTokens where it fits; an argv one
     * is never used as a bearer token.
     */
    capability: string | null;
    open: RecordingGrant | null;
    /** Show these in the UI. */
    warnings: string[];
}

export interface RecordingEntry {
    path: string;
    size: number;
}

/** A recently opened recording, as reported by the shell (no absolute path). */
export interface RecentRecording {
    /** Opaque id; pass to openRecentRecording(). */
    id: string;
    name: string;
    kind: "file" | "folder";
    /** False when the file or folder no longer exists. */
    available: boolean;
}

/**
 * An opened recording plus a label for the UI: `text` when it fits in one
 * native read (16 MiB), else a byte `stream` that reads the rest on demand
 * (for loadRecordingStream), so a large recording is never decoded into one
 * string. Exactly one of the two is set.
 */
export interface OpenedRecording {
    text?: string;
    stream?: ReadableStream<Uint8Array>;
    label: string;
}

const CHUNK_BYTES = 16 * 1024 * 1024;

/** Entries tried, in order, when a session folder is opened. */
export const FOLDER_EVENT_ENTRIES = ["events.sobs", "events.ndjson", "events.jsonl", "recording.sobs"] as const;

export function isDesktop(): boolean {
    return isTauri();
}

export async function getLaunchInfo(): Promise<LaunchInfo | null> {
    return isTauri() ? invoke<LaunchInfo>("get_launch_args") : null;
}

/**
 * The producers to connect at launch, for LiveConnectionManager.add(): every
 * `--connect` URL with its own bearer token, if any. Older shells that only
 * report `connect` yield that single URL without a token.
 */
export function launchProducers(info: Pick<LaunchInfo, "connect" | "connectAll" | "connectTokens">): ProducerEndpointInput[] {
    const urls = Array.isArray(info.connectAll) ? info.connectAll : info.connect ? [info.connect] : [];
    const tokens = Array.isArray(info.connectTokens) ? info.connectTokens : [];
    return urls.map((url, i) => {
        const token = tokens[i];
        return typeof token === "string" && token !== "" ? { url, token } : { url };
    });
}

export async function pickRecording(folder = false): Promise<RecordingGrant | null> {
    return invoke<RecordingGrant | null>("pick_recording", { folder });
}

export async function listRecordingEntries(grant: string): Promise<RecordingEntry[]> {
    return invoke<RecordingEntry[]>("list_recording_entries", { grant });
}

async function readChunk(grant: string, entry: string | undefined, offset: number): Promise<Uint8Array> {
    return new Uint8Array(await invoke<ArrayBuffer>("read_recording_entry", { grant, entry, offset, maxBytes: CHUNK_BYTES }));
}

/**
 * Reads a whole entry in 16 MiB chunks, up to `maxBytes` in total (default
 * MAX_RECORDING_BYTES; past it the read stops with an error). `entry` is
 * omitted for file grants.
 */
export async function readRecordingEntry(grant: string, entry?: string, maxBytes = MAX_RECORDING_BYTES): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (let offset = 0; ; offset += CHUNK_BYTES) {
        const buf = await readChunk(grant, entry, offset);
        total += buf.byteLength;
        if (total > maxBytes) {
            throw recordingTooLarge(maxBytes);
        }
        parts.push(buf);
        if (buf.byteLength < CHUNK_BYTES) {
            break;
        }
    }
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.byteLength;
    }
    return out;
}

export async function listRecentRecordings(): Promise<RecentRecording[]> {
    return isTauri() ? invoke<RecentRecording[]>("list_recent_recordings") : [];
}

export async function openRecentRecording(id: string): Promise<RecordingGrant> {
    return invoke<RecordingGrant>("open_recent_recording", { id });
}

export async function clearRecentRecordings(): Promise<void> {
    if (isTauri()) {
        await invoke<null>("clear_recent_recordings");
    }
}

/**
 * Read a granted recording as text. File grants are read directly; for a
 * session folder the first entry in FOLDER_EVENT_ENTRIES that exists is used.
 */
export async function readGrantText(grant: RecordingGrant): Promise<OpenedRecording> {
    if (grant.kind === "file") {
        return openEntry(grant.id, undefined, grant.name);
    }
    const entries = new Set((await listRecordingEntries(grant.id)).map((e) => e.path));
    const entry = FOLDER_EVENT_ENTRIES.find((name) => entries.has(name));
    if (!entry) {
        throw new Error(`${grant.name}: no ${FOLDER_EVENT_ENTRIES.join(" / ")} in this folder`);
    }
    return openEntry(grant.id, entry, `${grant.name} (${entry})`);
}

/**
 * Reads the first chunk of an entry: an entry that fits in it is returned as
 * text, a larger one as a stream that pulls the remaining chunks lazily and
 * stops past MAX_RECORDING_BYTES.
 */
async function openEntry(grant: string, entry: string | undefined, label: string): Promise<OpenedRecording> {
    const first = await readChunk(grant, entry, 0);
    if (first.byteLength < CHUNK_BYTES) {
        return { text: new TextDecoder("utf-8").decode(first), label };
    }
    let offset = 0;
    let pending: Uint8Array | null = first;
    let finished = false;
    const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
            const buf = pending ?? (finished ? new Uint8Array(0) : await readChunk(grant, entry, offset));
            pending = null;
            offset += buf.byteLength;
            if (offset > MAX_RECORDING_BYTES) {
                controller.error(recordingTooLarge(MAX_RECORDING_BYTES));
                return;
            }
            if (buf.byteLength > 0) {
                controller.enqueue(buf);
            }
            if (buf.byteLength < CHUNK_BYTES) {
                finished = true;
                controller.close();
            }
        },
    });
    return { stream, label };
}

/**
 * Show the native open dialog and read the chosen recording. Returns null if
 * the user cancelled or when not running in the desktop shell (callers then
 * fall back to the browser `<input type="file">`).
 */
export async function openRecordingNative(folder = false): Promise<OpenedRecording | null> {
    if (!isTauri()) {
        return null;
    }
    const grant = await pickRecording(folder);
    return grant ? readGrantText(grant) : null;
}

/** Re-open a recording from the recent list. */
export async function openRecentRecordingText(id: string): Promise<OpenedRecording> {
    return readGrantText(await openRecentRecording(id));
}

/** File-type filter shown in the native save dialog. */
export interface SaveFilter {
    name: string;
    /** Extensions without the dot, e.g. ["html"]. */
    extensions: string[];
}

/** Result of a native save: the chosen file name only (never the absolute path). */
export interface SavedFile {
    name: string;
}

/**
 * Shows the native save dialog (Rust side) and writes `content` as UTF-8 to
 * the file the user chose. Resolves null when the user cancels. The webview
 * cannot name a path: the shell only writes to the dialog's result.
 */
export async function saveTextNative(suggestedName: string, content: string, filter: SaveFilter): Promise<SavedFile | null> {
    return invoke<SavedFile | null>("save_export", {
        suggestedName,
        content,
        filterName: filter.name,
        extensions: filter.extensions,
    });
}
