/**
 * Pure, DOM-free timeline model for large sessions (docs/integration/perf.md).
 *
 * - `getEventIndex` precomputes, once per events array, each event's class
 *   (Uint8Array) and time relative to the first event (Float64Array). The
 *   result is cached in a WeakMap keyed by the (immutable, replaced-on-append)
 *   events array, so the timeline and the event table share one pass.
 * - `bucketize` is the level-of-detail step: it counts events per
 *   (track, pixel column) over a time range. Its cost is O(events in range)
 *   and it does not depend on the replay cursor, so `TimelineLod` caches it
 *   and scrubbing redraws from the cached buckets in O(tracks x width).
 * - `nearestInTrack` finds the closest event to a click with binary search
 *   instead of scanning every event.
 */
import type { ObservatoryEvent } from "../protocol/events";
import { classifyEvent, EVENT_CLASSES, type EventClass } from "../query/classify";
import { onPrefixExtended } from "../replay/lookup";

export const TRACKS: readonly EventClass[] = EVENT_CLASSES;
const TRACK_INDEX = new Map<EventClass, number>(TRACKS.map((c, i) => [c, i]));

export interface EventIndex {
    readonly events: readonly ObservatoryEvent[];
    /** mono_ns of the first event (0 for an empty session). */
    readonly originNs: number;
    /** Last event time minus originNs. */
    readonly durationNs: number;
    /** Event time relative to originNs, in replay order (non-decreasing). */
    readonly rel: Float64Array;
    /** Track index into TRACKS for each event. */
    readonly cls: Uint8Array;
}

/**
 * event_id -> first position, built lazily. Shared by the indexes of a
 * session's in-order extensions (their prefixes are identical); positions at
 * or past an index's length do not belong to it.
 */
interface IdPositions {
    map: Map<string, number>;
    built: number;
}

const indexCache = new WeakMap<readonly ObservatoryEvent[], EventIndex>();
const idCache = new WeakMap<EventIndex, IdPositions>();
/** Nearest indexed ancestor of a store array that extends it (possibly several appends back). */
const parents = new WeakMap<readonly ObservatoryEvent[], EventIndex>();

// Live appends after the last event: the next index copies this one and classifies only the tail.
onPrefixExtended((previous, next) => {
    const parent = indexCache.get(previous) ?? parents.get(previous);
    if (parent && !indexCache.has(next)) {
        parents.set(next, parent);
    }
});

/** Builds (or returns the cached) class/time index for events in replay order. */
export function getEventIndex(events: readonly ObservatoryEvent[]): EventIndex {
    const cached = indexCache.get(events);
    if (cached) {
        return cached;
    }
    const n = events.length;
    const originNs = n > 0 ? events[0]!.mono_ns : 0;
    const rel = new Float64Array(n);
    const cls = new Uint8Array(n);
    let start = 0;
    const parent = parents.get(events);
    if (parent && parent.originNs === originNs && parent.rel.length <= n) {
        rel.set(parent.rel);
        cls.set(parent.cls);
        start = parent.rel.length;
    }
    for (let i = start; i < n; i += 1) {
        const e = events[i]!;
        rel[i] = e.mono_ns - originNs;
        cls[i] = TRACK_INDEX.get(classifyEvent(e)) ?? TRACKS.length - 1;
    }
    const index: EventIndex = { events, originNs, durationNs: n > 0 ? rel[n - 1]! : 0, rel, cls };
    indexCache.set(events, index);
    parents.delete(events);
    if (parent && start > 0) {
        let ids = idCache.get(parent);
        if (!ids) {
            ids = { map: new Map(), built: 0 };
            idCache.set(parent, ids);
        }
        idCache.set(index, ids);
    }
    return index;
}

/** event_id -> position, built lazily (only when selection/evidence needs it). */
export function eventPosition(index: EventIndex, eventId: string): number {
    let ids = idCache.get(index);
    if (!ids) {
        ids = { map: new Map(), built: 0 };
        idCache.set(index, ids);
    }
    const { events } = index;
    if (ids.built < events.length) {
        for (let i = ids.built; i < events.length; i += 1) {
            const id = events[i]!.event_id;
            if (!ids.map.has(id)) {
                ids.map.set(id, i);
            }
        }
        ids.built = events.length;
    }
    const pos = ids.map.get(eventId);
    return pos !== undefined && pos < events.length ? pos : -1;
}

