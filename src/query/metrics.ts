/**
 * Metric derivation from protocol events. Every metric is "derived" from
 * measured producer events and carries the event ids it was computed from so
 * the inspector can show evidence. Nothing here estimates values that the
 * producer did not report: a metric with no evidence is `null` (unavailable).
 */
import type { ObservatoryEvent } from "../protocol/events";
import { backendEvalMs, backendTokenCount, outputTokenCount, sumDroppedReports } from "./attributes";
import { isErrorEvent } from "./classify";
import {
    deriveExecutionRoutes,
    isExecutionRouteEvent,
    parseExecutionRoute,
    type DifficultyBand,
    type ExecutionMode,
    type ExecutionRouteRecord,
} from "./executionRoute";
import { createIdentityKeys } from "./identity";
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

/** How a RequestSpan's start timestamp was established. */
export type RequestStartSource = "started" | "queued" | "reported-duration" | "outcome-only";

/** Execution-route metadata attributed to a request span (additive). */
export interface RequestExecutionRoute {
    mode: ExecutionMode;
    band: DifficultyBand | null;
    difficultyScore: number | null;
    recommendedTiers: string[];
    ensembleMode: string | null;
    fanoutScope: string | null;
    autoSelected: boolean | null;
    participantCount: number | null;
    eventId: string;
}

/** Execution-route counts and finished-request latency breakdown (additive). */
export interface ExecutionRouteBreakdown {
    total: number;
    byMode: Record<ExecutionMode, number>;
    byBand: Record<DifficultyBand, number>;
    autoCount: number;
    manualCount: number;
    latencyByMode: Partial<Record<ExecutionMode, LatencyStats>>;
    latencyByBand: Partial<Record<DifficultyBand, LatencyStats>>;
}

export type OrchestrationKind = "fanout" | "ensemble";

/** Lifecycle span of a `fanout.*` or `ensemble.*` multi-worker orchestration (additive). */
export interface OrchestrationSpan {
    kind: OrchestrationKind;
    spanId: string;
    streamKey: string;
    producer: string;
    requestId: string | null;
    runId: string | null;
    sessionId: string;
    startNs: number;
    endNs: number | null;
    /** Measured or producer-reported duration (ms); null when open or unmeasurable. */
    durationMs: number | null;
    outcome: "completed" | "failed" | "cancelled" | "open";
    participantCount: number | null;
    participantsStarted: number;
    participantsCompleted: number;
    participantsFailed: number;
    participantsCancelled: number;
    scopeOrMode: string | null;
    tiers: string[];
    eventCount: number;
    eventIds: string[];
}

export interface OrchestrationKindSummary {
    total: number;
    open: number;
    completed: number;
    failed: number;
    cancelled: number;
    latency: LatencyStats;
}

export interface OrchestrationMetrics {
    spans: OrchestrationSpan[];
    fanout: OrchestrationKindSummary;
    ensemble: OrchestrationKindSummary;
}

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
    /** Request kind/operation reported by the producer (e.g. "embed", "chat", "generate"), if any (additive). */
    requestKind: string | null;
    /** How startNs was established ("started" normally, or fallback for older /v1/embeddings servers) (additive). */
    startSource: RequestStartSource;
    /** Latest execution_route / execution_mode attributed to this request (additive); null when absent. */
    executionRoute: RequestExecutionRoute | null;
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
    /** Execution-route breakdown by mode/band and finished-request latency (additive). */
    executionRoutes: ExecutionRouteBreakdown;
    /** Multi-worker `fanout.*` and `ensemble.*` orchestration spans and latency summaries (additive). */
    orchestration: OrchestrationMetrics;
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
    /** Sparse subset of events passing `isExecutionRouteEvent` (optional for legacy callers). */
    routeEvents?: readonly ObservatoryEvent[];
    /** Sparse subset of events passing `isOrchestrationEvent` (optional for legacy callers). */
    orchestrationEvents?: readonly ObservatoryEvent[];
}

const EMPTY_TOKEN_SERIES: TokenSeries = new ListTokenSeries([]);
const EMPTY_SPAN_WORK: SpanWork = Object.freeze({
    tokens: EMPTY_TOKEN_SERIES,
    evalMs: null,
    evalEndNs: null,
    totalMs: null,
    ttftMs: null,
});

