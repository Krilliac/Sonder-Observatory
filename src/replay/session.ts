import type { ObservatoryEvent } from "../protocol/events";
import { boundRejectedLine, estimateEventBytes, formatByteBudget } from "../protocol/size";
import {
    MAX_RECORDING_EVENTS,
    MAX_RECORDING_HEAP_BYTES,
    describeRecordingTruncation,
    type RecordingTruncation,
} from "../recording/limits";
import type { RejectedLine } from "../recording/ndjson";
import { isSyntheticProducer, type RecordingManifest } from "../recording/sobs";
import { markOrdered, notifyPrefixExtended } from "./lookup";
import { compareEvents, streamKey, type SequenceGap } from "./order";

export type SourceKind = "none" | "fixture" | "file" | "live";

/**
 * Most events a live session keeps. A live connection has no end, so the
 * oldest events are dropped past this count or past `DEFAULT_MAX_LIVE_BYTES`;
 * the store counts every one it drops (`droppedByRetention`) and the viewer
 * says so.
 */
export const DEFAULT_MAX_LIVE_EVENTS = 250_000;

/** Estimated JS heap byte ceiling retained for a live session (256 MiB). */
export const DEFAULT_MAX_LIVE_BYTES = 256 * 1024 * 1024;

/** Rejected lines kept for display in a live session (all are counted). */
export const MAX_LIVE_REJECTED_KEPT = 1000;

export interface SessionStoreOptions {
    /** Event-count retention limit for live sessions. Default DEFAULT_MAX_LIVE_EVENTS. */
    maxLiveEvents?: number;
    /** Estimated-byte retention limit for live sessions. Default DEFAULT_MAX_LIVE_BYTES. */
    maxLiveBytes?: number;
    /** Event-count ceiling for loaded recording/fixture sessions. Default MAX_RECORDING_EVENTS. */
    maxRecordingEvents?: number;
    /** Estimated-byte ceiling for loaded recording/fixture sessions. Default MAX_RECORDING_HEAP_BYTES. */
    maxRecordingBytes?: number;
}

/** Per-stream sequence coverage, maintained incrementally for gap reports. */
interface StreamSequences {
    min: number;
    max: number;
    /** Missing ranges inside [min, max], ascending and disjoint. */
    gaps: { from: number; to: number }[];
}

const syntheticCache = new WeakMap<readonly ObservatoryEvent[], boolean>();
const capturePolicyCache = new WeakMap<readonly ObservatoryEvent[], string>();

