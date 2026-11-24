/**
 * Metric derivation from protocol events. Every metric is "derived" from
 * measured producer events and carries the event ids it was computed from so
 * the inspector can show evidence. Nothing here estimates values that the
 * producer did not report: a metric with no evidence is `null` (unavailable).
 */
import type { ObservatoryEvent } from "../protocol/events";
import { streamKey } from "../replay/order";
import { backendEvalMs, backendTokenCount, outputTokenCount, sumDroppedReports } from "./attributes";
import { isErrorEvent } from "./classify";
import { scopedRequestKey } from "./identity";
import { latencyByProducer, latencyStats, percentile, type LatencyStats } from "./latencyMetrics";
import {
    noteSpanReports,
    promptCacheUse,
    reuseMetrics,
    sessionCreatedModel,
    sessionModelKey,
    speculationUse,
    UNKNOWN_MODEL,
    type PromptCacheMetrics,
    type PromptCacheTotals,
    type PromptCacheUse,
    type SpeculationMetrics,
    type SpeculationTotals,
    type SpeculationUse,
} from "./reuseMetrics";
import {
    cloneCounters,
    newCounters,
    numberAttr,
    stepCounters,
    type ResourceSample,
    type SessionCounters,
} from "./sessionCounters";
import {
    computeTokenMetrics,
    ListTokenSeries,
    RECENT_WINDOW_MS,
    type DecodeSource,
    type DecodeWindow,
    type SpanWork,
    type TokenMetrics,
    type TokenProvenance,
    type TokenSeries,
    type TokenTime,
} from "./tokenMetrics";

export {
    cloneCounters,
    newCounters,
    noteSpanReports,
    percentile,
    promptCacheUse,
    RECENT_WINDOW_MS,
    sessionCreatedModel,
    sessionModelKey,
    speculationUse,
    stepCounters,
    UNKNOWN_MODEL,
};
export type {
    DecodeSource,
    DecodeWindow,
    LatencyStats,
    PromptCacheTotals,
    PromptCacheUse,
    ResourceSample,
    SessionCounters,
    SpanWork,
    SpeculationTotals,
    SpeculationUse,
    TokenProvenance,
    TokenSeries,
};

export type Provenance = "measured" | "backend-reported" | "derived" | "estimated" | "unavailable";

export interface RequestSpan {
    requestId: string;
    /**
     * Opaque canonical producer stream identity (see replay/order streamKey).
     * Exported in report JSON; its representation is not a producer ID or label.
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
    /** session_id of the request.started event (additive). */
    sessionId: string;
    /**
     * Model the request ran on (additive), best first: the first string
     * `model` attribute on an event of the request (for example
     * `backend.timing.prefill`), the `model` of the first `session.created`
     * of the same stream and session, the request.started `model_instance_id`;
     * null when none is reported.
     */
    model: string | null;
    /** Latest backend prompt-cache report of the request (additive); null when none. */
    promptCache: PromptCacheUse | null;
    /** Latest backend speculative-decoding report of the request (additive); null when none. */
    speculation: SpeculationUse | null;
}

export interface Metrics {
    eventCount: number;
    requests: RequestSpan[];
    requestLatency: LatencyStats;
    /** Finished-request latency per producer.name (additive). */
    requestLatencyByProducer: Record<string, LatencyStats>;
    timeToFirstToken: LatencyStats;
    tokens: TokenMetrics;
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
    /**
     * Backend prompt-cache reuse (additive): totals over requests with a
     * report, per model and per session_id, plus the reporting event ids.
     */
    promptCache: PromptCacheMetrics;
    /** Backend speculative-decoding acceptance (additive), grouped as promptCache. */
    speculation: SpeculationMetrics;
}

/** What deriveMetrics (or the incremental index) collected over a prefix, before the summary statistics. */
export interface MetricsParts {
    eventCount: number;
    /** Request spans in first-start order; tokenCount and decode are filled in here. */
    requests: RequestSpan[];
    workOf: (span: RequestSpan) => SpanWork;
    /** Per-token events that belong to no request span. */
    looseTokens: TokenSeries;
    chunkEvents: number;
    firstNs: number | null;
    lastNs: number | null;
    errorsByType: Record<string, number>;
    errorIds: string[];
    counters: SessionCounters;
}

