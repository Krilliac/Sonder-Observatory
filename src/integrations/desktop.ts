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

export interface RecordingGrant {
    id: string;
    name: string;
    kind: "file" | "folder";
}

export interface LaunchInfo {
    /** Validated ws(s) URL. */
    connect: string | null;
    session: string | null;
    /** Short-lived token; keep it in memory and never log it. */
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

/** Recording text ready for loadRecording(), plus a label for the UI. */
export interface OpenedRecording {
    text: string;
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

export async function pickRecording(folder = false): Promise<RecordingGrant | null> {
    return invoke<RecordingGrant | null>("pick_recording", { folder });
}

export async function listRecordingEntries(grant: string): Promise<RecordingEntry[]> {
    return invoke<RecordingEntry[]>("list_recording_entries", { grant });
}

/** Reads a whole entry in 16 MiB chunks. `entry` is omitted for file grants. */
export async function readRecordingEntry(grant: string, entry?: string): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for (let offset = 0; ; offset += CHUNK_BYTES) {
        const buf = new Uint8Array(await invoke<ArrayBuffer>("read_recording_entry", { grant, entry, offset, maxBytes: CHUNK_BYTES }));
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
    const decoder = new TextDecoder("utf-8");
    if (grant.kind === "file") {
        return { text: decoder.decode(await readRecordingEntry(grant.id)), label: grant.name };
    }
    const entries = new Set((await listRecordingEntries(grant.id)).map((e) => e.path));
    const entry = FOLDER_EVENT_ENTRIES.find((name) => entries.has(name));
    if (!entry) {
        throw new Error(`${grant.name}: no ${FOLDER_EVENT_ENTRIES.join(" / ")} in this folder`);
    }
    return { text: decoder.decode(await readRecordingEntry(grant.id, entry)), label: `${grant.name} (${entry})` };
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
