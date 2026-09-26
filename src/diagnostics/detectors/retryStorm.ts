import type { Detector } from "../types";
import { findBursts, makeFinding, ms, str } from "../util";

/**
 * Retry storms: `retryStorm.count` or more `retry.scheduled` events within
 * `retryStorm.windowMs` (across the whole stream). Critical at 2x count.
 */
export const detectRetryStorms: Detector = (events, config) => {
    const { count, windowMs } = config.retryStorm;
    const retries = events.filter((e) => e.event_type === "retry.scheduled");
    return findBursts(retries, count, windowMs).map((burst) => {
        const targets = [
            ...new Set(burst.map((e) => str(e, "tool_call_id") ?? e.request_id ?? e.task_id ?? e.agent_id ?? "unscoped")),
        ];
        const span = ms(burst[burst.length - 1]!.mono_ns - burst[0]!.mono_ns);
        return makeFinding(
            "retry-storm",
            burst.length >= count * 2 ? "critical" : "warning",
            burst,
            `${burst.length} retries scheduled within ${span} ms across ${targets.length} target(s) (threshold ${count} per ${windowMs} ms).`,
            { retries: burst.length, span_ms: span, targets: targets.join(", ") },
        );
    });
};
