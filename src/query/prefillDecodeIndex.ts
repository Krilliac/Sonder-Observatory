/** Sparse Prefill/Decode + TTFT index, sharing the immutable live/replay array lifecycle. */
import type { ObservatoryEvent } from "../protocol/events";
import { isOrdered, onPrefixExtended } from "../replay/lookup";
import { derivePrefillDecode, isPrefillDecodeEvent, type PrefillDecodeMetrics } from "./prefillDecode";

const EMPTY: PrefillDecodeMetrics = derivePrefillDecode([]);

class PrefillDecodeIndex {
    private indexed = 0;
    private readonly positions: number[] = [];
    private readonly relevant: ObservatoryEvent[] = [];
    private lastCount = -1;
    private lastMetrics: PrefillDecodeMetrics = EMPTY;

    constructor(public events: readonly ObservatoryEvent[]) {}

    at(count: number): PrefillDecodeMetrics {
        while (this.indexed < count) {
            const event = this.events[this.indexed]!;
            if (isPrefillDecodeEvent(event)) {
                this.positions.push(this.indexed);
                this.relevant.push(event);
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
        if (lo !== this.lastCount) {
            this.lastMetrics = derivePrefillDecode(this.relevant.slice(0, lo));
            this.lastCount = lo;
        }
        return this.lastMetrics;
    }
}

const indexes = new WeakMap<readonly ObservatoryEvent[], PrefillDecodeIndex>();

/** Equal to derivePrefillDecode(events.slice(0, count)); events must be in replay order. */
export function prefillDecodeAt(events: readonly ObservatoryEvent[], count = events.length): PrefillDecodeMetrics {
    const limit = Number.isNaN(count) ? 0 : Math.max(0, Math.min(events.length, Math.floor(count)));
    if (!isOrdered(events)) {
        return derivePrefillDecode(events.slice(0, limit));
    }
    let index = indexes.get(events);
    if (!index) {
        index = new PrefillDecodeIndex(events);
        indexes.set(events, index);
    }
    return index.at(limit);
}

onPrefixExtended((previous, next) => {
    const index = indexes.get(previous);
    if (index && !indexes.has(next)) {
        index.events = next;
        indexes.set(next, index);
    }
});
