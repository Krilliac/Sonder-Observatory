/**
 * Prompt-cache reuse and speculative-decoding acceptance aggregation across
 * requests, models, and sessions.
 */
import type { ObservatoryEvent } from "../protocol/events";
import { promptCacheReport, speculationReport, type PromptCacheReport, type SpeculationReport } from "./attributes";
import { scopedSessionKey } from "./identity";

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
    /**
     * Settled (completed, failed or cancelled) requests without any
     * prompt-cache report (the field is absent, e.g. an Ollama or producer
     * that predates it): unknown, so excluded from `requests` and the ratio
     * rather than counted as misses. Open requests are not counted: they may
     * still report. On the top-level
     * totals this is every such request; in a byModel / bySession group, the
     * ones of that model / session (groups exist only where at least one
     * request reported).
     */
    unreportedRequests: number;
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

export type PromptCacheMetrics = PromptCacheTotals & {
    byModel: Record<string, PromptCacheTotals>;
    bySession: Record<string, PromptCacheTotals>;
    eventIds: string[];
};

export type SpeculationMetrics = SpeculationTotals & {
    byModel: Record<string, SpeculationTotals>;
    bySession: Record<string, SpeculationTotals>;
    eventIds: string[];
};

/** Key of requests whose model is not reported, in the byModel groupings. */
export const UNKNOWN_MODEL = "(model not reported)";

interface CacheAcc {
    requests: number;
    promptTokens: number;
    cachedTokens: number;
    evaluatedTokens: number;
    unreportedRequests: number;
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

export interface ReuseSpanLike {
    outcome: "completed" | "failed" | "cancelled" | "open";
    sessionId: string;
    model: string | null;
    promptCache: PromptCacheUse | null;
    speculation: SpeculationUse | null;
}

/**
 * Prompt-cache and speculation totals from the requests' latest reports.
 * Token counts are integers, so the sums do not depend on summation order.
 * A request without a prompt-cache report is excluded from the cache ratio;
 * once settled it is counted in unreportedRequests.
 */
export function reuseMetrics(requests: readonly ReuseSpanLike[]): {
    promptCache: PromptCacheMetrics;
    speculation: SpeculationMetrics;
} {
    const newCache = (): CacheAcc => ({ requests: 0, promptTokens: 0, cachedTokens: 0, evaluatedTokens: 0, unreportedRequests: 0 });
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
    // Settled requests without a prompt-cache report are unknown, not misses:
    // counted apart, and only into groups that exist (a group needs one
    // report). An open request may still report, so it is not counted yet.
    for (const span of requests) {
        if (!span.promptCache && span.outcome !== "open") {
            cache.unreportedRequests += 1;
            const byModel = cacheByModel.get(span.model ?? UNKNOWN_MODEL);
            const bySession = cacheBySession.get(span.sessionId);
            if (byModel) {
                byModel.unreportedRequests += 1;
            }
            if (bySession) {
                bySession.unreportedRequests += 1;
            }
        }
    }
    return {
        promptCache: { ...cacheTotals(cache), byModel: mapValues(cacheByModel, cacheTotals), bySession: mapValues(cacheBySession, cacheTotals), eventIds: cacheIds },
        speculation: { ...specTotals(spec), byModel: mapValues(specByModel, specTotals), bySession: mapValues(specBySession, specTotals), eventIds: specIds },
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
    return scopedSessionKey(stream, sessionId);
}

/** The `model` of a `session.created` event, or null. */
export function sessionCreatedModel(e: ObservatoryEvent): string | null {
    if (e.event_type !== "session.created") {
        return null;
    }
    const m = e.attributes.model;
    return typeof m === "string" && m !== "" ? m : null;
}
