import type { ObservatoryEvent } from "../../protocol/events";
import { createIdentityKeys } from "../../query/identity";
import { isEmbeddingRequestEvent } from "../../query/metrics";
import type { Detector, Finding } from "../types";
import { makeFinding, ms } from "../util";

interface Span {
    requestId: string;
    start: ObservatoryEvent;
    end: ObservatoryEvent;
    durationMs: number;
}

function lowerBound(sorted: readonly number[], target: number): number {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sorted[mid]! < target) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

/**
 * Request latency outliers against a rolling baseline.
 *
 * Request spans run from `request.started` (or `request.queued` for embedding
 * servers that omit `request.started`) to `request.completed` or
 * `request.failed` (cancelled requests and negative/non-finite durations are
 * excluded). In end order, each span is compared with the p95 of the previous
 * `latency.baselineSize` spans; it is an outlier when at least `minBaseline`
 * prior spans exist, its duration exceeds p95 x `factor`, and the excess is at
 * least `minExcessMs`. Critical at 2x the factor.
 */
export const detectLatencyOutliers: Detector = (events, config) => {
    const cfg = config.latency;
    if (
        !Number.isFinite(cfg.baselineSize) ||
        cfg.baselineSize < 1 ||
        !Number.isFinite(cfg.minBaseline) ||
        cfg.minBaseline < 1 ||
        !Number.isFinite(cfg.factor) ||
        cfg.factor <= 0 ||
        !Number.isFinite(cfg.minExcessMs) ||
        cfg.minExcessMs < 0
    ) {
        return [];
    }
    const baselineSize = Math.floor(cfg.baselineSize);
    const minBaseline = Math.ceil(cfg.minBaseline);
    const idKeys = createIdentityKeys();
    const starts = new Map<string, ObservatoryEvent>();
    const spans: Span[] = [];
    for (const e of events) {
        const rid = e.request_id;
        if (!rid) {
            continue;
        }
        const t = e.event_type;
        if (
            t !== "request.started" &&
            t !== "request.queued" &&
            t !== "request.completed" &&
            t !== "request.failed" &&
            t !== "request.cancelled"
        ) {
            continue;
        }
        const key = idKeys.request(idKeys.stream(e), rid);
        if (t === "request.started") {
            starts.set(key, e);
        } else if (t === "request.queued") {
            if (isEmbeddingRequestEvent(e) && !starts.has(key)) {
                starts.set(key, e);
            }
        } else if (t === "request.completed" || t === "request.failed") {
            const start = starts.get(key);
            if (start) {
                starts.delete(key);
                if (Number.isFinite(start.mono_ns) && Number.isFinite(e.mono_ns) && e.mono_ns >= start.mono_ns) {
                    spans.push({ requestId: rid, start, end: e, durationMs: (e.mono_ns - start.mono_ns) / 1e6 });
                }
            }
        } else if (t === "request.cancelled") {
            starts.delete(key);
        }
    }

    const findings: Finding[] = [];
    const sortedWindow: number[] = [];
    for (let i = 0; i < spans.length; i += 1) {
        const span = spans[i]!;
        if (sortedWindow.length >= minBaseline) {
            const rank = Math.ceil(0.95 * sortedWindow.length);
            const p95 = sortedWindow[Math.min(Math.max(rank, 1), sortedWindow.length) - 1]!;
            if (span.durationMs > p95 * cfg.factor && span.durationMs - p95 >= cfg.minExcessMs) {
                const ratio = p95 > 0 ? span.durationMs / p95 : Infinity;
                findings.push(
                    makeFinding(
                        "latency-outlier",
                        span.durationMs > p95 * cfg.factor * 2 ? "critical" : "warning",
                        [span.start, span.end],
                        `Request ${span.requestId} took ${Math.round(span.durationMs)} ms, ${Number.isFinite(ratio) ? `${ratio.toFixed(1)}x` : "far above"} the rolling p95 of ${Math.round(p95)} ms over the previous ${sortedWindow.length} request(s).`,
                        {
                            request_id: span.requestId,
                            duration_ms: ms(span.end.mono_ns - span.start.mono_ns),
                            baseline_p95_ms: Math.round(p95),
                            baseline_requests: sortedWindow.length,
                            outcome: span.end.event_type === "request.failed" ? "failed" : "completed",
                        },
                    ),
                );
            }
        }
        const insertAt = lowerBound(sortedWindow, span.durationMs);
        sortedWindow.splice(insertAt, 0, span.durationMs);
        if (sortedWindow.length > baselineSize) {
            const expired = spans[i - baselineSize]!.durationMs;
            const removeAt = lowerBound(sortedWindow, expired);
            if (removeAt < sortedWindow.length && sortedWindow[removeAt] === expired) {
                sortedWindow.splice(removeAt, 1);
            }
        }
    }
    return findings;
};