function nonEmptyText(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function finiteNonNegative(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function positiveInt(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function boundedStrings(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const out: string[] = [];
    for (const item of value) {
        const s = nonEmptyText(item);
        if (s !== null) {
            out.push(s);
            if (out.length >= 16) {
                break;
            }
        }
    }
    return out;
}

/**
 * True when an event describes a `/v1/embeddings` request.
 * Older Sonder-Inference servers (`Session::embed`) emitted `request.queued` ->
 * `request.completed`/`failed`/`cancelled` with `kind: "embed"` and omitted
 * `request.started`; recognizing these events keeps embeddings visible in
 * RequestSpan and latency metrics without turning unknown ghost completions into spans.
 */
export function isEmbeddingRequestEvent(event: ObservatoryEvent): boolean {
    const a = event.attributes;
    const kind = typeof a.kind === "string" ? a.kind.toLowerCase() : null;
    if (kind === "embed" || kind === "embedding" || kind === "embeddings") {
        return true;
    }
    const op = typeof a.operation === "string" ? a.operation.toLowerCase() : null;
    if (op === "embed" || op === "embedding" || op === "embeddings") {
        return true;
    }
    const endpoint = typeof a.endpoint === "string" ? a.endpoint.toLowerCase() : null;
    if (endpoint === "/v1/embeddings" || endpoint === "/api/embed" || endpoint === "/api/embeddings") {
        return true;
    }
    const surface = typeof a.surface === "string" ? a.surface.toLowerCase() : null;
    return surface === "http.embeddings";
}

/** Producer-reported request kind/operation ("embed", "chat", "generate", ...), or null. */
export function requestKindOf(event: ObservatoryEvent): string | null {
    if (isEmbeddingRequestEvent(event)) {
        return "embed";
    }
    const a = event.attributes;
    return nonEmptyText(a.kind) ?? nonEmptyText(a.operation);
}

/** Reported duration (ms) for fallback span reconstruction on outcome-only events. */
export function reportedRequestDurationMs(event: ObservatoryEvent): number | null {
    return finiteNonNegative(event.attributes.total_ms) ?? finiteNonNegative(event.attributes.duration_ms);
}

/** Fast O(1) check for `fanout.*` and `ensemble.*` orchestration events. */
export function isOrchestrationEvent(event: ObservatoryEvent): boolean {
    const t = event.event_type;
    const c = t.charCodeAt(0);
    return (c === 102 /* f */ && t.startsWith("fanout.")) || (c === 101 /* e */ && t.startsWith("ensemble."));
}

export function requestRouteFromRecord(record: ExecutionRouteRecord): RequestExecutionRoute {
    return {
        mode: record.mode,
        band: record.band,
        difficultyScore: record.difficultyScore,
        recommendedTiers: record.recommendedTiers,
        ensembleMode: record.ensembleMode,
        fanoutScope: record.fanoutScope,
        autoSelected: record.autoSelected,
        participantCount: record.participantCount,
        eventId: record.eventId,
    };
}

export function mergeRequestExecutionRoute(
    prev: RequestExecutionRoute | null,
    next: RequestExecutionRoute,
): RequestExecutionRoute {
    if (!prev) {
        return next;
    }
    return {
        mode: next.mode,
        band: next.band ?? prev.band,
        difficultyScore: next.difficultyScore ?? prev.difficultyScore,
        recommendedTiers: next.recommendedTiers.length > 0 ? next.recommendedTiers : prev.recommendedTiers,
        ensembleMode: next.ensembleMode ?? prev.ensembleMode,
        fanoutScope: next.fanoutScope ?? prev.fanoutScope,
        autoSelected: next.autoSelected ?? prev.autoSelected,
        participantCount: next.participantCount ?? prev.participantCount,
        eventId: next.eventId,
    };
}

const PARTICIPANT_SEGMENTS: ReadonlySet<string> = new Set([
    "worker",
    "candidate",
    "branch",
    "shard",
    "member",
    "task",
]);

function orchestrationPhase(eventType: string): {
    kind: OrchestrationKind;
    role: "start" | "completed" | "failed" | "cancelled" | "participant_start" | "participant_completed" | "participant_failed" | "participant_cancelled" | "progress";
} | null {
    let kind: OrchestrationKind;
    let rest: string;
    if (eventType.startsWith("fanout.")) {
        kind = "fanout";
        rest = eventType.slice(7);
    } else if (eventType.startsWith("ensemble.")) {
        kind = "ensemble";
        rest = eventType.slice(9);
    } else {
        return null;
    }
    if (rest === "started" || rest === "run.started" || rest === "dispatched") {
        return { kind, role: "start" };
    }
    if (rest === "completed" || rest === "run.completed") {
        return { kind, role: "completed" };
    }
    if (rest === "failed" || rest === "run.failed") {
        return { kind, role: "failed" };
    }
    if (rest === "cancelled" || rest === "run.cancelled" || rest === "aborted") {
        return { kind, role: "cancelled" };
    }
    const dot = rest.indexOf(".");
    if (dot > 0) {
        const sub = rest.slice(0, dot);
        const action = rest.slice(dot + 1);
        if (PARTICIPANT_SEGMENTS.has(sub)) {
            if (action === "started" || action === "dispatched") {
                return { kind, role: "participant_start" };
            }
            if (action === "completed") {
                return { kind, role: "participant_completed" };
            }
            if (action === "failed") {
                return { kind, role: "participant_failed" };
            }
            if (action === "cancelled" || action === "aborted") {
                return { kind, role: "participant_cancelled" };
            }
        }
    }
    return { kind, role: "progress" };
}

function orchestrationSpanId(event: ObservatoryEvent, kind: OrchestrationKind): string {
    const a = event.attributes;
    const nested = asObject(kind === "fanout" ? a.fanout : a.ensemble);
    return (
        (kind === "fanout"
            ? nonEmptyText(a.fanout_run_id) ?? nonEmptyText(a.fanout_id) ?? nonEmptyText(nested?.run_id) ?? nonEmptyText(nested?.id)
            : nonEmptyText(a.ensemble_run_id) ?? nonEmptyText(a.ensemble_id) ?? nonEmptyText(nested?.run_id) ?? nonEmptyText(nested?.id)) ??
        nonEmptyText(event.request_id) ??
        nonEmptyText(event.run_id) ??
        nonEmptyText(a.batch_job_id) ??
        event.event_id
    );
}

function extractOrchestrationMeta(event: ObservatoryEvent, kind: OrchestrationKind): {
    participantCount: number | null;
    scopeOrMode: string | null;
    tiers: string[];
} {
    const a = event.attributes;
    const nested = asObject(kind === "fanout" ? a.fanout : a.ensemble);
    const routeObj = asObject(a.execution_route);
    const tiers =
        boundedStrings(nested?.tiers).length > 0
            ? boundedStrings(nested?.tiers)
            : boundedStrings(routeObj?.recommended_tiers).length > 0
              ? boundedStrings(routeObj?.recommended_tiers)
              : boundedStrings(a.recommended_tiers).length > 0
                ? boundedStrings(a.recommended_tiers)
                : boundedStrings(a.tiers);
    const models = boundedStrings(nested?.models);
    const participantCount =
        positiveInt(nested?.workers) ??
        positiveInt(nested?.count) ??
        positiveInt(a.worker_count) ??
        positiveInt(a.candidate_count) ??
        (models.length > 0 ? models.length : null);
    const scopeOrMode =
        kind === "fanout"
            ? nonEmptyText(nested?.scope) ?? nonEmptyText(a.fanout_scope) ?? nonEmptyText(routeObj?.fanout_scope)
            : nonEmptyText(nested?.mode) ?? nonEmptyText(a.ensemble_mode) ?? nonEmptyText(routeObj?.ensemble_mode);
    return { participantCount, scopeOrMode, tiers };
}

function summarizeOrchestrationKind(spans: readonly OrchestrationSpan[], kind: OrchestrationKind): OrchestrationKindSummary {
    let total = 0;
    let open = 0;
    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    const durationsNs: number[] = [];
    for (const s of spans) {
        if (s.kind !== kind) {
            continue;
        }
        total += 1;
        if (s.outcome === "open") {
            open += 1;
        } else if (s.outcome === "completed") {
            completed += 1;
        } else if (s.outcome === "failed") {
            failed += 1;
        } else {
            cancelled += 1;
        }
        if (s.durationMs !== null) {
            durationsNs.push(s.durationMs * 1e6);
        }
    }
    return { total, open, completed, failed, cancelled, latency: latencyStats(durationsNs) };
}

/** Derives `fanout.*` and `ensemble.*` orchestration spans and latency summaries in replay order. */
export function deriveOrchestrationMetrics(events: readonly ObservatoryEvent[]): OrchestrationMetrics {
    if (events.length === 0) {
        const empty = (): OrchestrationKindSummary => ({
            total: 0,
            open: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
            latency: latencyStats([]),
        });
        return { spans: [], fanout: empty(), ensemble: empty() };
    }
    const idKeys = createIdentityKeys();
    const spans: OrchestrationSpan[] = [];
    const activeByKey = new Map<string, OrchestrationSpan>();
    const closedKeys = new Set<string>();

    const applyMeta = (span: OrchestrationSpan, e: ObservatoryEvent, kind: OrchestrationKind): void => {
        const meta = extractOrchestrationMeta(e, kind);
        if (meta.participantCount !== null) {
            span.participantCount = meta.participantCount;
        }
        if (meta.scopeOrMode !== null) {
            span.scopeOrMode = meta.scopeOrMode;
        }
        if (meta.tiers.length > 0) {
            span.tiers = meta.tiers;
        }
        span.requestId ??= nonEmptyText(e.request_id);
        span.runId ??= nonEmptyText(e.run_id);
        span.eventCount += 1;
        span.eventIds.push(e.event_id);
    };

    const openSpan = (e: ObservatoryEvent, kind: OrchestrationKind, stream: string, spanId: string): OrchestrationSpan => {
        const meta = extractOrchestrationMeta(e, kind);
        const span: OrchestrationSpan = {
            kind,
            spanId,
            streamKey: stream,
            producer: e.producer.name,
            requestId: nonEmptyText(e.request_id),
            runId: nonEmptyText(e.run_id),
            sessionId: e.session_id,
            startNs: e.mono_ns,
            endNs: null,
            durationMs: null,
            outcome: "open",
            participantCount: meta.participantCount,
            participantsStarted: 0,
            participantsCompleted: 0,
            participantsFailed: 0,
            participantsCancelled: 0,
            scopeOrMode: meta.scopeOrMode,
            tiers: meta.tiers,
            eventCount: 1,
            eventIds: [e.event_id],
        };
        spans.push(span);
        return span;
    };

    for (const e of events) {
        const parsed = orchestrationPhase(e.event_type);
        if (!parsed) {
            continue;
        }
        const { kind, role } = parsed;
        const stream = idKeys.stream(e);
        const spanId = orchestrationSpanId(e, kind);
        const mapKey = `${kind}\0${stream}\0${spanId}`;
        let active = activeByKey.get(mapKey);

        if (role === "start") {
            closedKeys.delete(mapKey);
            const span = openSpan(e, kind, stream, spanId);
            activeByKey.set(mapKey, span);
        } else if (role === "completed" || role === "failed" || role === "cancelled") {
            if (active) {
                active.endNs = e.mono_ns;
                active.outcome = role;
                const reportedMs = reportedRequestDurationMs(e);
                active.durationMs =
                    e.mono_ns >= active.startNs ? (e.mono_ns - active.startNs) / 1e6 : reportedMs;
                applyMeta(active, e, kind);
                activeByKey.delete(mapKey);
                closedKeys.add(mapKey);
            } else if (!closedKeys.has(mapKey)) {
                const reportedMs = reportedRequestDurationMs(e);
                const span = openSpan(e, kind, stream, spanId);
                span.startNs = reportedMs !== null ? Math.max(0, e.mono_ns - Math.round(reportedMs * 1e6)) : e.mono_ns;
                span.endNs = e.mono_ns;
                span.durationMs = reportedMs;
                span.outcome = role;
                closedKeys.add(mapKey);
            }
        } else {
            if (!active) {
                if (closedKeys.has(mapKey)) {
                    continue;
                }
                active = openSpan(e, kind, stream, spanId);
                activeByKey.set(mapKey, active);
            } else {
                applyMeta(active, e, kind);
            }
            if (role === "participant_start") {
                active.participantsStarted += 1;
            } else if (role === "participant_completed") {
                active.participantsCompleted += 1;
            } else if (role === "participant_failed") {
                active.participantsFailed += 1;
            } else if (role === "participant_cancelled") {
                active.participantsCancelled += 1;
            }
        }
    }

    return {
        spans,
        fanout: summarizeOrchestrationKind(spans, "fanout"),
        ensemble: summarizeOrchestrationKind(spans, "ensemble"),
    };
}

function buildExecutionRouteBreakdown(
    routeEvents: readonly ObservatoryEvent[] | undefined,
    finished: readonly RequestSpan[],
): ExecutionRouteBreakdown {
    const byModeDurations = new Map<ExecutionMode, number[]>();
    const byBandDurations = new Map<DifficultyBand, number[]>();
    for (const s of finished) {
        const route = s.executionRoute;
        if (!route) {
            continue;
        }
        const dur = s.endNs! - s.startNs;
        let mList = byModeDurations.get(route.mode);
        if (!mList) {
            mList = [];
            byModeDurations.set(route.mode, mList);
        }
        mList.push(dur);
        if (route.band) {
            let bList = byBandDurations.get(route.band);
            if (!bList) {
                bList = [];
                byBandDurations.set(route.band, bList);
            }
            bList.push(dur);
        }
    }
    const latencyByMode: Partial<Record<ExecutionMode, LatencyStats>> = {};
    for (const [mode, durs] of byModeDurations) {
        latencyByMode[mode] = latencyStats(durs);
    }
    const latencyByBand: Partial<Record<DifficultyBand, LatencyStats>> = {};
    for (const [band, durs] of byBandDurations) {
        latencyByBand[band] = latencyStats(durs);
    }

    if (!routeEvents || routeEvents.length === 0) {
        return {
            total: 0,
            byMode: { single: 0, ensemble: 0, fanout: 0, agent: 0 },
            byBand: { quick: 0, standard: 0, hard: 0, multi_scope: 0 },
            autoCount: 0,
            manualCount: 0,
            latencyByMode,
            latencyByBand,
        };
    }

    const derived = deriveExecutionRoutes(routeEvents);
    return {
        total: derived.total,
        byMode: { ...derived.byMode },
        byBand: { ...derived.byBand },
        autoCount: derived.autoCount,
        manualCount: derived.manualCount,
        latencyByMode,
        latencyByBand,
    };
}

/** The summary statistics shared by deriveMetrics and the incremental index. */
export function assembleMetrics(p: MetricsParts): Metrics {
    const { requests, counters: c } = p;
    const finished: RequestSpan[] = [];
    const finishedDurations: number[] = [];
    const ttftDurations: number[] = [];
    for (const s of requests) {
        if (s.endNs !== null && s.startSource !== "outcome-only") {
            finished.push(s);
            finishedDurations.push(s.endNs - s.startNs);
        }
        if (s.firstTokenNs !== null) {
            ttftDurations.push(s.firstTokenNs - s.startNs);
        }
    }
    const requestLatencyByProducer = latencyByProducer(finished);

    const tokens = computeTokenMetrics(requests, p.workOf, p.looseTokens, p.chunkEvents, p.firstNs, p.lastNs);
    return {
        eventCount: p.eventCount,
        requests,
        requestLatency: latencyStats(finishedDurations),
        requestLatencyByProducer,
        timeToFirstToken: latencyStats(ttftDurations),
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
        executionRoutes: buildExecutionRouteBreakdown(p.routeEvents, finished),
        orchestration: deriveOrchestrationMetrics(p.orchestrationEvents ?? []),
    };
}

/**
 * Derives metrics from events that are already in replay order. For a replay
 * cursor over a large session use metricsAt (metricsIndex.ts), which returns
 * the same result for a prefix without rescanning it.
 */
export function deriveMetrics(events: readonly ObservatoryEvent[]): Metrics {
    const idKeys = createIdentityKeys();
    const spanList: RequestSpan[] = [];
    const spanWorkList: (SpanWork | null)[] = [];
    const spanTokenLists: (TokenTime[] | null)[] = [];
    const spanAttrModels: (string | null)[] = [];
    const spanEnvModels: (string | null)[] = [];
    const spanSessionKeys: string[] = [];
    /** Two-level index (stream -> request_id -> slot in spanList) preserves exact first-start insertion order without JSON.stringify per event. */
    const spanIndexByStream = new Map<string, Map<string, number>>();
    /** Execution-route reports that arrived for a (stream, request_id) before its first span opened. */
    let preStartRoutes: Map<string, Map<string, RequestExecutionRoute>> | null = null;

    const errorsByType: Record<string, number> = {};
    const errorIds: string[] = [];
    /** Per-token events that belong to no request span. */
    const looseTokens: TokenTime[] = [];
    let chunkEvents = 0;
    const counters = newCounters();
    /** First session.created model per stream and session. */
    const sessionModels = new Map<string, string>();
    const routeEvents: ObservatoryEvent[] = [];
    const orchestrationEvents: ObservatoryEvent[] = [];

    const lookupSpanIndex = (stream: string, rid: string): number => {
        const byRid = spanIndexByStream.get(stream);
        return byRid === undefined ? -1 : (byRid.get(rid) ?? -1);
    };

    const ensureSpanWork = (idx: number): SpanWork => {
        let w = spanWorkList[idx];
        if (!w) {
            w = { tokens: EMPTY_TOKEN_SERIES, evalMs: null, evalEndNs: null, totalMs: null, ttftMs: null };
            spanWorkList[idx] = w;
        }
        return w;
    };

    const takePreStartRoute = (stream: string, rid: string): RequestExecutionRoute | null => {
        const byRid = preStartRoutes?.get(stream);
        if (!byRid) {
            return null;
        }
        const route = byRid.get(rid) ?? null;
        if (route !== null) {
            byRid.delete(rid);
        }
        return route;
    };

    const putSpan = (
        stream: string,
        rid: string,
        span: RequestSpan,
        workEntry: SpanWork | null,
        attrModel: string | null,
        envModel: string | null,
        sessionKey: string,
    ): number => {
        let byRid = spanIndexByStream.get(stream);
        if (!byRid) {
            byRid = new Map<string, number>();
            spanIndexByStream.set(stream, byRid);
        }
        const existingIdx = byRid.get(rid);
        if (existingIdx !== undefined) {
            spanList[existingIdx] = span;
            spanWorkList[existingIdx] = workEntry;
            spanTokenLists[existingIdx] = null;
            spanAttrModels[existingIdx] = attrModel;
            spanEnvModels[existingIdx] = envModel;
            spanSessionKeys[existingIdx] = sessionKey;
            return existingIdx;
        }
        const idx = spanList.length;
        spanList.push(span);
        spanWorkList.push(workEntry);
        spanTokenLists.push(null);
        spanAttrModels.push(attrModel);
        spanEnvModels.push(envModel);
        spanSessionKeys.push(sessionKey);
        byRid.set(rid, idx);
        return idx;
    };

    for (const e of events) {
        const t = e.event_type;
        const rid = e.request_id ?? null;
        const stream = rid ? idKeys.stream(e) : "";
        let spanIdx = rid ? lookupSpanIndex(stream, rid) : -1;

        if (t === "request.queued" && rid && isEmbeddingRequestEvent(e)) {
            const existing = spanIdx >= 0 ? spanList[spanIdx]! : undefined;
            if (!existing || existing.endNs !== null) {
                const pendingRoute = spanIdx < 0 ? takePreStartRoute(stream, rid) : null;
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
                    requestKind: "embed",
                    startSource: "queued",
                    executionRoute: pendingRoute,
                };
                spanIdx = putSpan(
                    stream,
                    rid,
                    span,
                    null,
                    null,
                    typeof e.model_instance_id === "string" && e.model_instance_id !== "" ? e.model_instance_id : null,
                    idKeys.session(stream, e.session_id),
                );
            }
        } else if (t === "request.started" && rid) {
            const existing = spanIdx >= 0 ? spanList[spanIdx]! : undefined;
            const upgradingQueued = existing !== undefined && existing.startSource === "queued" && existing.endNs === null;
            const pendingRoute = upgradingQueued
                ? existing.executionRoute
                : spanIdx < 0
                  ? takePreStartRoute(stream, rid)
                  : null;
            const envelopeModel =
                typeof e.model_instance_id === "string" && e.model_instance_id !== ""
                    ? e.model_instance_id
                    : upgradingQueued
                      ? spanEnvModels[spanIdx]!
                      : null;
            const inheritedAttr = upgradingQueued ? spanAttrModels[spanIdx]! : null;
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
                requestKind: requestKindOf(e) ?? (upgradingQueued ? existing.requestKind : null),
                startSource: "started",
                executionRoute: pendingRoute,
            };
            spanIdx = putSpan(
                stream,
                rid,
                span,
                null,
                inheritedAttr,
                envelopeModel,
                idKeys.session(stream, e.session_id),
            );
        } else if (
            (t === "request.completed" || t === "request.failed" || t === "request.cancelled") &&
            rid
        ) {
            const outcome: RequestSpan["outcome"] =
                t === "request.completed" ? "completed" : t === "request.failed" ? "failed" : "cancelled";
            if (spanIdx >= 0) {
                const span = spanList[spanIdx]!;
                if (span.endNs === null) {
                    span.endNs = e.mono_ns;
                    span.outcome = outcome;
                    span.backendTokens = backendTokenCount(e);
                    span.requestKind ??= requestKindOf(e);
                    const totalMs = numberAttr(e, "total_ms");
                    const ttftMs = numberAttr(e, "ttft_ms");
                    if (totalMs !== null || ttftMs !== null) {
                        const w = ensureSpanWork(spanIdx);
                        w.totalMs = totalMs;
                        w.ttftMs = ttftMs;
                    }
                }
            } else if (isEmbeddingRequestEvent(e)) {
                const reportedMs = reportedRequestDurationMs(e);
                const startNs = reportedMs !== null ? Math.max(0, e.mono_ns - Math.round(reportedMs * 1e6)) : e.mono_ns;
                const startSource: RequestStartSource = reportedMs !== null ? "reported-duration" : "outcome-only";
                const pendingRoute = takePreStartRoute(stream, rid);
                const totalMs = numberAttr(e, "total_ms");
                const ttftMs = numberAttr(e, "ttft_ms");
                const span: RequestSpan = {
                    requestId: rid,
                    streamKey: stream,
                    producer: e.producer.name,
                    startNs,
                    endNs: e.mono_ns,
                    outcome,
                    firstTokenNs: null,
                    tokens: 0,
                    chunks: 0,
                    backendTokens: backendTokenCount(e),
                    tokenCount: null,
                    decode: null,
                    sessionId: e.session_id,
                    model: null,
                    promptCache: null,
                    speculation: null,
                    requestKind: "embed",
                    startSource,
                    executionRoute: pendingRoute,
                };
                spanIdx = putSpan(
                    stream,
                    rid,
                    span,
                    totalMs !== null || ttftMs !== null
                        ? { tokens: EMPTY_TOKEN_SERIES, evalMs: null, evalEndNs: null, totalMs, ttftMs }
                        : null,
                    null,
                    typeof e.model_instance_id === "string" && e.model_instance_id !== "" ? e.model_instance_id : null,
                    idKeys.session(stream, e.session_id),
                );
            }
        } else if (t === "inference.decode.completed" && rid) {
            if (spanIdx >= 0) {
                const evalMs = backendEvalMs(e);
                if (evalMs !== null) {
                    const w = ensureSpanWork(spanIdx);
                    w.evalMs = evalMs;
                    w.evalEndNs = e.mono_ns;
                }
            }
        } else if (t === "inference.token.generated") {
            const n = outputTokenCount(e);
            if (n === null) {
                chunkEvents += 1;
            }
            if (spanIdx >= 0) {
                const span = spanList[spanIdx]!;
                if (n === null) {
                    span.chunks += 1;
                } else {
                    span.tokens += n;
                    let times = spanTokenLists[spanIdx];
                    if (!times) {
                        times = [];
                        spanTokenLists[spanIdx] = times;
                        ensureSpanWork(spanIdx).tokens = new ListTokenSeries(times);
                    }
                    times.push({ ns: e.mono_ns, n });
                }
                if (span.firstTokenNs === null) {
                    span.firstTokenNs = e.mono_ns;
                }
            } else if (n !== null) {
                looseTokens.push({ ns: e.mono_ns, n });
            }
        }

        if (isExecutionRouteEvent(e)) {
            routeEvents.push(e);
            if (rid) {
                const parsedRoute = parseExecutionRoute(e);
                if (parsedRoute) {
                    const reqRoute = requestRouteFromRecord(parsedRoute);
                    if (spanIdx >= 0) {
                        const span = spanList[spanIdx]!;
                        span.executionRoute = mergeRequestExecutionRoute(span.executionRoute, reqRoute);
                    } else {
                        preStartRoutes ??= new Map();
                        let byRid = preStartRoutes.get(stream);
                        if (!byRid) {
                            byRid = new Map();
                            preStartRoutes.set(stream, byRid);
                        }
                        byRid.set(rid, mergeRequestExecutionRoute(byRid.get(rid) ?? null, reqRoute));
                    }
                }
            }
        }
        if (isOrchestrationEvent(e)) {
            orchestrationEvents.push(e);
        }

        if (rid && t !== "inference.token.generated") {
            // Most events carry no report: read the attributes before updating the span.
            const reports = spanIdx >= 0 ? noteSpanReports(e) : null;
            if (reports) {
                const span = spanList[spanIdx]!;
                if (spanAttrModels[spanIdx] === null && reports.model !== null) {
                    spanAttrModels[spanIdx] = reports.model;
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
            if (model !== null) {
                const key = idKeys.session(idKeys.stream(e), e.session_id);
                if (!sessionModels.has(key)) {
                    sessionModels.set(key, model);
                }
            }
        }

        if (isErrorEvent(e)) {
            errorsByType[t] = (errorsByType[t] ?? 0) + 1;
            errorIds.push(e.event_id);
        }

        stepCounters(counters, e);
    }

    const hasSessionModels = sessionModels.size > 0;
    for (let idx = 0; idx < spanList.length; idx += 1) {
        const attrModel = spanAttrModels[idx];
        const envModel = spanEnvModels[idx];
        let model: string | null = attrModel !== undefined && attrModel !== null ? attrModel : null;
        if (model === null && hasSessionModels) {
            model = sessionModels.get(spanSessionKeys[idx]!) ?? null;
        }
        if (model === null && envModel !== undefined) {
            model = envModel;
        }
        spanList[idx]!.model = model;
    }

    // Sequential O(1) cursor for computeTokenMetrics (with lazy fallback Map if ever queried out of order).
    let workCursor = 0;
    let fallbackWorkMap: Map<RequestSpan, SpanWork> | null = null;
    const workOf = (span: RequestSpan): SpanWork => {
        if (workCursor < spanList.length && spanList[workCursor] === span) {
            return spanWorkList[workCursor++] ?? EMPTY_SPAN_WORK;
        }
        if (!fallbackWorkMap) {
            fallbackWorkMap = new Map();
            for (let idx = 0; idx < spanList.length; idx += 1) {
                fallbackWorkMap.set(spanList[idx]!, spanWorkList[idx] ?? EMPTY_SPAN_WORK);
            }
        }
        return fallbackWorkMap.get(span)!;
    };

    return assembleMetrics({
        eventCount: events.length,
        requests: spanList,
        workOf,
        looseTokens: looseTokens.length > 0 ? new ListTokenSeries(looseTokens) : EMPTY_TOKEN_SERIES,
        chunkEvents,
        firstNs: events[0]?.mono_ns ?? null,
        lastNs: events[events.length - 1]?.mono_ns ?? null,
        errorsByType,
        errorIds,
        counters,
        routeEvents,
        orchestrationEvents,
    });
}
