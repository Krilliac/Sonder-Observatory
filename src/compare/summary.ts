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
import { outputTokenCount } from "../query/attributes";
import { isErrorEvent } from "../query/classify";
import { deriveMetrics, type DecodeWindow } from "../query/metrics";
import { isSyntheticProducer } from "../recording/sobs";
import { isOrdered, markOrdered } from "../replay/lookup";
import { compareEvents } from "../replay/order";
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
    /** Tokens counted from per-token events (`unit: "chunk"` output is never counted). */
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

function percentileSorted(sorted: readonly number[], p: number): number {
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}

interface UnitAccumulator {
    firstNs: number;
    events: number;
    requests: number;
    failedRequests: number;
    ttfts: number[] | null;
    decodeTokens: number;
    decodeSeconds: number;
    promptSum: number;
    hasPrompt: boolean;
    completionSum: number;
    hasCompletion: boolean;
    costSum: number;
    hasCost: boolean;
    budgetPeak: number | null;
    retries: number;
    hits: number;
    misses: number;
    errors: number;
}

function createAccumulator(): UnitAccumulator {
    return {
        firstNs: Number.POSITIVE_INFINITY,
        events: 0,
        requests: 0,
        failedRequests: 0,
        ttfts: null,
        decodeTokens: 0,
        decodeSeconds: 0,
        promptSum: 0,
        hasPrompt: false,
        completionSum: 0,
        hasCompletion: false,
        costSum: 0,
        hasCost: false,
        budgetPeak: null,
        retries: 0,
        hits: 0,
        misses: 0,
        errors: 0,
    };
}

function getOrCreateAcc(map: Map<string, UnitAccumulator>, key: string): UnitAccumulator {
    let acc = map.get(key);
    if (!acc) {
        acc = createAccumulator();
        map.set(key, acc);
    }
    return acc;
}

function addEventToAcc(
    acc: UnitAccumulator,
    monoNs: number,
    retry: number,
    hit: number,
    miss: number,
    err: number,
    budgetPressure: number | null,
): void {
    if (acc.events === 0) {
        acc.firstNs = monoNs;
    }
    acc.events += 1;
    acc.retries += retry;
    acc.hits += hit;
    acc.misses += miss;
    acc.errors += err;
    if (budgetPressure !== null && (acc.budgetPeak === null || budgetPressure > acc.budgetPeak)) {
        acc.budgetPeak = budgetPressure;
    }
}

function addRequestToAcc(acc: UnitAccumulator, r: RequestFacts): void {
    acc.requests += 1;
    acc.firstNs = Math.min(acc.firstNs, r.startNs);
    if (r.outcome === "failed") {
        acc.failedRequests += 1;
    }
    if (r.ttftMs !== null) {
        if (!acc.ttfts) {
            acc.ttfts = [r.ttftMs];
        } else {
            acc.ttfts.push(r.ttftMs);
        }
    }
    if (r.decodeTokPerSec !== null) {
        const n = r.completionTokens ?? r.streamedTokens;
        if (n > 0) {
            acc.decodeTokens += n;
            acc.decodeSeconds += n / r.decodeTokPerSec;
        }
    }
    if (r.promptTokens !== null) {
        acc.hasPrompt = true;
        acc.promptSum += r.promptTokens;
    }
    if (r.completionTokens !== null) {
        acc.hasCompletion = true;
        acc.completionSum += r.completionTokens;
    }
    if (r.costUsd !== null) {
        acc.hasCost = true;
        acc.costSum += r.costUsd;
    }
}

function finalizeUnit(key: string, label: string, acc: UnitAccumulator): UnitStats {
    let ttftMs: number | null = null;
    let ttftP95Ms: number | null = null;
    const ttfts = acc.ttfts;
    if (ttfts !== null && ttfts.length > 0) {
        if (ttfts.length === 1) {
            ttftMs = ttfts[0]!;
            ttftP95Ms = ttfts[0]!;
        } else {
            ttfts.sort((a, b) => a - b);
            ttftMs = percentileSorted(ttfts, 50);
            ttftP95Ms = percentileSorted(ttfts, 95);
        }
    }
    return {
        key,
        label,
        firstNs: Number.isFinite(acc.firstNs) ? acc.firstNs : 0,
        events: acc.events,
        requests: acc.requests,
        failedRequests: acc.failedRequests,
        ttftMs,
        ttftP95Ms,
        decodeTokPerSec: acc.decodeSeconds > 0 ? acc.decodeTokens / acc.decodeSeconds : null,
        promptTokens: acc.hasPrompt ? acc.promptSum : null,
        completionTokens: acc.hasCompletion ? acc.completionSum : null,
        costUsd: acc.hasCost ? acc.costSum : null,
        costBudgetFraction: null,
        budgetPeakFraction: acc.budgetPeak,
        retries: acc.retries,
        cacheHits: acc.hits,
        cacheMisses: acc.misses,
        cacheHitRate: acc.hits + acc.misses > 0 ? acc.hits / (acc.hits + acc.misses) : null,
        errors: acc.errors,
    };
}