/** The summary statistics shared by deriveMetrics and the incremental index. */
export function assembleMetrics(p: MetricsParts): Metrics {
    const { requests, counters: c } = p;
    const finished = requests.filter((s) => s.endNs !== null);
    const requestLatencyByProducer = latencyByProducer(finished);
    const withFirstToken = requests.filter((s) => s.firstTokenNs !== null);

    const tokens = computeTokenMetrics(requests, p.workOf, p.looseTokens, p.chunkEvents, p.firstNs, p.lastNs);
    return {
        eventCount: p.eventCount,
        requests,
        requestLatency: latencyStats(finished.map((s) => s.endNs! - s.startNs)),
        requestLatencyByProducer,
        timeToFirstToken: latencyStats(withFirstToken.map((s) => s.firstTokenNs! - s.startNs)),
        tokens,
        errors: {
            total: p.errorIds.length,
            byType: p.errorsByType,
            eventIds: p.errorIds,
        },
        agents: {
            active: [...c.activeAgents],
            spawned: c.spawned,
            completed: c.agentsCompleted,
            transitions: c.agentTransitions,
        },
        tools: {
            active: [...c.activeTools],
            called: c.toolsCalled,
            completed: c.toolsCompleted,
            failed: c.toolsFailed,
        },
        resources: {
            latest: c.latest,
            peak: c.peak,
            pressureEvents: c.pressureEvents,
            latestComputeUtilization: c.latestCompute,
        },
        droppedEvents: sumDroppedReports(c.dropped),
        ...reuseMetrics(requests),
    };
}

/**
 * Derives metrics from events that are already in replay order. For a replay
 * cursor over a large session use metricsAt (metricsIndex.ts), which returns
 * the same result for a prefix without rescanning it.
 */
export function deriveMetrics(events: readonly ObservatoryEvent[]): Metrics {
    const spans = new Map<string, RequestSpan>();
    const errorsByType: Record<string, number> = {};
    const errorIds: string[] = [];
    const work = new Map<RequestSpan, SpanWork>();
    const tokenTimes = new Map<RequestSpan, TokenTime[]>();
    /** Per-token events that belong to no request span. */
    const looseTokens: TokenTime[] = [];
    let chunkEvents = 0;
    const counters = newCounters();
    /** Model sources of each span, resolved after the loop (see RequestSpan.model). */
    const spanModels = new Map<RequestSpan, { attr: string | null; envelope: string | null; sessionKey: string }>();
    /** First session.created model per stream and session. */
    const sessionModels = new Map<string, string>();

    for (const e of events) {
        const t = e.event_type;
        const rid = e.request_id ?? null;
        const stream = rid ? streamKey(e) : "";
        const spanKey = rid ? scopedRequestKey(stream, rid) : "";

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
                sessionId: e.session_id,
                model: null,
                promptCache: null,
                speculation: null,
            };
            spanModels.set(span, {
                attr: null,
                envelope: typeof e.model_instance_id === "string" && e.model_instance_id !== "" ? e.model_instance_id : null,
                sessionKey: sessionModelKey(stream, e.session_id),
            });
            spans.set(spanKey, span);
            const times: TokenTime[] = [];
            tokenTimes.set(span, times);
            work.set(span, { tokens: new ListTokenSeries(times), evalMs: null, evalEndNs: null, totalMs: null, ttftMs: null });
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
                    tokenTimes.get(span)!.push({ ns: e.mono_ns, n });
                }
                if (span.firstTokenNs === null) {
                    span.firstTokenNs = e.mono_ns;
                }
            } else if (n !== null) {
                looseTokens.push({ ns: e.mono_ns, n });
            }
        }

        if (rid && t !== "inference.token.generated") {
            // Most events carry no report: read the attributes before the span lookup.
            const reports = noteSpanReports(e);
            const span = reports ? spans.get(spanKey) : undefined;
            if (span && reports) {
                const models = spanModels.get(span)!;
                if (models.attr === null && reports.model !== null) {
                    models.attr = reports.model;
                }
                if (reports.cache) {
                    span.promptCache = reports.cache;
                }
                if (reports.spec) {
                    span.speculation = reports.spec;
                }
            }
        }
        if (t === "session.created") {
            const model = sessionCreatedModel(e);
            const key = model !== null ? sessionModelKey(streamKey(e), e.session_id) : "";
            if (model !== null && !sessionModels.has(key)) {
                sessionModels.set(key, model);
            }
        }

        if (isErrorEvent(e)) {
            errorsByType[t] = (errorsByType[t] ?? 0) + 1;
            errorIds.push(e.event_id);
        }

        stepCounters(counters, e);
    }

    for (const [span, models] of spanModels) {
        span.model = models.attr ?? sessionModels.get(models.sessionKey) ?? models.envelope;
    }

    return assembleMetrics({
        eventCount: events.length,
        requests: [...spans.values()],
        workOf: (span) => work.get(span)!,
        looseTokens: new ListTokenSeries(looseTokens),
        chunkEvents,
        firstNs: events[0]?.mono_ns ?? null,
        lastNs: events[events.length - 1]?.mono_ns ?? null,
        errorsByType,
        errorIds,
        counters,
    });
}
