/**
 * Metric derivation from protocol events. Every metric is "derived" from
 * measured producer events and carries the event ids it was computed from so
 * the inspector can show evidence. Nothing here estimates values that the
 * producer did not report: a metric with no evidence is `null` (unavailable).
 */
import type { ObservatoryEvent } from "../protocol/events";
import { streamKey } from "../replay/order";
import { backendEvalMs, backendTokenCount, memoryUsage, outputTokenCount, totalDroppedEvents } from "./attributes";
import { isErrorEvent } from "./classify";

export type Provenance = "measured" | "backend-reported" | "derived" | "estimated" | "unavailable";

/** Where a token total comes from; "mixed" when backend counts and token events both contribute. */
export type TokenProvenance = "backend-reported" | "derived" | "mixed" | "unavailable";

/**
 * How a request's decode (generation) window was measured, best first:
 * - `backend-eval`: `inference.decode.completed.backend_eval_ms` (covers hidden thinking tokens too);
 * - `reported-total-minus-ttft`: outcome `total_ms - ttft_ms` (first visible output to end);
 * - `first-output-to-end`: first output event to the outcome event;
 * - `first-to-last-token`: first to last per-token event of a request still open.
 */
export type DecodeSource = "backend-eval" | "reported-total-minus-ttft" | "first-output-to-end" | "first-to-last-token";

export interface DecodeWindow {
    startNs: number;
    endNs: number;
    /** Window length (ns); for reported sources this is the reported duration. */
    ns: number;
    /**
     * Tokens generated inside the window: the whole count for `backend-eval`
     * (eval_count / eval_duration), otherwise the tokens after the first one
     * (the first token opens the window), as Sonder-Inference's bench does.
     */
    tokens: number;
    source: DecodeSource;
}

export interface LatencyStats {
    count: number;
    p50Ms: number | null;
    p95Ms: number | null;
    maxMs: number | null;
}

export interface RequestSpan {
    requestId: string;
    /**
     * Producer stream the span belongs to (see replay/order streamKey).
     * Spans are keyed by (streamKey, request_id), so two producers that
     * share a request_id yield two spans.
     */
    streamKey: string;
    /** producer.name of the stream. */
    producer: string;
    startNs: number;
    endNs: number | null;
    outcome: "completed" | "failed" | "cancelled" | "open";
    /** First output event (token or chunk): the time to first token. */
    firstTokenNs: number | null;
    /** Tokens counted from per-token inference.token.generated events (never chunks). */
    tokens: number;
    /** Output events that carry no token count (`unit: "chunk"` or another non-token unit). */
    chunks: number;
    /** Completion tokens reported by the backend on the outcome event, if any. */
    backendTokens: number | null;
    /** Best token count: backendTokens, else counted token events; null when only chunks were seen. */
    tokenCount: number | null;
    /** Decode window used for the token rate; null when it cannot be measured. */
    decode: DecodeWindow | null;
}

export interface ResourceSample {
    monoNs: number;
    deviceId: string | null;
    usedBytes: number;
    totalBytes: number;
    fraction: number;
    eventId: string;
}

export interface Metrics {
    eventCount: number;
    requests: RequestSpan[];
    requestLatency: LatencyStats;
    /** Finished-request latency per producer.name (additive). */
    requestLatencyByProducer: Record<string, LatencyStats>;
    timeToFirstToken: LatencyStats;
    tokens: {
        /** fromBackend + fromEvents. Chunk events are never counted. */
        total: number;
        provenance: TokenProvenance;
        /** Backend-reported completion tokens of requests that report them. */
        fromBackend: number;
        /** Tokens from per-token events of requests without a backend count (and of no request). */
        fromEvents: number;
        /** Output events that carry no token count (chunks). */
        chunks: number;
        /** Requests with output chunks but no token count yet (open, or the backend did not report). */
        uncountedRequests: number;
        /**
         * Tokens per second of active generation: decode-window tokens over the
         * summed decode windows of the requests (idle time is excluded).
         */
        overallRate: number | null;
        /** Summed decode windows (ms) behind overallRate. */
        activeDecodeMs: number | null;
        /**
         * Tokens per second over the trailing window ending at the last event:
         * per-token events in it, plus backend counts spread evenly over their decode window.
         */
        recentRate: number | null;
        /**
         * Length (ms) of that trailing window: RECENT_WINDOW_MS, or less when
         * the session has not yet lasted that long.
         */
        windowMs: number;
        /**
         * Sum of backend-reported completion tokens over requests that report
         * them (`token_counts_from_backend`); null when no request does.
         */
        backendReported: number | null;
    };
    errors: {
        total: number;
        byType: Record<string, number>;
        eventIds: string[];
    };
    agents: {
        active: string[];
        spawned: number;
        completed: number;
        transitions: number;
    };
    tools: {
        active: string[];
        called: number;
        completed: number;
        failed: number;
    };
    resources: {
        latest: ResourceSample | null;
        peak: ResourceSample | null;
        pressureEvents: number;
        latestComputeUtilization: number | null;
    };
    /** Producer-reported drops: latest cumulative count per producer instance, summed. */
    droppedEvents: number;
}

