/**
 * Metric derivation from protocol events. Every metric is "derived" from
 * measured producer events and carries the event ids it was computed from so
 * the inspector can show evidence. Nothing here estimates values that the
 * producer did not report: a metric with no evidence is `null` (unavailable).
 */
import type { ObservatoryEvent } from "../protocol/events";
import { streamKey } from "../replay/order";
import {
    backendEvalMs,
    backendTokenCount,
    memoryUsage,
    noteDroppedReport,
    outputTokenCount,
    promptCacheReport,
    speculationReport,
    sumDroppedReports,
    type PromptCacheReport,
    type SpeculationReport,
} from "./attributes";
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

/** A request's prompt-cache report, with the event it came from. */
export interface PromptCacheUse extends PromptCacheReport {
    /** cachedTokens / promptTokens; null for an empty prompt. */
    hitRatio: number | null;
    eventId: string;
}

/** A request's speculative-decoding report, with the event it came from. */
export interface SpeculationUse extends SpeculationReport {
    /** acceptedTokens / draftTokens; null when nothing was drafted. */
    acceptanceRate: number | null;
    eventId: string;
}

export function promptCacheUse(report: PromptCacheReport, eventId: string): PromptCacheUse {
    return { ...report, hitRatio: report.promptTokens > 0 ? report.cachedTokens / report.promptTokens : null, eventId };
}

export function speculationUse(report: SpeculationReport, eventId: string): SpeculationUse {
    return { ...report, acceptanceRate: report.draftTokens > 0 ? report.acceptedTokens / report.draftTokens : null, eventId };
}

/** Prompt-cache totals over a set of requests with a report. */
export interface PromptCacheTotals {
    /** Requests with a prompt-cache report. */
    requests: number;
    promptTokens: number;
    cachedTokens: number;
    evaluatedTokens: number;
    /** cachedTokens / promptTokens (token-weighted); null when no prompt tokens. */
    hitRatio: number | null;
}

/** Speculative-decoding totals over a set of requests with a report. */
export interface SpeculationTotals {
    /** Requests with a draft report. */
    requests: number;
    draftTokens: number;
    acceptedTokens: number;
    /** acceptedTokens / draftTokens (token-weighted); null when nothing was drafted. */
    acceptanceRate: number | null;
    /**
     * Mean accepted draft tokens per reporting request. Not the per-draft-round
     * accepted length: no producer reports the number of draft rounds yet.
     */
    acceptedPerRequest: number | null;
}

/** Key of requests whose model is not reported, in the byModel groupings. */
export const UNKNOWN_MODEL = "(model not reported)";

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
    /**
     * Backend prompt-cache reuse (additive): totals over requests with a
     * report, per model and per session_id, plus the reporting event ids.
     */
    promptCache: PromptCacheTotals & {
        byModel: Record<string, PromptCacheTotals>;
        bySession: Record<string, PromptCacheTotals>;
        eventIds: string[];
    };
    /** Backend speculative-decoding acceptance (additive), grouped as promptCache. */
    speculation: SpeculationTotals & {
        byModel: Record<string, SpeculationTotals>;
        bySession: Record<string, SpeculationTotals>;
        eventIds: string[];
    };
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

/**
 * Per-token events (never chunks) in replay order, as the token metrics read
 * them. deriveMetrics keeps plain lists; the incremental index
 * (metricsIndex.ts) answers the same questions from prefix sums.
 */
export interface TokenSeries {
    /** Number of per-token events. */
    readonly count: number;
    /** Sum of their token counts. */
    readonly sum: number;
    /** Time and token count of the first event, and time of the last (null / 0 when empty). */
    readonly firstNs: number | null;
    readonly firstN: number;
    readonly lastNs: number | null;
    /** Sum of the token counts of the events with ns > `ns`. */
    sumAfter(ns: number): number;
}

class ListTokenSeries implements TokenSeries {
    constructor(private readonly list: readonly TokenTime[]) {}
    get count(): number {
        return this.list.length;
    }
    get sum(): number {
        return this.list.reduce((sum, x) => sum + x.n, 0);
    }
    get firstNs(): number | null {
        return this.list[0]?.ns ?? null;
    }
    get firstN(): number {
        return this.list[0]?.n ?? 0;
    }
    get lastNs(): number | null {
        return this.list.at(-1)?.ns ?? null;
    }
    sumAfter(ns: number): number {
        return this.list.filter((x) => x.ns > ns).reduce((sum, x) => sum + x.n, 0);
    }
}

