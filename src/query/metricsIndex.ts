/**
 * Incremental metrics over a session in replay order (docs/integration/perf.md).
 *
 * `metricsAt(events, count)` returns exactly `deriveMetrics(events.slice(0, count))`
 * without rescanning the prefix on every render of a replay cursor:
 *
 * - Request spans, per-token and chunk events, decode reports and errors are
 *   indexed once as append-only position lists, so the state of every span
 *   at any cursor is a few binary searches.
 * - The small remaining state (SessionCounters: active agents and tools,
 *   counters, resource samples, drop reports) is checkpointed every
 *   CHECKPOINT events; a query restores the nearest checkpoint and replays
 *   fewer than CHECKPOINT events.
 *
 * The summary statistics are computed by the same code as deriveMetrics
 * (assembleMetrics). When the session store appends strictly after its last
 * event, the index moves to the new array instead of being rebuilt.
 */
import type { ObservatoryEvent } from "../protocol/events";
import { isOrdered, onPrefixExtended } from "../replay/lookup";
import { streamKey } from "../replay/order";
import { backendEvalMs, backendTokenCount, outputTokenCount } from "./attributes";
import { isErrorEvent } from "./classify";
import { scopedRequestKey } from "./identity";
import {
    assembleMetrics,
    cloneCounters,
    newCounters,
    noteSpanReports,
    sessionCreatedModel,
    sessionModelKey,
    stepCounters,
    type Metrics,
    type PromptCacheUse,
    type RequestSpan,
    type SessionCounters,
    type SpanWork,
    type SpeculationUse,
    type TokenSeries,
} from "./metrics";

/** Events between counter checkpoints (bounds the replay per query). */
export const METRICS_CHECKPOINT = 2048;

