import { isRequestScopedLoadReport } from "../../query/attributes";
import type { Detector } from "../types";
import { findBursts, makeFinding, ms, str } from "../util";

/**
 * Model load/unload churn: `modelChurn.count` or more lifecycle transitions
 * (`model.load.completed` or `model.unload`) within `modelChurn.windowMs`.
 * `model.load.started` is cited only as a pair partner, not counted.
 * Request-scoped load reports (a `model.load.completed` carrying a
 * `request_id`, e.g. Sonder-Inference's Ollama timing helper) are timing facts,
 * not residency transitions, and are not counted.
 */
export const detectModelChurn: Detector = (events, config) => {
    const { count, windowMs } = config.modelChurn;
    const transitions = events.filter(
        (e) => (e.event_type === "model.load.completed" && !isRequestScopedLoadReport(e)) || e.event_type === "model.unload",
    );
    return findBursts(transitions, count, windowMs).map((burst) => {
        const loads = burst.filter((e) => e.event_type === "model.load.completed").length;
        const unloads = burst.length - loads;
        const models = [...new Set(burst.map((e) => e.model_instance_id ?? str(e, "model") ?? "unknown"))];
        const span = ms(burst[burst.length - 1]!.mono_ns - burst[0]!.mono_ns);
        return makeFinding(
            "model-churn",
            burst.length >= count * 2 ? "critical" : "warning",
            burst,
            `${loads} model load(s) and ${unloads} unload(s) within ${span} ms across ${models.length} model instance(s) (threshold ${count} per ${windowMs} ms).`,
            { loads, unloads, span_ms: span, models: models.join(", ") },
        );
    });
};
