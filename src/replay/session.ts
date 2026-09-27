import type { ObservatoryEvent } from "../protocol/events";
import type { RejectedLine } from "../recording/ndjson";
import { isSyntheticProducer, type RecordingManifest } from "../recording/sobs";
import { compareEvents, streamKey, type SequenceGap } from "./order";

export type SourceKind = "none" | "fixture" | "file" | "live";

/**
 * Most events a live session keeps. A live connection has no end, so the
 * oldest events are dropped past this count; the store counts every one it
 * drops (`droppedByRetention`) and the viewer says so.
 */
export const DEFAULT_MAX_LIVE_EVENTS = 250_000;

/** Rejected lines kept for display in a live session (all are counted). */
export const MAX_LIVE_REJECTED_KEPT = 1000;

export interface SessionStoreOptions {
    /** Retention limit for live sessions. Default DEFAULT_MAX_LIVE_EVENTS. */
    maxLiveEvents?: number;
}

/** Per-stream sequence coverage, maintained incrementally for gap reports. */
interface StreamSequences {
    min: number;
    max: number;
    /** Missing ranges inside [min, max], ascending and disjoint. */
    gaps: { from: number; to: number }[];
}

/** First index in sorted `events` whose event sorts after `e`. */
function upperBound(events: readonly ObservatoryEvent[], e: ObservatoryEvent): number {
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (compareEvents(events[mid]!, e) <= 0) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

/**
 * Holds the events of the currently viewed session (from a fixture, a
 * recording file or a live connection) in replay order.
 *
 * append() is incremental: new events are deduplicated against a persistent
 * id set, sorted among themselves and merged into the ordered history (an
 * in-order batch is a plain append), and sequence gaps are tracked per
 * stream as events arrive. The history is never re-sorted as a whole.
 */
export class SessionStore {
    source: SourceKind = "none";
    sourceLabel = "";
    manifest: RecordingManifest | null = null;
    rejected: RejectedLine[] = [];
    /** Every rejected line, including those not kept in `rejected`. */
    rejectedCount = 0;
    events: ObservatoryEvent[] = [];
    duplicates = 0;
    /**
     * Live events not kept because of the retention limit: the oldest events
     * evicted, plus late arrivals older than what is still retained.
     */
    droppedByRetention = 0;
    readonly maxLiveEvents: number;
    private seen = new Set<string>();
    private streams = new Map<string, StreamSequences>();
    private gapsCache: SequenceGap[] | null = [];
    /** Last event evicted by retention; older arrivals are dropped too. */
    private evictedUpTo: ObservatoryEvent | null = null;

    constructor(options: SessionStoreOptions = {}) {
        this.maxLiveEvents = Math.max(1, Math.floor(options.maxLiveEvents ?? DEFAULT_MAX_LIVE_EVENTS));
    }

    reset(source: SourceKind, label: string, manifest: RecordingManifest | null = null): void {
        this.source = source;
        this.sourceLabel = label;
        this.manifest = manifest;
        this.rejected = [];
        this.rejectedCount = 0;
        this.events = [];
        this.duplicates = 0;
        this.droppedByRetention = 0;
        this.seen = new Set();
        this.streams = new Map();
        this.gapsCache = [];
        this.evictedUpTo = null;
    }

    /** Per-stream sequence gaps (possible dropped telemetry) over all events received. */
    get gaps(): SequenceGap[] {
        if (this.gapsCache === null) {
            const gaps: SequenceGap[] = [];
            for (const [stream, s] of this.streams) {
                for (const g of s.gaps) {
                    gaps.push({ stream, from: g.from, to: g.to });
                }
            }
            this.gapsCache = gaps;
        }
        return this.gapsCache;
    }

    append(events: readonly ObservatoryEvent[]): void {
        const fresh: ObservatoryEvent[] = [];
        // A loop, not push(...events): spreading overflows the call stack for
        // very large recordings (~120k+ items in Chromium).
        for (const e of events) {
            if (this.seen.has(e.event_id)) {
                this.duplicates += 1;
                continue;
            }
            if (this.evictedUpTo !== null && compareEvents(e, this.evictedUpTo) <= 0) {
                // Older than the retained window: keeping it would reopen
                // history that was already dropped from the view.
                this.droppedByRetention += 1;
                continue;
            }
            this.seen.add(e.event_id);
            this.trackSequence(e);
            fresh.push(e);
        }
        if (fresh.length === 0) {
            return;
        }
        fresh.sort(compareEvents);
        const last = this.events[this.events.length - 1];
        if (last === undefined || compareEvents(last, fresh[0]!) <= 0) {
            for (const e of fresh) {
                this.events.push(e);
            }
        } else {
            // Merge the sorted batch into the tail it overlaps.
            const at = upperBound(this.events, fresh[0]!);
            const tail = this.events.splice(at);
            let i = 0;
            let j = 0;
            while (i < tail.length && j < fresh.length) {
                if (compareEvents(tail[i]!, fresh[j]!) <= 0) {
                    this.events.push(tail[i++]!);
                } else {
                    this.events.push(fresh[j++]!);
                }
            }
            while (i < tail.length) {
                this.events.push(tail[i++]!);
            }
            while (j < fresh.length) {
                this.events.push(fresh[j++]!);
            }
        }
        this.enforceRetention();
    }

    addRejected(lines: readonly RejectedLine[]): void {
        const cap = this.source === "live" ? MAX_LIVE_REJECTED_KEPT : Number.POSITIVE_INFINITY;
        for (const line of lines) {
            this.rejectedCount += 1;
            if (this.rejected.length < cap) {
                this.rejected.push(line);
            }
        }
    }

    /** Viewer warning while live retention has dropped events, else null. */
    get retentionNotice(): string | null {
        if (this.droppedByRetention === 0) {
            return null;
        }
        return `${this.droppedByRetention} older live event(s) dropped to stay within ${this.maxLiveEvents} retained events: metrics, diagnostics and a saved recording cover only the retained events`;
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

    /** Live sessions only: evicts the oldest events past the limit (down to 90% of it, amortised). */
    private enforceRetention(): void {
        if (this.source !== "live" || this.events.length <= this.maxLiveEvents) {
            return;
        }
        const keep = Math.max(1, Math.floor(this.maxLiveEvents * 0.9));
        const evicted = this.events.splice(0, this.events.length - keep);
        for (const e of evicted) {
            this.seen.delete(e.event_id);
        }
        this.evictedUpTo = evicted[evicted.length - 1]!;
        this.droppedByRetention += evicted.length;
    }

    /**
     * Same result as findSequenceGaps over every event received, kept
     * incrementally: a stream's gaps are the unseen numbers in [min, max].
     * Retention does not change them (evicted events were received).
     */
    private trackSequence(e: ObservatoryEvent): void {
        const key = streamKey(e);
        const seq = e.sequence;
        const s = this.streams.get(key);
        if (s === undefined) {
            this.streams.set(key, { min: seq, max: seq, gaps: [] });
            return;
        }
        if (seq > s.max) {
            if (seq > s.max + 1) {
                s.gaps.push({ from: s.max + 1, to: seq - 1 });
                this.gapsCache = null;
            }
            s.max = seq;
        } else if (seq < s.min) {
            if (seq < s.min - 1) {
                s.gaps.unshift({ from: seq + 1, to: s.min - 1 });
                this.gapsCache = null;
            }
            s.min = seq;
        } else {
            // Binary search: the last gap starting at or before seq.
            let lo = 0;
            let hi = s.gaps.length;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (s.gaps[mid]!.from <= seq) {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            const i = lo - 1;
            const g = i >= 0 ? s.gaps[i]! : undefined;
            if (g === undefined || seq > g.to) {
                return; // already seen
            }
            const parts: { from: number; to: number }[] = [];
            if (g.from < seq) {
                parts.push({ from: g.from, to: seq - 1 });
            }
            if (seq < g.to) {
                parts.push({ from: seq + 1, to: g.to });
            }
            s.gaps.splice(i, 1, ...parts);
            this.gapsCache = null;
        }
    }
}
