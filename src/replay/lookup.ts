/**
 * Shared facts about event arrays that let derived views skip repeated work
 * on large sessions (docs/integration/perf.md).
 *
 * - Arrays produced by `orderEvents` and `SessionStore` are deduplicated by
 *   event_id, in replay order, and never mutated (the store replaces its
 *   array on every change). They are marked here so consumers (topology,
 *   diagnostics, the metrics and correlation indexes) can skip re-sorting and
 *   deduplicating, and can cache per array.
 * - Prefix listeners: when the store appends strictly after its last event,
 *   the new array starts with every element of the old one, so incremental
 *   indexes can extend to the new array instead of rebuilding.
 */
import type { ObservatoryEvent } from "../protocol/events";

type Events = readonly ObservatoryEvent[];

const ordered = new WeakSet<Events>();

/** Marks an array as deduplicated (by event_id), in replay order and never mutated. */
export function markOrdered(events: Events): void {
    ordered.add(events);
}

/** True when `events` came from orderEvents / SessionStore (deduplicated, replay order, immutable). */
export function isOrdered(events: Events): boolean {
    return ordered.has(events);
}

type PrefixListener = (previous: Events, next: Events) => void;
const prefixListeners: PrefixListener[] = [];

/** Called when `next` starts with every element of `previous`, in order (both marked ordered). */
export function onPrefixExtended(listener: PrefixListener): void {
    prefixListeners.push(listener);
}

export function notifyPrefixExtended(previous: Events, next: Events): void {
    for (const listener of prefixListeners) {
        listener(previous, next);
    }
}