/** Number of values in the ascending `list` that are < limit. */
function countBelow(list: readonly number[], limit: number): number {
    const n = list.length;
    if (n === 0 || list[n - 1]! < limit) {
        return n;
    }
    let lo = 0;
    let hi = n;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (list[mid]! < limit) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

/** Per-token events with prefix sums; `sumAfter` is a binary search while their times do not decrease. */
class TokenList {
    readonly idx: number[] = [];
    readonly ns: number[] = [];
    readonly n: number[] = [];
    /** cum[j] = n[0] + ... + n[j]. */
    readonly cum: number[] = [];
    monotone = true;

    push(i: number, ns: number, n: number): void {
        if (this.ns.length > 0 && ns < this.ns[this.ns.length - 1]!) {
            this.monotone = false;
        }
        this.idx.push(i);
        this.ns.push(ns);
        this.n.push(n);
        this.cum.push((this.cum.length > 0 ? this.cum[this.cum.length - 1]! : 0) + n);
    }

    /** The first `k` events as a TokenSeries. */
    prefix(k: number): TokenSeries {
        const { ns, n, cum, monotone } = this;
        const sum = k > 0 ? cum[k - 1]! : 0;
        return {
            count: k,
            sum,
            firstNs: k > 0 ? ns[0]! : null,
            firstN: k > 0 ? n[0]! : 0,
            lastNs: k > 0 ? ns[k - 1]! : null,
            sumAfter(t: number): number {
                if (!monotone) {
                    let s = 0;
                    for (let j = 0; j < k; j += 1) {
                        if (ns[j]! > t) {
                            s += n[j]!;
                        }
                    }
                    return s;
                }
                // First event with ns > t.
                let lo = 0;
                let hi = k;
                while (lo < hi) {
                    const mid = (lo + hi) >>> 1;
                    if (ns[mid]! > t) {
                        hi = mid;
                    } else {
                        lo = mid + 1;
                    }
                }
                return sum - (lo > 0 ? cum[lo - 1]! : 0);
            },
        };
    }
}

/** One `request.started` of a span key, and everything deriveMetrics attributes to it. */
interface SpanInstance {
    startIdx: number;
    requestId: string;
    streamKey: string;
    producer: string;
    startNs: number;
    /** First outcome event (-1: none yet) and what it reported. */
    endIdx: number;
    endNs: number;
    outcome: RequestSpan["outcome"];
    backendTokens: number | null;
    totalMs: number | null;
    ttftMs: number | null;
    /** decode.completed reports with a backend eval time, in order. */
    evalIdx: number[];
    evalMs: number[];
    evalNs: number[];
    tokens: TokenList;
    chunkIdx: number[];
    /** First output event, token or chunk (-1: none). */
    firstOutIdx: number;
    firstOutNs: number;
    sessionId: string;
    /** request.started model_instance_id, and the session.created model key. */
    envModel: string | null;
    sessionKey: string;
    /** First event with a `model` attribute (-1: none) and that model. */
    attrModelIdx: number;
    attrModel: string | null;
    /** Prompt-cache and speculation reports, in order. */
    cacheIdx: number[];
    cache: PromptCacheUse[];
    specIdx: number[];
    spec: SpeculationUse[];
}

interface SpanKeyEntry {
    /** Instances in start order (usually exactly one). */
    instances: SpanInstance[];
}

function numberAttr(event: ObservatoryEvent, key: string): number | null {
    const v = event.attributes[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export class MetricsIndex {
    events: readonly ObservatoryEvent[];
    /** Events indexed so far (prefix length). */
    processed = 0;
    private readonly counters = newCounters();
    private readonly checkpoints: SessionCounters[] = [];
    private readonly keys = new Map<string, SpanKeyEntry>();
    /** Span keys in order of their first start (the Map insertion order of deriveMetrics), with that position. */
    private readonly keyOrder: SpanKeyEntry[] = [];
    private readonly keyFirstIdx: number[] = [];
    private readonly loose = new TokenList();
    private readonly chunkIdx: number[] = [];
    private readonly errorIdx: number[] = [];
    private readonly errorIds: string[] = [];
    private readonly errorTypes: string[] = [];
    /** First session.created model per stream and session, with its position. */
    private readonly sessionModels = new Map<string, { idx: number; model: string }>();
    /**
     * The two most recently queried prefixes, newest first. Two slots so two
     * callers that alternate between counts (the replay cursor's prefix and the
     * inspector's whole-session request lookup) do not evict each other.
     */
    private memo: { count: number; value: Metrics }[] = [];
    /** Events the last computed query replayed after its checkpoint (bounded-cost tests). */
    lastReplayed = 0;

    constructor(events: readonly ObservatoryEvent[]) {
        this.events = events;
    }

    /** Indexes events up to `target`. */
    extendTo(target: number): void {
        const end = Math.min(target, this.events.length);
        const events = this.events;
        for (let i = this.processed; i < end; i += 1) {
            if (i % METRICS_CHECKPOINT === 0) {
                this.checkpoints[i / METRICS_CHECKPOINT] = cloneCounters(this.counters);
            }
            const e = events[i]!;
            this.index(e, i);
            stepCounters(this.counters, e);
        }
        this.processed = Math.max(this.processed, end);
    }

    /** Mirrors the span, token and error part of deriveMetrics' per-event loop. */
    private index(e: ObservatoryEvent, i: number): void {
        const t = e.event_type;
        const rid = e.request_id ?? null;
        const stream = rid ? streamKey(e) : "";
        const spanKey = rid ? scopedRequestKey(stream, rid) : "";
        const entry = rid ? this.keys.get(spanKey) : undefined;
        const current = entry?.instances[entry.instances.length - 1];

        if (t === "request.started" && rid) {
            const inst: SpanInstance = {
                startIdx: i,
                requestId: rid,
                streamKey: stream,
                producer: e.producer.name,
                startNs: e.mono_ns,
                endIdx: -1,
                endNs: 0,
                outcome: "open",
                backendTokens: null,
                totalMs: null,
                ttftMs: null,
                evalIdx: [],
                evalMs: [],
                evalNs: [],
                tokens: new TokenList(),
                chunkIdx: [],
                firstOutIdx: -1,
                firstOutNs: 0,
                sessionId: e.session_id,
                envModel: typeof e.model_instance_id === "string" && e.model_instance_id !== "" ? e.model_instance_id : null,
                sessionKey: sessionModelKey(stream, e.session_id),
                attrModelIdx: -1,
                attrModel: null,
                cacheIdx: [],
                cache: [],
                specIdx: [],
                spec: [],
            };
            if (entry) {
                entry.instances.push(inst);
            } else {
                const created = { instances: [inst] };
                this.keys.set(spanKey, created);
                this.keyOrder.push(created);
                this.keyFirstIdx.push(i);
            }
        } else if ((t === "request.completed" || t === "request.failed" || t === "request.cancelled") && rid) {
            if (current && current.endIdx < 0) {
                current.endIdx = i;
                current.endNs = e.mono_ns;
                current.outcome = t === "request.completed" ? "completed" : t === "request.failed" ? "failed" : "cancelled";
                current.backendTokens = backendTokenCount(e);
                current.totalMs = numberAttr(e, "total_ms");
                current.ttftMs = numberAttr(e, "ttft_ms");
            }
        } else if (t === "inference.decode.completed" && rid) {
            const evalMs = backendEvalMs(e);
            if (current && evalMs !== null) {
                current.evalIdx.push(i);
                current.evalMs.push(evalMs);
                current.evalNs.push(e.mono_ns);
            }
        } else if (t === "inference.token.generated") {
            const n = outputTokenCount(e);
            if (n === null) {
                this.chunkIdx.push(i);
            }
            if (current) {
                if (n === null) {
                    current.chunkIdx.push(i);
                } else {
                    current.tokens.push(i, e.mono_ns, n);
                }
                if (current.firstOutIdx < 0) {
                    current.firstOutIdx = i;
                    current.firstOutNs = e.mono_ns;
                }
            } else if (n !== null) {
                this.loose.push(i, e.mono_ns, n);
            }
        }

        if (rid && t !== "inference.token.generated") {
            // After the chain: a request.started reports for the span it opened.
            const reports = noteSpanReports(e);
            const target = reports ? this.keys.get(spanKey)?.instances.at(-1) : undefined;
            if (target && reports) {
                if (target.attrModelIdx < 0 && reports.model !== null) {
                    target.attrModelIdx = i;
                    target.attrModel = reports.model;
                }
                if (reports.cache) {
                    target.cacheIdx.push(i);
                    target.cache.push(reports.cache);
                }
                if (reports.spec) {
                    target.specIdx.push(i);
                    target.spec.push(reports.spec);
                }
            }
        }
        if (t === "session.created") {
            const model = sessionCreatedModel(e);
            if (model !== null) {
                const key = sessionModelKey(streamKey(e), e.session_id);
                if (!this.sessionModels.has(key)) {
                    this.sessionModels.set(key, { idx: i, model });
                }
            }
        }

        if (isErrorEvent(e)) {
            this.errorIdx.push(i);
            this.errorIds.push(e.event_id);
            this.errorTypes.push(t);
        }
    }

    /** Equal to deriveMetrics(events.slice(0, count)). */
    at(count: number): Metrics {
        const c = Math.max(0, Math.min(Math.floor(count), this.events.length));
        if (this.processed < c) {
            this.extendTo(c);
        }
        const hit = this.memo.findIndex((m) => m.count === c);
        if (hit >= 0) {
            const entry = this.memo[hit]!;
            if (hit > 0) {
                this.memo.splice(hit, 1);
                this.memo.unshift(entry);
            }
            return entry.value;
        }
        const value = this.compute(c);
        this.memo.unshift({ count: c, value });
        this.memo.length = Math.min(this.memo.length, 2);
        return value;
    }

    private compute(c: number): Metrics {
        const events = this.events;
        let counters: SessionCounters;
        this.lastReplayed = 0;
        if (c === this.processed) {
            counters = cloneCounters(this.counters);
        } else {
            const cp = Math.floor(c / METRICS_CHECKPOINT);
            counters = cloneCounters(this.checkpoints[cp]!);
            for (let i = cp * METRICS_CHECKPOINT; i < c; i += 1) {
                stepCounters(counters, events[i]!);
            }
            this.lastReplayed = c - cp * METRICS_CHECKPOINT;
        }

        const requests: RequestSpan[] = [];
        const work = new Map<RequestSpan, SpanWork>();
        const nKeys = countBelow(this.keyFirstIdx, c);
        for (let r = 0; r < nKeys; r += 1) {
            const list = this.keyOrder[r]!.instances;
            // The latest start before c (the span deriveMetrics holds for this key).
            let k = list.length - 1;
            while (list[k]!.startIdx >= c) {
                k -= 1;
            }
            const inst = list[k]!;
            const ended = inst.endIdx >= 0 && inst.endIdx < c;
            const nTok = countBelow(inst.tokens.idx, c);
            const nEval = countBelow(inst.evalIdx, c);
            const nCache = countBelow(inst.cacheIdx, c);
            const nSpec = countBelow(inst.specIdx, c);
            const sessionModel = this.sessionModels.get(inst.sessionKey);
            const span: RequestSpan = {
                requestId: inst.requestId,
                streamKey: inst.streamKey,
                producer: inst.producer,
                startNs: inst.startNs,
                endNs: ended ? inst.endNs : null,
                outcome: ended ? inst.outcome : "open",
                firstTokenNs: inst.firstOutIdx >= 0 && inst.firstOutIdx < c ? inst.firstOutNs : null,
                tokens: nTok > 0 ? inst.tokens.cum[nTok - 1]! : 0,
                chunks: countBelow(inst.chunkIdx, c),
                backendTokens: ended ? inst.backendTokens : null,
                tokenCount: null,
                decode: null,
                sessionId: inst.sessionId,
                model:
                    (inst.attrModelIdx >= 0 && inst.attrModelIdx < c ? inst.attrModel : null) ??
                    (sessionModel && sessionModel.idx < c ? sessionModel.model : null) ??
                    inst.envModel,
                promptCache: nCache > 0 ? inst.cache[nCache - 1]! : null,
                speculation: nSpec > 0 ? inst.spec[nSpec - 1]! : null,
            };
            requests.push(span);
            work.set(span, {
                tokens: inst.tokens.prefix(nTok),
                evalMs: nEval > 0 ? inst.evalMs[nEval - 1]! : null,
                evalEndNs: nEval > 0 ? inst.evalNs[nEval - 1]! : null,
                totalMs: ended ? inst.totalMs : null,
                ttftMs: ended ? inst.ttftMs : null,
            });
        }

        const nErr = countBelow(this.errorIdx, c);
        const errorsByType: Record<string, number> = {};
        for (let j = 0; j < nErr; j += 1) {
            const t = this.errorTypes[j]!;
            errorsByType[t] = (errorsByType[t] ?? 0) + 1;
        }

        return assembleMetrics({
            eventCount: c,
            requests,
            workOf: (span) => work.get(span)!,
            looseTokens: this.loose.prefix(countBelow(this.loose.idx, c)),
            chunkEvents: countBelow(this.chunkIdx, c),
            firstNs: c > 0 ? events[0]!.mono_ns : null,
            lastNs: c > 0 ? events[c - 1]!.mono_ns : null,
            errorsByType,
            errorIds: this.errorIds.slice(0, nErr),
            counters,
        });
    }
}

const indexes = new WeakMap<readonly ObservatoryEvent[], MetricsIndex>();

/**
 * The metrics index for an events array. Arrays from the session store or
 * orderEvents (never mutated) share a cached index; any other array gets a
 * fresh one.
 */
export function getMetricsIndex(events: readonly ObservatoryEvent[]): MetricsIndex {
    if (!isOrdered(events)) {
        return new MetricsIndex(events);
    }
    let index = indexes.get(events);
    if (!index) {
        index = new MetricsIndex(events);
        indexes.set(events, index);
    }
    return index;
}

/** Equal to deriveMetrics(events.slice(0, count)), incremental across calls on the same session. */
export function metricsAt(events: readonly ObservatoryEvent[], count = events.length): Metrics {
    return getMetricsIndex(events).at(Math.min(count, events.length));
}

// A store append after its last event keeps the prefix, and so the index.
onPrefixExtended((previous, next) => {
    const index = indexes.get(previous);
    if (index && !indexes.has(next)) {
        index.events = next;
        indexes.set(next, index);
    }
});
