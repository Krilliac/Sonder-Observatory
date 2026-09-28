/**
 * Milestone 1 recording container (".sobs").
 *
 * Decision (2026-09-26, see docs/RECORDING_FORMAT.md and docs/DECISIONS.md): a `.sobs` file is
 * UTF-8 NDJSON. Line 1 is a manifest record whose `format` is
 * RECORDING_FORMAT; every following line is one unmodified protocol event.
 * A later ZIP-compatible container can be distinguished by its leading
 * "PK" bytes, so this debuggable form stays loadable.
 *
 * The manifest is Observatory-owned recorder metadata, not part of the
 * producer protocol. Fields that the producer protocol does not yet carry
 * (for example a redaction policy) are recorded as "unspecified" rather than
 * invented.
 */
import type { ObservatoryEvent } from "../protocol/events";
import { totalDroppedEvents } from "../query/attributes";
import { parseNdjson, toNdjson, type RejectedLine } from "./ndjson";

export const RECORDING_FORMAT = "sonder.observatory.recording/1";
export const RECORDING_EXTENSION = ".sobs";

export interface RecordingManifest {
    format: typeof RECORDING_FORMAT;
    created_at: string;
    recorder: { name: string; version: string };
    /** true when the recording contains a session.ended event for every session. */
    complete: boolean;
    event_count: number;
    schema_versions: string[];
    /**
     * One entry per producer name/version/node. `role` is producer.role
     * ("inference" | "runtime" | "fixture") or null when no event declares it;
     * recordings written before roles existed omit the key.
     */
    producers: { name: string; version: string; node_id: string; role: string | null; synthetic: boolean }[];
    session_ids: string[];
    run_ids: string[];
    sampling_levels: string[];
    /** Redaction/capture policy as declared by producers; "unspecified" if absent. */
    capture_policy: string;
    /** Latest cumulative producer-reported drop count per producer instance, summed. */
    dropped_events: number;
    time_origin: { wall_time: string; mono_ns: number } | null;
    synthetic: boolean;
}

export interface LoadedRecording {
    manifest: RecordingManifest | null;
    events: ObservatoryEvent[];
    rejected: RejectedLine[];
}

export function isSyntheticProducer(producer: ObservatoryEvent["producer"]): boolean {
    return producer.synthetic === true;
}

function unique<T>(values: Iterable<T>): T[] {
    return [...new Set(values)];
}

const SESSION_END_EVENTS = new Set(["session.ended", "session.closed", "engine.stopped"]);

export function buildManifest(
    events: readonly ObservatoryEvent[],
    createdAt: Date = new Date(),
): RecordingManifest {
    const producers = new Map<string, RecordingManifest["producers"][number]>();
    for (const e of events) {
        const key = `${e.producer.name}\u0000${e.producer.version}\u0000${e.producer.node_id}`;
        const role = typeof e.producer.role === "string" ? e.producer.role : null;
        const known = producers.get(key);
        if (!known) {
            producers.set(key, {
                name: e.producer.name,
                version: e.producer.version,
                node_id: e.producer.node_id,
                role,
                synthetic: isSyntheticProducer(e.producer),
            });
        } else {
            known.role ??= role;
            known.synthetic ||= isSyntheticProducer(e.producer);
        }
    }
    const sessions = unique(events.map((e) => e.session_id));
    // Terminal events: session.ended (protocol / Runtime), session.closed
    // (Sonder-Inference sessions) and engine.stopped (Inference's engine scope).
    const ended = new Set(events.filter((e) => SESSION_END_EVENTS.has(e.event_type)).map((e) => e.session_id));
    // A "session" holding only producer housekeeping (Inference reports
    // telemetry.dropped under its telemetry instance id) has no end to wait for.
    const substantive = new Set(events.filter((e) => !e.event_type.startsWith("telemetry.")).map((e) => e.session_id));
    const judged = sessions.filter((s) => substantive.has(s));
    const policies = unique(
        events
            .filter((e) => e.event_type === "session.started" || e.event_type === "session.created")
            .map((e) => e.attributes.text_capture)
            .filter((p): p is string => typeof p === "string"),
    );
    const first = events[0];
    return {
        format: RECORDING_FORMAT,
        created_at: createdAt.toISOString(),
        recorder: { name: "sonder-observatory", version: "0.1.0" },
        complete: judged.length > 0 && judged.every((s) => ended.has(s)),
        event_count: events.length,
        schema_versions: unique(events.map((e) => e.schema)),
        producers: [...producers.values()],
        session_ids: sessions,
        run_ids: unique(
            events.map((e) => e.run_id).filter((r): r is string => typeof r === "string"),
        ),
        sampling_levels: unique(
            events
                .map((e) => e.sampling?.level)
                .filter((l): l is NonNullable<typeof l> => typeof l === "string"),
        ),
        capture_policy: policies.length > 0 ? policies.join(",") : "unspecified",
        dropped_events: totalDroppedEvents(events),
        time_origin: first ? { wall_time: first.wall_time, mono_ns: first.mono_ns } : null,
        synthetic: [...producers.values()].some((p) => p.synthetic),
    };
}

export function serializeRecording(
    events: readonly ObservatoryEvent[],
    createdAt: Date = new Date(),
): string {
    return toNdjson([buildManifest(events, createdAt), ...events]);
}

function isManifestRecord(value: Record<string, unknown>): boolean {
    return value.format === RECORDING_FORMAT;
}

/**
 * Loads a `.sobs` recording or a bare NDJSON/JSONL event log (no manifest).
 */
export function loadRecording(text: string): LoadedRecording {
    if (text.startsWith("PK")) {
        return {
            manifest: null,
            events: [],
            rejected: [
                {
                    line: 1,
                    reason: "ZIP-packaged .sobs containers are not supported yet (Milestone 1 reads NDJSON)",
                    raw: "",
                },
            ],
        };
    }
    const parsed = parseNdjson(text, { isRecord: isManifestRecord });
    const rejected = [...parsed.rejected];
    let manifest: RecordingManifest | null = null;
    for (const record of parsed.records) {
        if (record.line !== 1 || manifest !== null) {
            rejected.push({
                line: record.line,
                reason: "manifest record is only allowed on line 1",
                raw: JSON.stringify(record.value),
            });
            continue;
        }
        manifest = record.value as unknown as RecordingManifest;
    }
    return { manifest, events: parsed.events, rejected };
}
