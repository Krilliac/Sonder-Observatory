import type { ObservatoryEvent } from "../protocol/events";
import type { Metrics } from "../query/metrics";
import { metricsAt } from "../query/metricsIndex";
import { isOrdered } from "./lookup";

/**
 * Pure replay cursor over events that are already in replay order
 * (see orderEvents). Time is expressed as nanoseconds relative to the first
 * event's mono_ns so the scrubber starts at 0.
 */
export class ReplayCursor {
    readonly events: readonly ObservatoryEvent[];
    readonly originNs: number;
    readonly durationNs: number;
    private positionNs = 0;
    private prefixCount = -1;
    private prefix: readonly ObservatoryEvent[] = [];

    constructor(events: readonly ObservatoryEvent[]) {
        this.events = events;
        this.originNs = events.length > 0 ? events[0]!.mono_ns : 0;
        this.durationNs =
            events.length > 0 ? events[events.length - 1]!.mono_ns - this.originNs : 0;
        this.positionNs = this.durationNs;
    }

    get position(): number {
        return this.positionNs;
    }

    /** Clamps and sets the cursor position (relative ns). */
    seek(relativeNs: number): number {
        this.positionNs = Math.min(Math.max(0, relativeNs), this.durationNs);
        return this.positionNs;
    }

    /** Advances by wall-clock elapsed milliseconds times playback speed. */
    advance(elapsedMs: number, speed: number): number {
        return this.seek(this.positionNs + elapsedMs * 1e6 * speed);
    }

    get atEnd(): boolean {
        return this.positionNs >= this.durationNs;
    }

    /** Number of events at or before the cursor (binary search). */
    visibleCount(): number {
        return upperBound(this.events, this.originNs + this.positionNs);
    }

    /** Reuse one prefix only for immutable ordered snapshots; owner arrays retain fresh-slice semantics. */
    visibleEvents(): readonly ObservatoryEvent[] {
        const count = this.visibleCount();
        if (!isOrdered(this.events)) {
            return this.events.slice(0, count);
        }
        if (count !== this.prefixCount) {
            this.prefix = count === this.events.length ? this.events : this.events.slice(0, count);
            this.prefixCount = count;
        }
        return this.prefix;
    }

    /**
     * Metrics at the cursor: equal to deriveMetrics(visibleEvents()) but
     * incremental (query/metricsIndex.ts), so a scrub frame over a large
     * session does not rescan the prefix.
     */
    metrics(): Metrics {
        return metricsAt(this.events, this.visibleCount());
    }

    relativeTime(event: ObservatoryEvent): number {
        return event.mono_ns - this.originNs;
    }

    /** First event strictly after the cursor matching the predicate. */
    nextMatching(predicate: (e: ObservatoryEvent) => boolean): ObservatoryEvent | undefined {
        for (let i = this.visibleCount(); i < this.events.length; i += 1) {
            const e = this.events[i]!;
            if (predicate(e)) {
                return e;
            }
        }
        return undefined;
    }
}

/** Index of the first event whose mono_ns is greater than `monoNs`. */
export function upperBound(events: readonly ObservatoryEvent[], monoNs: number): number {
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (events[mid]!.mono_ns <= monoNs) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}
