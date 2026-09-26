import type { ObservatoryEvent } from "../../protocol/events";
import { percentile } from "../../query/metrics";
import type { Detector, Finding } from "../types";
import { makeFinding, ms } from "../util";

interface Span {
    requestId: string;
    start: ObservatoryEvent;
    end: ObservatoryEvent;
    durationMs: number;
}

/**
 * Request latency outliers against a rolling baseline.
 *
 * Request spans run from `request.started` to `request.completed` or
 * `request.failed` (cancelled requests are excluded). In end order, each span
 * is compared with the p95 of the previous `latency.baselineSize` spans; it is
 * an outlier when at least `minBaseline` prior spans exist, its duration
 * exceeds p95 x `factor`, and the excess is at least `minExcessMs`.
 * Critical at 2x the factor. Evidence: the span's start and end events.
 */
export const detectLatencyOutliers: Detector = (events, config) => {
    const cfg = config.latency;
    const starts = new Map<string, ObservatoryEvent>();
    const spans: Span[] = [];
    for (const e of events) {
        const rid = e.request_id;
        if (!rid) {
            continue;
        }
        if (e.event_type === "request.started") {
            starts.set(rid, e);
        } else if (e.event_type === "request.completed" || e.event_type === "request.failed") {
            const start = starts.get(rid);
            if (start) {
                spans.push({ requestId: rid, start, end: e, durationMs: (e.mono_ns - start.mono_ns) / 1e6 });
                starts.delete(rid);
            }
        } else if (e.event_type === "request.cancelled") {
            starts.delete(rid);
        }
    }

    const findings: Finding[] = [];
    for (let i = 0; i < spans.length; i++) {
        const baseline = spans.slice(Math.max(0, i - cfg.baselineSize), i).map((s) => s.durationMs);
        if (baseline.length < cfg.minBaseline) {
            continue;
        }
        const p95 = percentile(baseline, 95)!;
        const span = spans[i]!;
        if (span.durationMs > p95 * cfg.factor && span.durationMs - p95 >= cfg.minExcessMs) {
            const ratio = p95 > 0 ? span.durationMs / p95 : Infinity;
            findings.push(
                makeFinding(
                    "latency-outlier",
                    span.durationMs > p95 * cfg.factor * 2 ? "critical" : "warning",
                    [span.start, span.end],
                    `Request ${span.requestId} took ${Math.round(span.durationMs)} ms, ${Number.isFinite(ratio) ? `${ratio.toFixed(1)}x` : "far above"} the rolling p95 of ${Math.round(p95)} ms over the previous ${baseline.length} request(s).`,
                    {
                        request_id: span.requestId,
                        duration_ms: ms(span.end.mono_ns - span.start.mono_ns),
                        baseline_p95_ms: Math.round(p95),
                        baseline_requests: baseline.length,
                        outcome: span.end.event_type === "request.failed" ? "failed" : "completed",
                    },
                ),
            );
        }
    }
    return findings;
};