export const RECENT_WINDOW_MS = 5000;

/** Nearest-rank percentile of a list of numbers. */
export function percentile(values: readonly number[], p: number): number | null {
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}

function latencyStats(durationsNs: readonly number[]): LatencyStats {
    const ms = durationsNs.map((d) => d / 1e6);
    // A loop, not Math.max(...ms): spreading throws RangeError past ~125k values.
    let maxMs: number | null = null;
    for (const v of ms) {
        if (maxMs === null || v > maxMs) {
            maxMs = v;
        }
    }
    return {
        count: ms.length,
        p50Ms: percentile(ms, 50),
        p95Ms: percentile(ms, 95),
        maxMs,
    };
}

function numberAttr(event: ObservatoryEvent, key: string): number | null {
    const v = event.attributes[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

interface TokenTime {
    ns: number;
    n: number;
}

/** Per-span facts only the token metrics need. */
interface SpanWork {
    /** Per-token events (never chunks) of the span. */
    tokenTimes: TokenTime[];
    evalMs: number | null;
    evalEndNs: number | null;
    totalMs: number | null;
    ttftMs: number | null;
}

/** Best decode window of a span whose token count is known (see DecodeSource). */
function decodeWindow(span: RequestSpan, w: SpanWork): DecodeWindow | null {
    const count = span.tokenCount;
    if (count === null || count <= 0) {
        return null;
    }
    if (w.evalMs !== null) {
        const endNs = w.evalEndNs ?? span.endNs!;
        const ns = w.evalMs * 1e6;
        return { startNs: endNs - ns, endNs, ns, tokens: count, source: "backend-eval" };
    }
    if (count < 2) {
        return null;
    }
    if (span.endNs !== null && w.totalMs !== null && w.ttftMs !== null && w.ttftMs >= 0 && w.totalMs > w.ttftMs) {
        const ns = (w.totalMs - w.ttftMs) * 1e6;
        return { startNs: span.endNs - ns, endNs: span.endNs, ns, tokens: count - 1, source: "reported-total-minus-ttft" };
    }
    if (span.firstTokenNs === null) {
        return null;
    }
    const open = span.endNs === null;
    const endNs = open ? (w.tokenTimes.at(-1)?.ns ?? null) : span.endNs;
    if (endNs === null || endNs <= span.firstTokenNs) {
        return null;
    }
    return {
        startNs: span.firstTokenNs,
        endNs,
        ns: endNs - span.firstTokenNs,
        tokens: count - 1,
        source: open ? "first-to-last-token" : "first-output-to-end",
    };
}

function overlapNs(a0: number, a1: number, b0: number, b1: number): number {
    return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/**
 * Token totals and rates. Backend counts win over token events for a request;
 * chunk events are never tokens; rates use decode windows, never session wall time.
 */
function tokenMetrics(
    requests: RequestSpan[],
    work: ReadonlyMap<RequestSpan, SpanWork>,
    looseTokens: readonly TokenTime[],
    chunks: number,
    firstNs: number | null,
    lastNs: number | null,
): Metrics["tokens"] {
    let fromBackend = 0;
    let backendSpans = 0;
    let fromEvents = 0;
    let eventCounted = 0;
    let uncountedRequests = 0;
    let decodeTokens = 0;
    let decodeNs = 0;
    /** Measured per-token events that count toward the totals (for the trailing window). */
    const counted: TokenTime[] = [...looseTokens];
    const spread: DecodeWindow[] = [];
    for (const span of requests) {
        const w = work.get(span)!;
        if (span.backendTokens !== null) {
            span.tokenCount = span.backendTokens;
            fromBackend += span.backendTokens;
            backendSpans += 1;
        } else if (span.chunks > 0 && span.tokens === 0) {
            span.tokenCount = null;
            uncountedRequests += 1;
        } else {
            span.tokenCount = span.tokens;
            fromEvents += span.tokens;
            eventCounted += w.tokenTimes.length;
            for (const x of w.tokenTimes) {
                counted.push(x);
            }
        }
        span.decode = decodeWindow(span, w);
        if (span.decode) {
            decodeTokens += span.decode.tokens;
            decodeNs += span.decode.ns;
            if (span.backendTokens !== null) {
                spread.push(span.decode);
            }
        }
    }
    for (const x of looseTokens) {
        fromEvents += x.n;
    }
    eventCounted += looseTokens.length;
    if (looseTokens.length >= 2) {
        // Token events with no request: their first-to-last span, as one stream.
        // The first event opens the span, so its tokens are not in it (N events
        // bound N-1 intervals), as decodeWindow does for a request.
        const ns = looseTokens[looseTokens.length - 1]!.ns - looseTokens[0]!.ns;
        if (ns > 0) {
            decodeTokens += looseTokens.reduce((sum, x) => sum + x.n, 0) - looseTokens[0]!.n;
            decodeNs += ns;
        }
    }
    const provenance: TokenProvenance =
        backendSpans > 0 && eventCounted > 0 ? "mixed" : backendSpans > 0 ? "backend-reported" : eventCounted > 0 ? "derived" : "unavailable";
    let recentRate: number | null = null;
    // The trailing window never reaches back before the first event: a session
    // shorter than RECENT_WINDOW_MS is rated over the time actually observed.
    let windowMs = RECENT_WINDOW_MS;
    if (firstNs !== null && lastNs !== null) {
        windowMs = Math.min(RECENT_WINDOW_MS, (lastNs - firstNs) / 1e6);
    }
    if (provenance !== "unavailable" && lastNs !== null && windowMs > 0) {
        const windowStart = lastNs - windowMs * 1e6;
        let recent = counted.filter((x) => x.ns > windowStart).reduce((sum, x) => sum + x.n, 0);
        for (const d of spread) {
            if (d.ns > 0) {
                recent += (d.tokens * overlapNs(d.startNs, d.endNs, windowStart, lastNs)) / d.ns;
            }
        }
        recentRate = recent / (windowMs / 1000);
    }
    return {
        total: fromBackend + fromEvents,
        provenance,
        fromBackend,
        fromEvents,
        chunks,
        uncountedRequests,
        overallRate: decodeNs > 0 ? decodeTokens / (decodeNs / 1e9) : null,
        activeDecodeMs: decodeNs > 0 ? decodeNs / 1e6 : null,
        recentRate,
        windowMs,
        backendReported: backendSpans > 0 ? fromBackend : null,
    };
}

/** Derives metrics from events that are already in replay order. */
export function deriveMetrics(events: readonly ObservatoryEvent[]): Metrics {
    const spans = new Map<string, RequestSpan>();
    const errorsByType: Record<string, number> = {};
    const errorIds: string[] = [];
    const work = new Map<RequestSpan, SpanWork>();
    /** Per-token events that belong to no request span. */
    const looseTokens: TokenTime[] = [];
    let chunkEvents = 0;
    const activeAgents = new Set<string>();
    const activeTools = new Set<string>();
    let spawned = 0;
    let agentsCompleted = 0;
    let agentTransitions = 0;
    let toolsCalled = 0;
    let toolsCompleted = 0;
    let toolsFailed = 0;
    let latest: ResourceSample | null = null;
    let peak: ResourceSample | null = null;
    let pressureEvents = 0;
    let latestCompute: number | null = null;

    for (const e of events) {
        const t = e.event_type;
        const rid = e.request_id ?? null;
        const stream = rid ? streamKey(e) : "";
        const spanKey = rid ? `${stream}\u0001${rid}` : "";

        if (t === "request.started" && rid) {
            const span: RequestSpan = {
                requestId: rid,
                streamKey: stream,
                producer: e.producer.name,
                startNs: e.mono_ns,
                endNs: null,
                outcome: "open",
                firstTokenNs: null,
                tokens: 0,
                chunks: 0,
                backendTokens: null,
                tokenCount: null,
                decode: null,
            };
            spans.set(spanKey, span);
            work.set(span, { tokenTimes: [], evalMs: null, evalEndNs: null, totalMs: null, ttftMs: null });
        } else if (
            (t === "request.completed" || t === "request.failed" || t === "request.cancelled") &&
            rid
        ) {
            const span = spans.get(spanKey);
            if (span && span.endNs === null) {
                span.endNs = e.mono_ns;
                span.outcome =
                    t === "request.completed"
                        ? "completed"
                        : t === "request.failed"
                          ? "failed"
                          : "cancelled";
                span.backendTokens = backendTokenCount(e);
                const w = work.get(span)!;
                w.totalMs = numberAttr(e, "total_ms");
                w.ttftMs = numberAttr(e, "ttft_ms");
            }
        } else if (t === "inference.decode.completed" && rid) {
            const span = spans.get(spanKey);
            const w = span ? work.get(span) : undefined;
            const evalMs = backendEvalMs(e);
            if (w && evalMs !== null) {
                w.evalMs = evalMs;
                w.evalEndNs = e.mono_ns;
            }
        } else if (t === "inference.token.generated") {
            const n = outputTokenCount(e);
            const span = rid ? spans.get(spanKey) : undefined;
            if (n === null) {
                chunkEvents += 1;
            }
            if (span) {
                if (n === null) {
                    span.chunks += 1;
                } else {
                    span.tokens += n;
                    work.get(span)!.tokenTimes.push({ ns: e.mono_ns, n });
                }
                if (span.firstTokenNs === null) {
                    span.firstTokenNs = e.mono_ns;
                }
            } else if (n !== null) {
                looseTokens.push({ ns: e.mono_ns, n });
            }
        }

        if (isErrorEvent(e)) {
            errorsByType[t] = (errorsByType[t] ?? 0) + 1;
            errorIds.push(e.event_id);
        }

        const agent = e.agent_id ?? null;
        if (t.startsWith("agent.") || t.startsWith("route.")) {
            agentTransitions += 1;
        }
        if (agent) {
            if (t === "agent.spawned") {
                spawned += 1;
                activeAgents.add(agent);
            } else if (t === "agent.started") {
                activeAgents.add(agent);
            } else if (t === "agent.completed" || t === "agent.cancelled") {
                if (t === "agent.completed") {
                    agentsCompleted += 1;
                }
                activeAgents.delete(agent);
            }
        }

        const callId =
            typeof e.attributes.tool_call_id === "string"
                ? e.attributes.tool_call_id
                : typeof e.tool_call_id === "string"
                  ? e.tool_call_id
                  : null;
        if (t === "tool.called") {
            toolsCalled += 1;
            if (callId) {
                activeTools.add(callId);
            }
        } else if (t === "tool.completed" || t === "tool.failed") {
            if (t === "tool.completed") {
                toolsCompleted += 1;
            } else {
                toolsFailed += 1;
            }
            if (callId) {
                activeTools.delete(callId);
            }
        }

        if (t === "device.memory.sample") {
            const usage = memoryUsage(e);
            if (usage && usage.usedBytes !== null && usage.totalBytes !== null) {
                const sample: ResourceSample = {
                    monoNs: e.mono_ns,
                    deviceId: e.device_id ?? null,
                    usedBytes: usage.usedBytes,
                    totalBytes: usage.totalBytes,
                    fraction: usage.fraction,
                    eventId: e.event_id,
                };
                latest = sample;
                if (!peak || sample.fraction > peak.fraction) {
                    peak = sample;
                }
            }
        } else if (t === "device.compute.sample") {
            const u = numberAttr(e, "utilization");
            if (u !== null) {
                latestCompute = u;
            }
        }
        if (t === "kv.pressure" || t === "guard.budget_pressure") {
            pressureEvents += 1;
        }
    }

    const requests = [...spans.values()];
    const finished = requests.filter((s) => s.endNs !== null);
    const durationsByProducer = new Map<string, number[]>();
    for (const s of finished) {
        const list = durationsByProducer.get(s.producer) ?? [];
        list.push(s.endNs! - s.startNs);
        durationsByProducer.set(s.producer, list);
    }
    const requestLatencyByProducer: Record<string, LatencyStats> = {};
    for (const [producer, durations] of durationsByProducer) {
        requestLatencyByProducer[producer] = latencyStats(durations);
    }
    const withFirstToken = requests.filter((s) => s.firstTokenNs !== null);

    const tokens = tokenMetrics(requests, work, looseTokens, chunkEvents, events[0]?.mono_ns ?? null, events[events.length - 1]?.mono_ns ?? null);
    return {
        eventCount: events.length,
        requests,
        requestLatency: latencyStats(finished.map((s) => s.endNs! - s.startNs)),
        requestLatencyByProducer,
        timeToFirstToken: latencyStats(withFirstToken.map((s) => s.firstTokenNs! - s.startNs)),
        tokens,
        errors: {
            total: errorIds.length,
            byType: errorsByType,
            eventIds: errorIds,
        },
        agents: {
            active: [...activeAgents],
            spawned,
            completed: agentsCompleted,
            transitions: agentTransitions,
        },
        tools: {
            active: [...activeTools],
            called: toolsCalled,
            completed: toolsCompleted,
            failed: toolsFailed,
        },
        resources: {
            latest,
            peak,
            pressureEvents,
            latestComputeUtilization: latestCompute,
        },
        droppedEvents: totalDroppedEvents(events),
    };
}
