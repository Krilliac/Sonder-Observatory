import type { ObservatoryEvent } from "../../protocol/events";
import type { Detector } from "../types";
import { makeFinding } from "../util";
import { findBurstsLinear, safeSpanMs } from "./shared";

/** Failure events: `*.failed` and `*.error` (retries/guards are other detectors). */
export function isFailureEvent(e: ObservatoryEvent): boolean {
    return e.event_type.endsWith(".failed") || e.event_type.endsWith(".error");
}

/**
 * Error bursts: `errorBurst.count` or more failure events within
 * `errorBurst.windowMs`. Critical at 2x count.
 */
export const detectErrorBursts: Detector = (events, config) => {
    const { count, windowMs } = config.errorBurst;
    const failures = events.filter(isFailureEvent);
    return findBurstsLinear(failures, count, windowMs).map((burst) => {
        const byType = new Map<string, number>();
        for (const e of burst) {
            byType.set(e.event_type, (byType.get(e.event_type) ?? 0) + 1);
        }
        const span = safeSpanMs(burst[0]!.mono_ns, burst[burst.length - 1]!.mono_ns);
        const breakdown = [...byType.entries()]
            .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
            .map(([t, n]) => `${n}x ${t}`)
            .join(", ");
        return makeFinding(
            "error-burst",
            burst.length >= count * 2 ? "critical" : "warning",
            burst,
            `${burst.length} failures within ${span} ms: ${breakdown} (threshold ${count} per ${windowMs} ms).`,
            { failures: burst.length, span_ms: span, breakdown },
        );
    });
};