/** First position whose rel >= t. */
export function lowerBoundRel(rel: Float64Array, t: number): number {
    let lo = 0;
    let hi = rel.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (rel[mid]! < t) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

/** First position whose rel > t (number of events at or before t). */
export function upperBoundRel(rel: Float64Array, t: number): number {
    let lo = 0;
    let hi = rel.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (rel[mid]! <= t) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

export interface Buckets {
    readonly width: number;
    readonly t0: number;
    readonly t1: number;
    /** counts[track * width + column] */
    readonly counts: Uint32Array;
    /** Largest bucket count per track (for density shading). */
    readonly maxPerTrack: Uint32Array;
    /** Events that fell inside [t0, t1]. */
    readonly total: number;
}

/** Pixel column for a relative time inside [t0, t1] at the given width. */
export function columnOf(t: number, t0: number, t1: number, width: number): number {
    const span = Math.max(t1 - t0, 1);
    const col = Math.floor(((t - t0) / span) * width);
    return col < 0 ? 0 : col >= width ? width - 1 : col;
}

/**
 * Level-of-detail bucketing: event counts per (track, column) for events
 * whose relative time is inside [t0, t1]. O(events in range).
 */
export function bucketize(index: EventIndex, width: number, t0 = 0, t1 = index.durationNs): Buckets {
    const w = Math.max(1, Math.floor(width));
    const tracks = TRACKS.length;
    const counts = new Uint32Array(tracks * w);
    const maxPerTrack = new Uint32Array(tracks);
    const { rel, cls } = index;
    const start = lowerBoundRel(rel, t0);
    const end = upperBoundRel(rel, t1);
    const span = Math.max(t1 - t0, 1);
    const scale = w / span;
    for (let i = start; i < end; i += 1) {
        let col = Math.floor((rel[i]! - t0) * scale);
        if (col >= w) {
            col = w - 1;
        }
        const slot = cls[i]! * w + col;
        const c = counts[slot]! + 1;
        counts[slot] = c;
        if (c > maxPerTrack[cls[i]!]!) {
            maxPerTrack[cls[i]!] = c;
        }
    }
    return { width: w, t0, t1, counts, maxPerTrack, total: end - start };
}

/**
 * Caches the last bucketing per (events, width, range). Scrubbing and replay
 * only move the cursor, so they hit the cache and cost nothing here.
 */
export class TimelineLod {
    private key: { index: EventIndex; width: number; t0: number; t1: number } | null = null;
    private value: Buckets | null = null;
    hits = 0;
    misses = 0;

    get(index: EventIndex, width: number, t0 = 0, t1 = index.durationNs): Buckets {
        const w = Math.max(1, Math.floor(width));
        const k = this.key;
        if (this.value && k && k.index === index && k.width === w && k.t0 === t0 && k.t1 === t1) {
            this.hits += 1;
            return this.value;
        }
        this.misses += 1;
        this.key = { index, width: w, t0, t1 };
        this.value = bucketize(index, w, t0, t1);
        return this.value;
    }
}

/**
 * Position of the event nearest to `t` (optionally restricted to one track)
 * within `maxDist`, or -1. Binary search, then walks outward until the time
 * distance exceeds the best candidate, so it only touches nearby events.
 */
export function nearestInTrack(index: EventIndex, t: number, track: number, maxDist = Infinity): number {
    const { rel, cls } = index;
    const n = rel.length;
    if (n === 0) {
        return -1;
    }
    const pivot = lowerBoundRel(rel, t);
    let best = -1;
    let bestD = maxDist;
    for (let i = pivot; i < n; i += 1) {
        const d = rel[i]! - t;
        if (d > bestD) {
            break;
        }
        if (track < 0 || cls[i] === track) {
            if (d < bestD || best < 0) {
                best = i;
                bestD = d;
            }
            break;
        }
    }
    for (let i = pivot - 1; i >= 0; i -= 1) {
        const d = t - rel[i]!;
        if (d > bestD) {
            break;
        }
        if (track < 0 || cls[i] === track) {
            // Ties prefer the earlier event, matching the old linear scan's first hit.
            if (d <= bestD) {
                best = i;
            }
            break;
        }
    }
    return best;
}
