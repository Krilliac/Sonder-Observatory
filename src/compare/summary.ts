/**
 * Per-session analysis for the comparison view: one pass over a session's
 * events producing whole-session totals and per-unit stats for each
 * alignment mode (run, request, turn).
 *
 * Built only on public APIs: deriveMetrics() request spans (src/query),
 * runDiagnostics() (src/diagnostics), deriveTopology() (src/topology) and
 * the attribute readers (src/query/attributes.ts, ./readers.ts). Every
 * number is read from events or derived from them; a metric that no event
 * supports is null ("n/a"), never zero.
 */
import { runDiagnostics, type Finding } from "../diagnostics";
import type { ObservatoryEvent } from "../protocol/events";
import { isErrorEvent } from "../query/classify";
import { deriveMetrics, percentile } from "../query/metrics";
import { isSyntheticProducer } from "../recording/sobs";
import { orderEvents } from "../replay/order";
import { deriveTopology, type TopologyGraph } from "../topology";
import {
    budgetPressureFraction,
    cacheLookup,
    costBudgetUsd,
    costUsd,
    isRequestOutcome,
    isRetry,
    promptTokens,
    reportedCompletionTokens,
    reportedDecodeRate,
    turnId,
} from "./readers";

export type AlignMode = "run" | "request" | "turn";

export const ALIGN_MODES: readonly AlignMode[] = ["run", "request", "turn"];

/** Facts about one request, in the order requests started. */
export interface RequestFacts {
    requestId: string;
    runId: string | null;
    /** Turn as reported by the producer, or null. */
    turn: string | null;
    startNs: number;
    outcome: "completed" | "failed" | "cancelled" | "open";
    /** Time to first token (first `inference.token.generated`), or the reported `ttft_ms`. */
    ttftMs: number | null;
    ttftSource: "derived" | "reported" | null;
    /** Streamed tokens counted from token events. */
    streamedTokens: number;
    firstTokenNs: number | null;
    lastTokenNs: number | null;
    /** Reported decode rate, else streamed tokens after the first over the first..last token window. */
    decodeTokPerSec: number | null;
    decodeSource: "reported" | "derived" | null;
    promptTokens: number | null;
    completionTokens: number | null;
    costUsd: number | null;
}

/** Stats for a session or one aligned unit (run, request or turn). */
export interface UnitStats {
    key: string;
    label: string;
    firstNs: number;
    events: number;
    requests: number;
    failedRequests: number;
    ttftMs: number | null;
    ttftP95Ms: number | null;
    decodeTokPerSec: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    costUsd: number | null;
    /** Session totals only: cost / declared cost budget. */
    costBudgetFraction: number | null;
    /** Peak `used_fraction` over `guard.budget_pressure` events. */
    budgetPeakFraction: number | null;
    retries: number;
    cacheHits: number;
    cacheMisses: number;
    cacheHitRate: number | null;
    errors: number;
}

export interface UnitGroup {
    mode: AlignMode;
    /** "reported": keys come from producer ids; "inferred": turn order from request start order. */
    keySource: "reported" | "inferred";
    units: UnitStats[];
    /** Events that could not be attributed to a unit (still counted in totals). */
    unattributedEvents: number;
}

export interface SessionAnalysis {
    eventCount: number;
    synthetic: boolean;
    sessionIds: string[];
    requests: RequestFacts[];
    totals: UnitStats;
    costBudgetUsd: number | null;
    groups: Record<AlignMode, UnitGroup>;
    findings: Finding[];
    topology: TopologyGraph;
}

function str(value: unknown): string | null {
    return typeof value === "string" && value !== "" ? value : null;
}

function sumOrNull(values: readonly (number | null)[]): number | null {
    const present = values.filter((v): v is number => v !== null);
    return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
}

function maxOrNull(values: readonly (number | null)[]): number | null {
    const present = values.filter((v): v is number => v !== null);
    return present.length === 0 ? null : Math.max(...present);
}

/** Token-weighted decode rate over requests: sum(tokens) / sum(decode seconds). */
function aggregateDecodeRate(requests: readonly RequestFacts[]): number | null {
    let tokens = 0;
    let seconds = 0;
    for (const r of requests) {
        if (r.decodeTokPerSec === null) {
            continue;
        }
        const n = r.completionTokens ?? r.streamedTokens;
        if (n > 0) {
            tokens += n;
            seconds += n / r.decodeTokPerSec;
        }
    }
    return seconds > 0 ? tokens / seconds : null;
}