function sortUnitsIfNeeded(units: UnitStats[]): UnitStats[] {
    for (let i = 1; i < units.length; i += 1) {
        const a = units[i - 1]!;
        const b = units[i]!;
        if (a.firstNs > b.firstNs || (a.firstNs === b.firstNs && a.key > b.key)) {
            units.sort((x, y) => x.firstNs - y.firstNs || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
            break;
        }
    }
    return units;
}

function buildRequestFacts(events: readonly ObservatoryEvent[]): {
    requests: RequestFacts[];
    indexById: Map<string, number>;
} {
    const spans = deriveMetrics(events).requests;
    const requests: RequestFacts[] = [];
    const indexById = new Map<string, number>();
    let spanDecode: Map<string, DecodeWindow> | null = null;
    for (let i = 0; i < spans.length; i += 1) {
        const s = spans[i]!;
        if (s.decode) {
            spanDecode ??= new Map();
            spanDecode.set(s.requestId, s.decode);
        }
        const fact: RequestFacts = {
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
        };
        const existingIdx = indexById.get(s.requestId);
        if (existingIdx !== undefined) {
            requests[existingIdx] = fact;
        } else {
            indexById.set(s.requestId, requests.length);
            requests.push(fact);
        }
    }
    let reportedRate: Map<string, number> | null = null;
    let cost: Map<string, number> | null = null;
    for (let i = 0; i < events.length; i += 1) {
        const e = events[i]!;
        const rid = str(e.request_id);
        const idx = rid !== null ? indexById.get(rid) : undefined;
        if (idx === undefined) {
            continue;
        }
        const r = requests[idx]!;
        r.runId ??= str(e.run_id);
        r.turn ??= turnId(e);
        const p = promptTokens(e);
        if (p !== null) {
            r.promptTokens = Math.max(r.promptTokens ?? 0, p);
        }
        if (e.event_type === "inference.token.generated" && outputTokenCount(e) !== null) {
            r.lastTokenNs = e.mono_ns;
        }
        const rate = reportedDecodeRate(e);
        if (rate !== null) {
            reportedRate ??= new Map();
            reportedRate.set(r.requestId, rate);
        }
        if (isRequestOutcome(e)) {
            r.completionTokens ??= reportedCompletionTokens(e);
            const c = costUsd(e);
            if (c !== null) {
                cost ??= new Map();
                cost.set(r.requestId, (cost.get(r.requestId) ?? 0) + c);
            }
            const ttft = e.attributes.ttft_ms;
            if (r.ttftMs === null && typeof ttft === "number" && Number.isFinite(ttft) && ttft >= 0) {
                r.ttftMs = ttft;
                r.ttftSource = "reported";
            }
        }
    }
    let sorted = true;
    for (let i = 0; i < requests.length; i += 1) {
        const r = requests[i]!;
        r.costUsd = cost !== null ? (cost.get(r.requestId) ?? null) : null;
        if (r.completionTokens === null && r.streamedTokens > 0) {
            r.completionTokens = r.streamedTokens;
        }
        const reported = reportedRate !== null ? reportedRate.get(r.requestId) : undefined;
        if (reported !== undefined) {
            r.decodeTokPerSec = reported;
            r.decodeSource = "reported";
        } else if (r.firstTokenNs !== null && r.lastTokenNs !== null && r.streamedTokens >= 2 && r.lastTokenNs > r.firstTokenNs) {
            r.decodeTokPerSec = (r.streamedTokens - 1) / ((r.lastTokenNs - r.firstTokenNs) / 1e9);
            r.decodeSource = "derived";
        } else if (spanDecode !== null) {
            // Chunk-streamed output (no per-token events): the backend count over
            // the request's decode window (query/metrics.ts), never the chunk count.
            const d = spanDecode.get(r.requestId);
            if (d && d.tokens > 0 && d.ns > 0) {
                r.decodeTokPerSec = d.tokens / (d.ns / 1e9);
                r.decodeSource = "derived";
            }
        }
        if (sorted && i > 0) {
            const prev = requests[i - 1]!;
            if (prev.startNs > r.startNs || (prev.startNs === r.startNs && prev.requestId > r.requestId)) {
                sorted = false;
            }
        }
    }
    if (!sorted) {
        requests.sort((a, b) => a.startNs - b.startNs || (a.requestId < b.requestId ? -1 : 1));
        indexById.clear();
        for (let i = 0; i < requests.length; i += 1) {
            indexById.set(requests[i]!.requestId, i);
        }
    }
    return { requests, indexById };
}

/** Request facts in request start order (events must be in replay order). */
export function requestFacts(events: readonly ObservatoryEvent[]): RequestFacts[] {
    return buildRequestFacts(events).requests;
}

/**
 * Deduplicates by event_id (first occurrence wins) and sorts into replay order
 * without paying for findSequenceGaps (unused by SessionAnalysis).
 * Already-ordered immutable session arrays are reused directly.
 */
function orderForAnalysis(input: readonly ObservatoryEvent[]): readonly ObservatoryEvent[] {
    if (isOrdered(input)) {
        return input;
    }
    const len = input.length;
    if (len === 0) {
        const empty: ObservatoryEvent[] = [];
        markOrdered(empty);
        return empty;
    }
    const seen = new Set<string>();
    const events: ObservatoryEvent[] = [];
    let sorted = true;
    let prev: ObservatoryEvent | null = null;
    for (let i = 0; i < len; i += 1) {
        const event = input[i]!;
        if (seen.has(event.event_id)) {
            continue;
        }
        seen.add(event.event_id);
        if (sorted && prev !== null && compareEvents(prev, event) > 0) {
            sorted = false;
        }
        prev = event;
        events.push(event);
    }
    if (!sorted) {
        events.sort(compareEvents);
    }
    markOrdered(events);
    return events;
}

/** Analyzes one session (events in any order; ordered here with the replay order rules). */
export function analyzeSession(input: readonly ObservatoryEvent[]): SessionAnalysis {
    const events = orderForAnalysis(input);
    const { requests, indexById } = buildRequestFacts(events);
    const nReq = requests.length;

    let anyTurn = false;
    for (let i = 0; i < nReq; i += 1) {
        if (requests[i]!.turn !== null) {
            anyTurn = true;
            break;
        }
    }
    if (!anyTurn) {
        for (let i = 0; i < events.length; i += 1) {
            if (turnId(events[i]!) !== null) {
                anyTurn = true;
                break;
            }
        }
    }
    const turnKeySource: UnitGroup["keySource"] = anyTurn ? "reported" : "inferred";

    const totalsAcc = createAccumulator();
    const runAccs = new Map<string, UnitAccumulator>();
    const turnAccs = new Map<string, UnitAccumulator>();
    // Compact typed arrays for per-request event counters avoid allocating N intermediate
    // UnitAccumulator objects (each request unit has exactly one RequestFacts entry).
    const reqFirstNs = new Float64Array(nReq);
    reqFirstNs.fill(Number.POSITIVE_INFINITY);
    const reqEvents = new Int32Array(nReq);
    const reqRetries = new Int32Array(nReq);
    const reqHits = new Int32Array(nReq);
    const reqMisses = new Int32Array(nReq);
    const reqErrors = new Int32Array(nReq);
    let reqBudgetPeak: Map<number, number> | null = null;

    let runUnattributed = 0;
    let reqUnattributed = 0;
    let turnUnattributed = 0;
    let budget: number | null = null;
    let synthetic = false;
    const sessionIdsSet = new Set<string>();

    // Single pass over events builds session totals, metadata, and all three alignment groups.
    for (let i = 0; i < events.length; i += 1) {
        const e = events[i]!;
        const b = costBudgetUsd(e);
        if (b !== null) {
            budget = b;
        }
        if (!synthetic && isSyntheticProducer(e.producer)) {
            synthetic = true;
        }
        sessionIdsSet.add(e.session_id);

        const retry = isRetry(e) ? 1 : 0;
        const lookup = cacheLookup(e);
        const hit = lookup === "hit" ? 1 : 0;
        const miss = lookup === "miss" ? 1 : 0;
        const err = isErrorEvent(e) ? 1 : 0;
        const bp = budgetPressureFraction(e);

        addEventToAcc(totalsAcc, e.mono_ns, retry, hit, miss, err, bp);

        const rid = str(e.request_id);
        const rIdx = rid !== null ? indexById.get(rid) : undefined;
        const r = rIdx !== undefined ? requests[rIdx]! : undefined;

        if (rIdx !== undefined) {
            if (reqEvents[rIdx] === 0) {
                reqFirstNs[rIdx] = e.mono_ns;
            }
            reqEvents[rIdx] = reqEvents[rIdx]! + 1;
            reqRetries[rIdx] = reqRetries[rIdx]! + retry;
            reqHits[rIdx] = reqHits[rIdx]! + hit;
            reqMisses[rIdx] = reqMisses[rIdx]! + miss;
            reqErrors[rIdx] = reqErrors[rIdx]! + err;
            if (bp !== null) {
                reqBudgetPeak ??= new Map();
                const prevBp = reqBudgetPeak.get(rIdx);
                if (prevBp === undefined || bp > prevBp) {
                    reqBudgetPeak.set(rIdx, bp);
                }
            }
        } else {
            reqUnattributed += 1;
        }

        const runKey = str(e.run_id) ?? (r ? r.runId : null);
        if (runKey !== null) {
            addEventToAcc(getOrCreateAcc(runAccs, runKey), e.mono_ns, retry, hit, miss, err, bp);
        } else {
            runUnattributed += 1;
        }

        const turnKey =
            turnKeySource === "reported"
                ? (turnId(e) ?? (r ? r.turn : null))
                : rIdx !== undefined
                  ? `#${rIdx + 1}`
                  : null;
        if (turnKey !== null) {
            addEventToAcc(getOrCreateAcc(turnAccs, turnKey), e.mono_ns, retry, hit, miss, err, bp);
        } else {
            turnUnattributed += 1;
        }
    }

    // Single pass over requests completes request-level stats for totals, run, turn, and builds request units directly.
    const reqUnits = new Array<UnitStats>(nReq);
    for (let i = 0; i < nReq; i += 1) {
        const r = requests[i]!;
        addRequestToAcc(totalsAcc, r);
        if (r.runId !== null) {
            addRequestToAcc(getOrCreateAcc(runAccs, r.runId), r);
        }
        const turnKey = turnKeySource === "inferred" ? `#${i + 1}` : r.turn;
        if (turnKey !== null) {
            addRequestToAcc(getOrCreateAcc(turnAccs, turnKey), r);
        }

        const firstNs = Math.min(reqFirstNs[i]!, r.startNs);
        const hits = reqHits[i]!;
        const misses = reqMisses[i]!;
        const decodeTok = r.decodeTokPerSec !== null && (r.completionTokens ?? r.streamedTokens) > 0 ? r.decodeTokPerSec : null;
        reqUnits[i] = {
            key: r.requestId,
            label: r.requestId,
            firstNs: Number.isFinite(firstNs) ? firstNs : 0,
            events: reqEvents[i]!,
            requests: 1,
            failedRequests: r.outcome === "failed" ? 1 : 0,
            ttftMs: r.ttftMs,
            ttftP95Ms: r.ttftMs,
            decodeTokPerSec: decodeTok,
            promptTokens: r.promptTokens,
            completionTokens: r.completionTokens,
            costUsd: r.costUsd,
            costBudgetFraction: null,
            budgetPeakFraction: reqBudgetPeak !== null ? (reqBudgetPeak.get(i) ?? null) : null,
            retries: reqRetries[i]!,
            cacheHits: hits,
            cacheMisses: misses,
            cacheHitRate: hits + misses > 0 ? hits / (hits + misses) : null,
            errors: reqErrors[i]!,
        };
    }

    const totals = finalizeUnit("session", "Session", totalsAcc);
    totals.costBudgetFraction = budget !== null && totals.costUsd !== null ? totals.costUsd / budget : null;

    const runUnits: UnitStats[] = [];
    for (const [key, acc] of runAccs) {
        runUnits.push(finalizeUnit(key, key, acc));
    }
    const turnUnits: UnitStats[] = [];
    for (const [key, acc] of turnAccs) {
        const label = turnKeySource === "reported" ? `turn ${key}` : key;
        turnUnits.push(finalizeUnit(key, label, acc));
    }

    return {
        eventCount: events.length,
        synthetic,
        sessionIds: [...sessionIdsSet],
        requests,
        totals,
        costBudgetUsd: budget,
        groups: {
            run: { mode: "run", keySource: "reported", units: sortUnitsIfNeeded(runUnits), unattributedEvents: runUnattributed },
            request: { mode: "request", keySource: "reported", units: sortUnitsIfNeeded(reqUnits), unattributedEvents: reqUnattributed },
            turn: { mode: "turn", keySource: turnKeySource, units: sortUnitsIfNeeded(turnUnits), unattributedEvents: turnUnattributed },
        },
        findings: runDiagnostics(events),
        topology: deriveTopology(events),
    };
}
