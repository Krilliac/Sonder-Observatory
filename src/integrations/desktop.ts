/**
 * Desktop (Tauri) bridge. Every function is safe to call in a plain browser or
 * the Flutter WebView: getLaunchInfo() returns null there. Commands and
 * payloads are defined by src-tauri/ (see docs/integration/tauri-shell.md).
 *
 * Not wired into the renderer yet; see docs/DECISIONS.md.
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

const CHUNK_BYTES = 16 * 1024 * 1024;

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
