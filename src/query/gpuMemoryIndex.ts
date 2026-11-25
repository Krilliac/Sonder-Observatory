/** Sparse GPU-event indexes, sharing the existing immutable live/replay array lifecycle. */
import type { ObservatoryEvent } from "../protocol/events";
import { isOrdered, onPrefixExtended } from "../replay/lookup";
import {
    deriveGpuMemory,
    deriveNodeGpuMemory,
    isGpuBackendIndexEvent,
    isNodeGpuDeviceEvent,
    type GpuMetrics,
    type MultiGpuMetrics,
} from "./gpuMemory";

class SparseEventIndex<T> {
    private indexed = 0;
    private readonly positions: number[] = [];
    private readonly reports: ObservatoryEvent[] = [];
    private lastCount = -1;
    private lastMetrics: T;

    constructor(
        public events: readonly ObservatoryEvent[],
        private readonly predicate: (event: ObservatoryEvent) => boolean,
        private readonly derive: (events: Iterable<ObservatoryEvent>) => T,
        empty: T,
    ) {
        this.lastMetrics = empty;
    }

    at(count: number): T {
        while (this.indexed < count) {
            const event = this.events[this.indexed]!;
            if (this.predicate(event)) {
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
            this.lastMetrics = this.derive(this.reports.slice(0, lo));
            this.lastCount = lo;
        }
        return this.lastMetrics;
    }
}

const backendIndexes = new WeakMap<readonly ObservatoryEvent[], SparseEventIndex<GpuMetrics>>();
const nodeIndexes = new WeakMap<readonly ObservatoryEvent[], SparseEventIndex<MultiGpuMetrics>>();

/** Equal to deriveGpuMemory(events.slice(0, count)); events must be in replay order. */
export function gpuMemoryAt(events: readonly ObservatoryEvent[], count = events.length): GpuMetrics {
    const limit = Number.isNaN(count) ? 0 : Math.max(0, Math.min(events.length, Math.floor(count)));
    if (!isOrdered(events)) {
        return deriveGpuMemory(events.slice(0, limit));
    }
    let index = backendIndexes.get(events);
    if (!index) {
        index = new SparseEventIndex(events, isGpuBackendIndexEvent, deriveGpuMemory, { backends: [] });
        backendIndexes.set(events, index);
    }
    return index.at(limit);
}

/** Equal to deriveNodeGpuMemory(events.slice(0, count)); events must be in replay order. */
export function nodeGpuMemoryAt(events: readonly ObservatoryEvent[], count = events.length): MultiGpuMetrics {
    const limit = Number.isNaN(count) ? 0 : Math.max(0, Math.min(events.length, Math.floor(count)));
    if (!isOrdered(events)) {
        return deriveNodeGpuMemory(events.slice(0, limit));
    }
    let index = nodeIndexes.get(events);
    if (!index) {
        index = new SparseEventIndex(events, isNodeGpuDeviceEvent, deriveNodeGpuMemory, { nodes: [] });
        nodeIndexes.set(events, index);
    }
    return index.at(limit);
}

// Eviction, reset and out-of-order merges never notify a prefix extension, so
// they get a fresh index. No evicted samples or warnings survive in live state.
onPrefixExtended((previous, next) => {
    const backend = backendIndexes.get(previous);
    if (backend && !backendIndexes.has(next)) {
        backend.events = next;
        backendIndexes.set(next, backend);
    }
    const node = nodeIndexes.get(previous);
    if (node && !nodeIndexes.has(next)) {
        node.events = next;
        nodeIndexes.set(next, node);
    }
});
