/** Sparse execution_route / ensemble / fanout index matching live/replay lifecycle. */
import type { ObservatoryEvent } from "../protocol/events";
import { isOrdered, onPrefixExtended } from "../replay/lookup";
import { deriveExecutionRoutes, isExecutionRouteEvent, type ExecutionRouteMetrics } from "./executionRoute";

const EMPTY: ExecutionRouteMetrics = deriveExecutionRoutes([]);

class ExecutionRouteIndex {
    private indexed = 0;
    private readonly positions: number[] = [];
    private readonly relevant: ObservatoryEvent[] = [];
    private lastCount = -1;
    private lastMetrics: ExecutionRouteMetrics = EMPTY;

    constructor(public events: readonly ObservatoryEvent[]) {}

    at(count: number): ExecutionRouteMetrics {
        while (this.indexed < count) {
            const event = this.events[this.indexed]!;
            if (isExecutionRouteEvent(event)) {
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
            this.lastMetrics = deriveExecutionRoutes(this.relevant.slice(0, lo));
            this.lastCount = lo;
        }
        return this.lastMetrics;
    }
}

const indexes = new WeakMap<readonly ObservatoryEvent[], ExecutionRouteIndex>();

/** Equal to deriveExecutionRoutes(events.slice(0, count)); events must be in replay order. */
export function executionRouteAt(events: readonly ObservatoryEvent[], count = events.length): ExecutionRouteMetrics {
    const limit = Number.isNaN(count) ? 0 : Math.max(0, Math.min(events.length, Math.floor(count)));
    if (!isOrdered(events)) {
        return deriveExecutionRoutes(events.slice(0, limit));
    }
    let index = indexes.get(events);
    if (!index) {
        index = new ExecutionRouteIndex(events);
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