function statsFor(key: string, label: string, requests: readonly RequestFacts[], events: readonly ObservatoryEvent[]): UnitStats {
    const ttfts = requests.map((r) => r.ttftMs).filter((v): v is number => v !== null);
    let retries = 0;
    let hits = 0;
    let misses = 0;
    let errors = 0;
    const budget: (number | null)[] = [];
    for (const e of events) {
        if (isRetry(e)) {
            retries += 1;
        }
        const lookup = cacheLookup(e);
        if (lookup === "hit") {
            hits += 1;
        } else if (lookup === "miss") {
            misses += 1;
        }
        if (isErrorEvent(e)) {
            errors += 1;
        }
        budget.push(budgetPressureFraction(e));
    }
    const firstNs = Math.min(
        events.length > 0 ? events[0]!.mono_ns : Number.POSITIVE_INFINITY,
        ...requests.map((r) => r.startNs),
    );
    return {
        key,
        label,
        firstNs: Number.isFinite(firstNs) ? firstNs : 0,
        events: events.length,
        requests: requests.length,
        failedRequests: requests.filter((r) => r.outcome === "failed").length,
        ttftMs: percentile(ttfts, 50),
        ttftP95Ms: percentile(ttfts, 95),
        decodeTokPerSec: aggregateDecodeRate(requests),
        promptTokens: sumOrNull(requests.map((r) => r.promptTokens)),
        completionTokens: sumOrNull(requests.map((r) => r.completionTokens)),
        costUsd: sumOrNull(requests.map((r) => r.costUsd)),
        costBudgetFraction: null,
        budgetPeakFraction: maxOrNull(budget),
        retries,
        cacheHits: hits,
        cacheMisses: misses,
        cacheHitRate: hits + misses > 0 ? hits / (hits + misses) : null,
        errors,
    };
}

/** Request facts in request start order (events must be in replay order). */
export function requestFacts(events: readonly ObservatoryEvent[]): RequestFacts[] {
    const spans = deriveMetrics(events).requests;
    const byId = new Map<string, RequestFacts>();
    for (const s of spans) {
        byId.set(s.requestId, {
            requestId: s.requestId,
            runId: null,
            turn: null,
            startNs: s.startNs,
            outcome: s.outcome,
            ttftMs: s.firstTokenNs !== null ? (s.firstTokenNs - s.startNs) / 1e6 : null,
            ttftSource: s.firstTokenNs !== null ? "derived" : null,
            streamedTokens: s.tokens,
            firstTokenNs: s.firstTokenNs,
            lastTokenNs: null,
            decodeTokPerSec: null,
            decodeSource: null,
            promptTokens: null,
            completionTokens: null,
            costUsd: null,
        });
    }
    const reportedRate = new Map<string, number>();
    const cost = new Map<string, number>();
    for (const e of events) {
        const rid = str(e.request_id);
        const r = rid ? byId.get(rid) : undefined;
        if (!r) {
            continue;
        }
        r.runId ??= str(e.run_id);
        r.turn ??= turnId(e);
        const p = promptTokens(e);
        if (p !== null) {
            r.promptTokens = Math.max(r.promptTokens ?? 0, p);
        }
        if (e.event_type === "inference.token.generated") {
            r.lastTokenNs = e.mono_ns;
        }
        const rate = reportedDecodeRate(e);
        if (rate !== null) {
            reportedRate.set(r.requestId, rate);
        }
        if (isRequestOutcome(e)) {
            r.completionTokens ??= reportedCompletionTokens(e);
            const c = costUsd(e);
            if (c !== null) {
                cost.set(r.requestId, (cost.get(r.requestId) ?? 0) + c);
            }
            const ttft = e.attributes.ttft_ms;
            if (r.ttftMs === null && typeof ttft === "number" && Number.isFinite(ttft) && ttft >= 0) {
                r.ttftMs = ttft;
                r.ttftSource = "reported";
            }
        }
    }
    for (const r of byId.values()) {
        r.costUsd = cost.get(r.requestId) ?? null;
        if (r.completionTokens === null && r.streamedTokens > 0) {
            r.completionTokens = r.streamedTokens;
        }
        const reported = reportedRate.get(r.requestId);
        if (reported !== undefined) {
            r.decodeTokPerSec = reported;
            r.decodeSource = "reported";
        } else if (r.firstTokenNs !== null && r.lastTokenNs !== null && r.streamedTokens >= 2 && r.lastTokenNs > r.firstTokenNs) {
            r.decodeTokPerSec = (r.streamedTokens - 1) / ((r.lastTokenNs - r.firstTokenNs) / 1e9);
            r.decodeSource = "derived";
        }
    }
    return [...byId.values()].sort((a, b) => a.startNs - b.startNs || (a.requestId < b.requestId ? -1 : 1));
}

