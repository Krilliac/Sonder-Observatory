import { generateNdjson } from "../../scripts/gen-large-fixture.mjs";
import type { ObservatoryEvent } from "../../src/protocol/events";
import { loadRecording } from "../../src/recording/sobs";
import { orderEvents } from "../../src/replay/order";

const texts = new Map<number, string>();
const ordered = new Map<number, ObservatoryEvent[]>();

/** Deterministic large NDJSON recording (default seed), memoized per size. */
export function largeText(count: number): string {
    let text = texts.get(count);
    if (text === undefined) {
        text = generateNdjson(count);
        texts.set(count, text);
    }
    return text;
}

/** Parsed and replay-ordered events for a large fixture, memoized per size. */
export function largeEvents(count: number): ObservatoryEvent[] {
    let events = ordered.get(count);
    if (!events) {
        events = orderEvents(loadRecording(largeText(count)).events).events;
        ordered.set(count, events);
    }
    return events;
}

/** Wall-clock milliseconds for `fn`. */
export function timeMs<T>(fn: () => T): { ms: number; value: T } {
    const t0 = performance.now();
    const value = fn();
    return { ms: performance.now() - t0, value };
}

/**
 * CI-safe budget multiplier. Budgets below are already several times the
 * measured box numbers; SOBS_PERF_BUDGET_SCALE=2 doubles them on slow runners.
 */
export const BUDGET_SCALE = Number(process.env.SOBS_PERF_BUDGET_SCALE ?? "1") || 1;