/** Per-span facts only the token metrics need. */
export interface SpanWork {
    /** Per-token events (never chunks) of the span. */
    tokens: TokenSeries;
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
    const endNs = open ? w.tokens.lastNs : span.endNs;
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
    workOf: (span: RequestSpan) => SpanWork,
    looseTokens: TokenSeries,
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
    const counted: TokenSeries[] = [looseTokens];
    const spread: DecodeWindow[] = [];
    for (const span of requests) {
        const w = workOf(span);
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
            eventCounted += w.tokens.count;
            counted.push(w.tokens);
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
    // Token counts are integers, so these sums do not depend on summation order.
    fromEvents += looseTokens.sum;
    eventCounted += looseTokens.count;
    if (looseTokens.count >= 2) {
        // Token events with no request: their first-to-last span, as one stream.
        // The first event opens the span, so its tokens are not in it (N events
        // bound N-1 intervals), as decodeWindow does for a request.
        const ns = looseTokens.lastNs! - looseTokens.firstNs!;
        if (ns > 0) {
            decodeTokens += looseTokens.sum - looseTokens.firstN;
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
        let recent = 0;
        for (const series of counted) {
            recent += series.sumAfter(windowStart);
        }
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

/**
 * Everything deriveMetrics accumulates per event outside request spans,
 * tokens and errors. Small (sets of active ids, counters, latest samples), so
 * the incremental index (metricsIndex.ts) checkpoints it.
 */
export interface SessionCounters {
    activeAgents: Set<string>;
    activeTools: Set<string>;
    spawned: number;
    agentsCompleted: number;
    agentTransitions: number;
    toolsCalled: number;
    toolsCompleted: number;
    toolsFailed: number;
    latest: ResourceSample | null;
    peak: ResourceSample | null;
    pressureEvents: number;
    latestCompute: number | null;
    /** Latest cumulative drop report per producer instance (see totalDroppedEvents). */
    dropped: Map<string, number>;
}

export function newCounters(): SessionCounters {
    return {
        activeAgents: new Set(),
        activeTools: new Set(),
        spawned: 0,
        agentsCompleted: 0,
        agentTransitions: 0,
        toolsCalled: 0,
        toolsCompleted: 0,
        toolsFailed: 0,
        latest: null,
        peak: null,
        pressureEvents: 0,
        latestCompute: null,
        dropped: new Map(),
    };
}

/** Independent copy (sets and maps keep their iteration order). */
export function cloneCounters(c: SessionCounters): SessionCounters {
    return { ...c, activeAgents: new Set(c.activeAgents), activeTools: new Set(c.activeTools), dropped: new Map(c.dropped) };
}

/** Applies one event (in replay order) to the counters. */
export function stepCounters(c: SessionCounters, e: ObservatoryEvent): void {
    const t = e.event_type;
    const agent = e.agent_id ?? null;
    if (t.startsWith("agent.") || t.startsWith("route.")) {
        c.agentTransitions += 1;
    }
    if (agent) {
        if (t === "agent.spawned") {
            c.spawned += 1;
            c.activeAgents.add(agent);
        } else if (t === "agent.started") {
            c.activeAgents.add(agent);
        } else if (t === "agent.completed" || t === "agent.cancelled") {
            if (t === "agent.completed") {
                c.agentsCompleted += 1;
            }
            c.activeAgents.delete(agent);
        }
    }

    const callId =
        typeof e.attributes.tool_call_id === "string"
            ? e.attributes.tool_call_id
            : typeof e.tool_call_id === "string"
              ? e.tool_call_id
              : null;
    if (t === "tool.called") {
        c.toolsCalled += 1;
        if (callId) {
            c.activeTools.add(callId);
        }
    } else if (t === "tool.completed" || t === "tool.failed") {
        if (t === "tool.completed") {
            c.toolsCompleted += 1;
        } else {
            c.toolsFailed += 1;
        }
        if (callId) {
            c.activeTools.delete(callId);
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
            c.latest = sample;
            if (!c.peak || sample.fraction > c.peak.fraction) {
                c.peak = sample;
            }
        }
    } else if (t === "device.compute.sample") {
        const u = numberAttr(e, "utilization");
        if (u !== null) {
            c.latestCompute = u;
        }
    }
    if (t === "kv.pressure" || t === "guard.budget_pressure") {
        c.pressureEvents += 1;
    }
    noteDroppedReport(c.dropped, e);
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

interface CacheAcc {
    requests: number;
    promptTokens: number;
    cachedTokens: number;
    evaluatedTokens: number;
}

interface SpecAcc {
    requests: number;
    draftTokens: number;
    acceptedTokens: number;
}

function cacheTotals(a: CacheAcc): PromptCacheTotals {
    return { ...a, hitRatio: a.promptTokens > 0 ? a.cachedTokens / a.promptTokens : null };
}

function specTotals(a: SpecAcc): SpeculationTotals {
    return {
        ...a,
        acceptanceRate: a.draftTokens > 0 ? a.acceptedTokens / a.draftTokens : null,
        acceptedPerRequest: a.requests > 0 ? a.acceptedTokens / a.requests : null,
    };
}

function grouped<A>(groups: Map<string, A>, key: string, make: () => A): A {
    let g = groups.get(key);
    if (!g) {
        g = make();
        groups.set(key, g);
    }
    return g;
}

function mapValues<A, T>(groups: Map<string, A>, f: (a: A) => T): Record<string, T> {
    const out: Record<string, T> = {};
    for (const [k, v] of groups) {
        out[k] = f(v);
    }
    return out;
}

/**
 * Prompt-cache and speculation totals from the requests' latest reports.
 * Token counts are integers, so the sums do not depend on summation order.
 */
function reuseMetrics(requests: readonly RequestSpan[]): Pick<Metrics, "promptCache" | "speculation"> {
    const newCache = (): CacheAcc => ({ requests: 0, promptTokens: 0, cachedTokens: 0, evaluatedTokens: 0 });
    const newSpec = (): SpecAcc => ({ requests: 0, draftTokens: 0, acceptedTokens: 0 });
    const cache = newCache();
    const spec = newSpec();
    const cacheByModel = new Map<string, CacheAcc>();
    const cacheBySession = new Map<string, CacheAcc>();
    const specByModel = new Map<string, SpecAcc>();
    const specBySession = new Map<string, SpecAcc>();
    const cacheIds: string[] = [];
    const specIds: string[] = [];
    for (const span of requests) {
        const c = span.promptCache;
        if (c) {
            for (const acc of [cache, grouped(cacheByModel, span.model ?? UNKNOWN_MODEL, newCache), grouped(cacheBySession, span.sessionId, newCache)]) {
                acc.requests += 1;
                acc.promptTokens += c.promptTokens;
                acc.cachedTokens += c.cachedTokens;
                acc.evaluatedTokens += c.evaluatedTokens;
            }
            cacheIds.push(c.eventId);
        }
        const s = span.speculation;
        if (s) {
            for (const acc of [spec, grouped(specByModel, span.model ?? UNKNOWN_MODEL, newSpec), grouped(specBySession, span.sessionId, newSpec)]) {
                acc.requests += 1;
                acc.draftTokens += s.draftTokens;
                acc.acceptedTokens += s.acceptedTokens;
            }
            specIds.push(s.eventId);
        }
    }
    return {
        promptCache: { ...cacheTotals(cache), byModel: mapValues(cacheByModel, cacheTotals), bySession: mapValues(cacheBySession, cacheTotals), eventIds: cacheIds },
        speculation: { ...specTotals(spec), byModel: mapValues(specByModel, specTotals), bySession: mapValues(specBySession, specTotals), eventIds: specIds },
    };
}

/** The summary statistics shared by deriveMetrics and the incremental index. */
export function assembleMetrics(p: MetricsParts): Metrics {
    const { requests, counters: c } = p;
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

    const tokens = tokenMetrics(requests, p.workOf, p.looseTokens, p.chunkEvents, p.firstNs, p.lastNs);
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
 * Per-request backend reports that deriveMetrics tracks besides the token
 * facts: the first `model` attribute, and the latest prompt-cache and
 * speculation reports. Token events never carry them and are skipped.
 */
export function noteSpanReports(e: ObservatoryEvent): { model: string | null; cache: PromptCacheUse | null; spec: SpeculationUse | null } | null {
    const model = typeof e.attributes.model === "string" && e.attributes.model !== "" ? e.attributes.model : null;
    const cacheReport = promptCacheReport(e);
    const specReport = speculationReport(e);
    if (model === null && cacheReport === null && specReport === null) {
        return null;
    }
    return {
        model,
        cache: cacheReport ? promptCacheUse(cacheReport, e.event_id) : null,
        spec: specReport ? speculationUse(specReport, e.event_id) : null,
    };
}

/** Key of the first `session.created` model of a stream and session. */
export function sessionModelKey(stream: string, sessionId: string): string {
    return `${stream}\u0001${sessionId}`;
}

/** The `model` of a `session.created` event, or null. */
export function sessionCreatedModel(e: ObservatoryEvent): string | null {
    if (e.event_type !== "session.created") {
        return null;
    }
    const m = e.attributes.model;
    return typeof m === "string" && m !== "" ? m : null;
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