function groupUnits(
    mode: AlignMode,
    events: readonly ObservatoryEvent[],
    requests: readonly RequestFacts[],
): UnitGroup {
    const reqById = new Map(requests.map((r) => [r.requestId, r]));
    const anyTurn = requests.some((r) => r.turn !== null) || events.some((e) => turnId(e) !== null);
    const keySource: UnitGroup["keySource"] = mode === "turn" && !anyTurn ? "inferred" : "reported";
    const inferredTurn = new Map(requests.map((r, i) => [r.requestId, `#${i + 1}`]));

    const requestKey = (r: RequestFacts): string | null => {
        if (mode === "request") {
            return r.requestId;
        }
        if (mode === "run") {
            return r.runId;
        }
        return keySource === "inferred" ? (inferredTurn.get(r.requestId) ?? null) : r.turn;
    };
    const eventKey = (e: ObservatoryEvent): string | null => {
        const rid = str(e.request_id);
        const r = rid ? reqById.get(rid) : undefined;
        if (mode === "request") {
            return r ? r.requestId : null;
        }
        if (mode === "run") {
            return str(e.run_id) ?? (r ? r.runId : null);
        }
        if (keySource === "reported") {
            return turnId(e) ?? (r ? r.turn : null);
        }
        return r ? (inferredTurn.get(r.requestId) ?? null) : null;
    };

    const unitEvents = new Map<string, ObservatoryEvent[]>();
    const unitRequests = new Map<string, RequestFacts[]>();
    let unattributed = 0;
    for (const e of events) {
        const key = eventKey(e);
        if (key === null) {
            unattributed += 1;
            continue;
        }
        const list = unitEvents.get(key) ?? [];
        list.push(e);
        unitEvents.set(key, list);
    }
    for (const r of requests) {
        const key = requestKey(r);
        if (key === null) {
            continue;
        }
        const list = unitRequests.get(key) ?? [];
        list.push(r);
        unitRequests.set(key, list);
    }
    const keys = new Set([...unitEvents.keys(), ...unitRequests.keys()]);
    const label = (key: string): string => (mode === "turn" && keySource === "reported" ? `turn ${key}` : key);
    const units = [...keys]
        .map((key) => statsFor(key, label(key), unitRequests.get(key) ?? [], unitEvents.get(key) ?? []))
        .sort((a, b) => a.firstNs - b.firstNs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return { mode, keySource, units, unattributedEvents: unattributed };
}

/** Analyzes one session (events in any order; ordered here with the replay order rules). */
export function analyzeSession(input: readonly ObservatoryEvent[]): SessionAnalysis {
    const events = orderEvents(input).events;
    const requests = requestFacts(events);
    const totals = statsFor("session", "Session", requests, events);
    let budget: number | null = null;
    for (const e of events) {
        budget = costBudgetUsd(e) ?? budget;
    }
    totals.costBudgetFraction = budget !== null && totals.costUsd !== null ? totals.costUsd / budget : null;
    return {
        eventCount: events.length,
        synthetic: events.some((e) => isSyntheticProducer(e.producer)),
        sessionIds: [...new Set(events.map((e) => e.session_id))],
        requests,
        totals,
        costBudgetUsd: budget,
        groups: {
            run: groupUnits("run", events, requests),
            request: groupUnits("request", events, requests),
            turn: groupUnits("turn", events, requests),
        },
        findings: runDiagnostics(events),
        topology: deriveTopology(events),
    };
}
