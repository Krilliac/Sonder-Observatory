import type { ObservatoryEvent } from "../protocol/events";
import type { RejectedLine } from "../recording/ndjson";
import { isSyntheticProducer, type RecordingManifest } from "../recording/sobs";
import { orderEvents, type SequenceGap } from "./order";

export type SourceKind = "none" | "fixture" | "file" | "live";

/**
 * Holds the events of the currently viewed session (from a fixture, a
 * recording file or a live connection) in replay order.
 */
export class SessionStore {
    source: SourceKind = "none";
    sourceLabel = "";
    manifest: RecordingManifest | null = null;
    rejected: RejectedLine[] = [];
    private raw: ObservatoryEvent[] = [];
    events: ObservatoryEvent[] = [];
    duplicates = 0;
    gaps: SequenceGap[] = [];

    reset(source: SourceKind, label: string, manifest: RecordingManifest | null = null): void {
        this.source = source;
        this.sourceLabel = label;
        this.manifest = manifest;
        this.rejected = [];
        this.raw = [];
        this.events = [];
        this.duplicates = 0;
        this.gaps = [];
    }

    append(events: readonly ObservatoryEvent[]): void {
        this.raw.push(...events);
        const ordered = orderEvents(this.raw);
        this.events = ordered.events;
        this.duplicates = ordered.duplicates;
        this.gaps = ordered.gaps;
    }

    addRejected(lines: readonly RejectedLine[]): void {
        this.rejected.push(...lines);
    }

    get synthetic(): boolean {
        return this.manifest?.synthetic === true || this.events.some((e) => isSyntheticProducer(e.producer));
    }

    /**
     * Text capture policy declared at session start, if any
     * (`session.started` or Sonder-Inference's `session.created`).
     */
    get capturePolicy(): string {
        const policies = new Set<string>();
        for (const e of this.events) {
            if (
                (e.event_type === "session.started" || e.event_type === "session.created") &&
                typeof e.attributes.text_capture === "string"
            ) {
                policies.add(e.attributes.text_capture);
            }
        }
        return policies.size > 0 ? [...policies].join(",") : "unspecified";
    }
}
