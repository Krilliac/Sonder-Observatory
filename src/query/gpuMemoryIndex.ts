/** Sparse GPU-event index, sharing the existing immutable live/replay array lifecycle. */
import type { ObservatoryEvent } from "../protocol/events";
import { isOrdered, onPrefixExtended } from "../replay/lookup";
import { deriveGpuMemory, isGpuEvent, type GpuMetrics } from "./gpuMemory";

class GpuMemoryIndex {
    private indexed = 0;
    private readonly positions: number[] = [];
    private readonly reports: ObservatoryEvent[] = [];
    private lastCount = -1;
    private lastMetrics: GpuMetrics = { backends: [] };

    constructor(public events: readonly ObservatoryEvent[]) {}

    at(count: number): GpuMetrics {
        while (this.indexed < count) {
            const event = this.events[this.indexed]!;
            if (isGpuEvent(event)) {
                this.positions.push(this.indexed);
                this.reports.push(event);
            }
            this.indexed += 1;
        }
        let lo = 0;
        let hi = this.positions.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (this.positions[mid]! < count) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        // Ordinary token traffic does not change GPU telemetry or recompute its history.
        if (lo !== this.lastCount) {
            this.lastMetrics = deriveGpuMemory(this.reports.slice(0, lo));
            this.lastCount = lo;
        }
        return this.lastMetrics;
    }
}

const indexes = new WeakMap<readonly ObservatoryEvent[], GpuMemoryIndex>();

/** Equal to deriveGpuMemory(events.slice(0, count)); events must be in replay order. */
export function gpuMemoryAt(events: readonly ObservatoryEvent[], count = events.length): GpuMetrics {
    const limit = Number.isNaN(count) ? 0 : Math.max(0, Math.min(events.length, Math.floor(count)));
    if (!isOrdered(events)) {
        return deriveGpuMemory(events.slice(0, limit));
    }
    let index = indexes.get(events);
    if (!index) {
        index = new GpuMemoryIndex(events);
        indexes.set(events, index);
    }
    return index.at(limit);
}

// Eviction, reset and out-of-order merges never notify a prefix extension, so
// they get a fresh index. No evicted samples or warnings survive in live state.
onPrefixExtended((previous, next) => {
    const index = indexes.get(previous);
    if (index && !indexes.has(next)) {
        index.events = next;
        indexes.set(next, index);
    }
});