function capturePolicyOf(events: readonly ObservatoryEvent[]): string {
    const policies = new Set<string>();
    for (const e of events) {
        if (
            (e.event_type === "session.started" || e.event_type === "session.created") &&
            typeof e.attributes.text_capture === "string"
        ) {
            policies.add(e.attributes.text_capture);
        }
    }
    return policies.size > 0 ? [...policies].join(",") : "unspecified";
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
    /** Present when a loaded recording/fixture was truncated to stay within memory budgets. */
    truncatedRecording: RecordingTruncation | null = null;
    readonly maxLiveEvents: number;
    readonly maxLiveBytes: number;
    readonly maxRecordingEvents: number;
    readonly maxRecordingBytes: number;
    private eventSizes: number[] = [];
    private retainedBytesCount = 0;
    private seen = new Set<string>();
    private streams = new Map<string, StreamSequences>();
    private gapsCache: SequenceGap[] | null = [];
    /** Last event evicted by retention; older arrivals are dropped too. */
    private evictedUpTo: ObservatoryEvent | null = null;

    constructor(options: SessionStoreOptions = {}) {
        this.maxLiveEvents = Math.max(1, Math.floor(options.maxLiveEvents ?? DEFAULT_MAX_LIVE_EVENTS));
        this.maxLiveBytes = Math.max(1, Math.floor(options.maxLiveBytes ?? DEFAULT_MAX_LIVE_BYTES));
        this.maxRecordingEvents = Math.max(1, Math.floor(options.maxRecordingEvents ?? MAX_RECORDING_EVENTS));
        this.maxRecordingBytes = Math.max(1, Math.floor(options.maxRecordingBytes ?? MAX_RECORDING_HEAP_BYTES));
        markOrdered(this.events);
    }

    /** Estimated JS heap bytes retained by `events`. */
    get retainedBytes(): number {
        return this.retainedBytesCount;
    }

    reset(
        source: SourceKind,
        label: string,
        manifest: RecordingManifest | null = null,
        truncated: RecordingTruncation | null = null,
    ): void {
        this.source = source;
        this.sourceLabel = label;
        this.manifest = manifest;
        this.truncatedRecording = truncated;
        this.rejected = [];
        this.rejectedCount = 0;
        this.events = [];
        this.eventSizes = [];
        this.retainedBytesCount = 0;
        markOrdered(this.events);
        this.duplicates = 0;
        this.droppedByRetention = 0;
        this.seen = new Set();
        this.streams = new Map();
        this.gapsCache = [];
        this.evictedUpTo = null;
    }

    /** Per-stream sequence gaps among retained events (all events for files). */
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
        let fresh: ObservatoryEvent[] = [];
        let freshSizes: number[] = [];
        let freshBytes = 0;
        const enforceRecordingBudget = this.source === "file" || this.source === "fixture";
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
            const size = estimateEventBytes(e);
            if (enforceRecordingBudget) {
                const countNow = this.events.length + fresh.length;
                const bytesNow = this.retainedBytesCount + freshBytes;
                if (countNow >= this.maxRecordingEvents) {
                    this.truncatedRecording ??= describeRecordingTruncation(
                        "event-limit",
                        this.maxRecordingEvents,
                        countNow,
                        bytesNow,
                    );
                    break;
                }
                if (bytesNow + size > this.maxRecordingBytes) {
                    this.truncatedRecording ??= describeRecordingTruncation(
                        "heap-budget",
                        this.maxRecordingBytes,
                        countNow,
                        bytesNow,
                    );
                    break;
                }
            }
            this.seen.add(e.event_id);
            fresh.push(e);
            freshSizes.push(size);
            freshBytes += size;
        }
        if (fresh.length === 0) {
            return;
        }
        let freshOrdered = true;
        for (let k = 1; k < fresh.length; k += 1) {
            if (compareEvents(fresh[k - 1]!, fresh[k]!) > 0) {
                freshOrdered = false;
                break;
            }
        }
        if (!freshOrdered) {
            const order = Array.from({ length: fresh.length }, (_, idx) => idx);
            order.sort((a, b) => compareEvents(fresh[a]!, fresh[b]!));
            const sortedEvents: ObservatoryEvent[] = new Array<ObservatoryEvent>(fresh.length);
            const sortedSizes: number[] = new Array<number>(fresh.length);
            for (let k = 0; k < order.length; k += 1) {
                const idx = order[k]!;
                sortedEvents[k] = fresh[idx]!;
                sortedSizes[k] = freshSizes[idx]!;
            }
            fresh = sortedEvents;
            freshSizes = sortedSizes;
        }
        // `events` is replaced, never mutated: views cache derived data per
        // array identity (navigation, timelineModel, the replay cursor). The
        // copy is linear; only the new batch is sorted.
        const old = this.events;
        const oldSizes = this.eventSizes;
        const last = old[old.length - 1];
        const at = last === undefined || compareEvents(last, fresh[0]!) <= 0 ? old.length : upperBound(old, fresh[0]!);
        let next: ObservatoryEvent[];
        let nextSizes: number[];
        if (at === old.length) {
            // Fast path for in-order appends: let V8 bulk-copy both backing stores.
            next = old.concat(fresh);
            nextSizes = oldSizes.concat(freshSizes);
        } else {
            next = old.slice(0, at);
            nextSizes = oldSizes.slice(0, at);
            // Merge the sorted batch into the tail it overlaps.
            let i = at;
            let j = 0;
            while (i < old.length && j < fresh.length) {
                if (compareEvents(old[i]!, fresh[j]!) <= 0) {
                    next.push(old[i]!);
                    nextSizes.push(oldSizes[i]!);
                    i += 1;
                } else {
                    next.push(fresh[j]!);
                    nextSizes.push(freshSizes[j]!);
                    j += 1;
                }
            }
            while (i < old.length) {
                next.push(old[i]!);
                nextSizes.push(oldSizes[i]!);
                i += 1;
            }
            while (j < fresh.length) {
                next.push(fresh[j]!);
                nextSizes.push(freshSizes[j]!);
                j += 1;
            }
        }
        const totalBytes = this.retainedBytesCount + freshBytes;
        const drop = this.retentionDrop(nextSizes, totalBytes);
        // The store's arrays are deduplicated, in replay order and never
        // mutated: derived views may skip re-sorting and cache per array
        // (replay/lookup.ts).
        markOrdered(next);
        if (drop > 0) {
            const evicted = this.evict(next, nextSizes, totalBytes, drop);
            this.events = evicted.events;
            this.eventSizes = evicted.sizes;
            this.retainedBytesCount = evicted.bytes;
            markOrdered(this.events);
            // Live sequence history must follow the retained window, including
            // streams whose last event was evicted.
            this.streams = new Map();
            this.gapsCache = [];
            for (const e of this.events) {
                this.trackSequence(e);
            }
        } else {
            this.events = next;
            this.eventSizes = nextSizes;
            this.retainedBytesCount = totalBytes;
            for (const e of fresh) {
                this.trackSequence(e);
            }
            if (at === old.length && old.length > 0) {
                // In-order batch: `next` starts with every event of `old`, so
                // incremental indexes extend instead of rebuilding.
                notifyPrefixExtended(old, next);
            }
        }
    }

    addRejected(lines: readonly RejectedLine[]): void {
        const live = this.source === "live";
        const cap = live ? MAX_LIVE_REJECTED_KEPT : Number.POSITIVE_INFINITY;
        for (const line of lines) {
            this.rejectedCount += 1;
            if (this.rejected.length < cap) {
                this.rejected.push(live ? boundRejectedLine(line) : line);
            }
        }
    }

    /** Viewer warning while live retention has dropped events, else null. */
    get retentionNotice(): string | null {
        if (this.droppedByRetention === 0) {
            return null;
        }
        return `${this.droppedByRetention} older live event(s) dropped to stay within ${this.maxLiveEvents} retained events (${formatByteBudget(this.maxLiveBytes)}): metrics, diagnostics and a saved recording cover only the retained events`;
    }

    /** Viewer warning when a loaded recording stopped early due to event or heap limits, else null. */
    get partialRecordingNotice(): string | null {
        return this.truncatedRecording?.message ?? null;
    }

    get synthetic(): boolean {
        if (this.manifest?.synthetic === true) {
            return true;
        }
        // The viewer asks on every render; the store's arrays are never mutated.
        let cached = syntheticCache.get(this.events);
        if (cached === undefined) {
            cached = this.events.some((e) => isSyntheticProducer(e.producer));
            syntheticCache.set(this.events, cached);
        }
        return cached;
    }

    /**
     * Text capture policy declared at session start, if any
     * (`session.started` or Sonder-Inference's `session.created`).
     */
    get capturePolicy(): string {
        // The header shows it on every render; cached per (immutable) events array.
        let cached = capturePolicyCache.get(this.events);
        if (cached === undefined) {
            cached = capturePolicyOf(this.events);
            capturePolicyCache.set(this.events, cached);
        }
        return cached;
    }

    /** Live sessions only: how many oldest events to evict (down to 90% of count/byte limits, amortised). */
    private retentionDrop(nextSizes: readonly number[], totalBytes: number): number {
        if (this.source !== "live") {
            return 0;
        }
        const total = nextSizes.length;
        let drop = 0;
        if (total > this.maxLiveEvents) {
            drop = total - Math.max(1, Math.floor(this.maxLiveEvents * 0.9));
        }
        if (totalBytes > this.maxLiveBytes) {
            const targetBytes = Math.max(1, Math.floor(this.maxLiveBytes * 0.9));
            let remaining = totalBytes;
            let k = 0;
            while (k < total && (remaining > this.maxLiveBytes || (k < total - 1 && remaining > targetBytes))) {
                remaining -= nextSizes[k]!;
                k += 1;
            }
            if (k > drop) {
                drop = k;
            }
        }
        return drop;
    }

    /** Drops the `drop` oldest of `events` and records them as dropped by retention. */
    private evict(
        events: ObservatoryEvent[],
        sizes: number[],
        totalBytes: number,
        drop: number,
    ): { events: ObservatoryEvent[]; sizes: number[]; bytes: number } {
        let removedBytes = 0;
        for (let k = 0; k < drop; k += 1) {
            this.seen.delete(events[k]!.event_id);
            removedBytes += sizes[k]!;
        }
        this.evictedUpTo = events[drop - 1]!;
        this.droppedByRetention += drop;
        return {
            events: events.slice(drop),
            sizes: sizes.slice(drop),
            bytes: Math.max(0, totalBytes - removedBytes),
        };
    }

    /**
     * Same result as findSequenceGaps over the retained events, kept
     * incrementally: a stream's gaps are the unseen numbers in [min, max].
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
