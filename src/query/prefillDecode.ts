/**
 * Prefill vs Decode throughput and TTFT reload-vs-steady-prefill classification.
 *
 * Kept separate from src/query/metrics.ts so legacy metric digests remain
 * unchanged while giving Observatory explicit prompt-processing (prefill tok/s)
 * versus token-generation (decode tok/s) and cold-reload versus steady-prefill
 * TTFT visibility.
 *
 * When backend prompt-cache counts are reported alongside prefill duration,
 * prefill tok/s divides by uncached evaluated tokens (never inflating speed by
 * counting cached prefix tokens). A 100% cache hit is flagged separately rather
 * than producing a synthetic rate.
 */
import type { ObservatoryEvent } from "../protocol/events";
import { streamKey } from "../replay/order";
import { backendEvalMs, backendTokenCount, outputTokenCount, promptCacheReport } from "./attributes";
import { scopedRequestKey } from "./identity";
import { latencyStats, type LatencyStats } from "./latencyMetrics";
import { sessionCreatedModel, sessionModelKey } from "./reuseMetrics";

/** Load duration (ms) at or above which a backend load event counts as a model reload rather than a warm ping. */
export const MODEL_RELOAD_MIN_MS = 250;
/** Minimum TTFT (ms) before unexplained overhead over measured prefill is flagged as an overhead spike. */
export const OVERHEAD_SPIKE_MIN_TTFT_MS = 1000;
/** Minimum unexplained TTFT overhead (ms) above measured prefill + queue wait to flag an overhead spike. */
export const OVERHEAD_SPIKE_MIN_EXTRA_MS = 500;
/** Maximum gap (ns) between an unattached model.load.completed and a subsequent request.started on the same stream. */
const PRE_REQUEST_LOAD_WINDOW_NS = 2_000_000_000;

export type PrefillSource =
    | "backend-timing-prefill"
    | "backend-prompt-eval"
    | "prefill-ms"
    | "prefill-span"
    | "backend-reported-rate";

export type PhaseDecodeSource =
    | "backend-timing-decode"
    | "backend-eval"
    | "reported-total-minus-ttft"
    | "token-events"
    | "backend-reported-rate";

export type PhaseProvenance = "backend-reported" | "derived" | "mixed" | "unavailable";

export type TtftClassification = "steady-prefill" | "reload" | "overhead-spike" | "unknown";

export interface RequestPhaseMetrics {
    requestId: string;
    streamKey: string;
    producer: string;
    nodeId: string;
    model: string | null;
    outcome: "completed" | "failed" | "cancelled" | "open";
    startNs: number;
    endNs: number | null;
    promptTokens: number | null;
    cachedPromptTokens: number | null;
    evaluatedPromptTokens: number | null;
    fullPromptCacheHit: boolean;
    prefillMs: number | null;
    prefillTokPerSec: number | null;
    prefillSource: PrefillSource | null;
    decodeTokens: number | null;
    decodeMs: number | null;
    decodeTokPerSec: number | null;
    decodeSource: PhaseDecodeSource | null;
    ttftMs: number | null;
    loadMs: number | null;
    queueMs: number | null;
    overheadMs: number | null;
    ttftClass: TtftClassification;
    reloadReason: string | null;
}

export interface PrefillSummary {
    rateTokPerSec: number | null;
    latestRateTokPerSec: number | null;
    gaugeRateTokPerSec: number | null;
    latency: LatencyStats;
    totalPromptTokens: number;
    totalEvaluatedTokens: number;
    fullCacheHitRequests: number;
    requests: number;
    provenance: PhaseProvenance;
}

export interface DecodeSummary {
    rateTokPerSec: number | null;
    latestRateTokPerSec: number | null;
    gaugeRateTokPerSec: number | null;
    latency: LatencyStats;
    totalTokens: number;
    requests: number;
    provenance: PhaseProvenance;
}

export interface TtftBreakdown {
    all: LatencyStats;
    steadyPrefill: LatencyStats;
    reload: LatencyStats;
    overheadSpike: LatencyStats;
    classifiedCount: number;
    latestClassification: TtftClassification | null;
    latestTtftMs: number | null;
    latestLoadMs: number | null;
}

export interface PrefillDecodeMetrics {
    prefill: PrefillSummary;
    decode: DecodeSummary;
    ttft: TtftBreakdown;
    requests: RequestPhaseMetrics[];
}

function finiteNonNeg(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function finitePos(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function intNonNeg(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

const RELEVANT_TYPES: ReadonlySet<string> = new Set([
    "session.created",
    "model.load.completed",
    "backend.model.load.reported",
    "backend.timing.prefill",
    "backend.timing.decode",
    "backend.metrics.sample",
    "request.started",
    "request.completed",
    "request.failed",
    "request.cancelled",
    "inference.prefill.started",
    "inference.prefill.completed",
    "inference.decode.started",
    "inference.decode.completed",
    "inference.token.generated",
]);

export function isPrefillDecodeEvent(event: ObservatoryEvent): boolean {
    return RELEVANT_TYPES.has(event.event_type);
}

interface PendingLoad {
    monoNs: number;
    durationMs: number;
    model: string | null;
    claimed: boolean;
}

interface RequestWork {
    requestId: string;
    streamKey: string;
    producer: string;
    nodeId: string;
    sessionKey: string;
    envModel: string | null;
    attrModel: string | null;
    outcome: RequestPhaseMetrics["outcome"];
    startNs: number;
    endNs: number | null;
    firstTokenNs: number | null;
    reportedTtftMs: number | null;
    totalMs: number | null;
    queueMs: number | null;
    // Prefill tracking
    prefillStartNs: number | null;
    prefillEndNs: number | null;
    promptTokens: number | null;
    cachedPromptTokens: number | null;
    backendTimingPrefillMs: number | null;
    backendPromptEvalMs: number | null;
    genericPrefillMs: number | null;
    reportedPrefillRate: number | null;
    // Decode tracking
    backendTimingDecodeMs: number | null;
    backendTimingDecodeTokens: number | null;
    backendEvalMs: number | null;
    decodeCompletionTokens: number | null;
    backendOutcomeTokens: number | null;
    reportedDecodeRate: number | null;
    tokenCount: number;
    firstMeasuredTokenNs: number | null;
    firstMeasuredTokenN: number;
    lastMeasuredTokenNs: number | null;
    // Reload tracking
    loadMs: number | null;
    explicitReload: boolean;
}

function extractLoadMs(event: ObservatoryEvent): number | null {
    const a = event.attributes;
    const ns = finitePos(a.load_duration_ns);
    if (ns !== null) {
        return ns / 1e6;
    }
    return finitePos(a.duration_ms) ?? finitePos(a.load_ms);
}

function extractQueueMs(event: ObservatoryEvent): number | null {
    const a = event.attributes;
    const direct = finiteNonNeg(a.queue_ms);
    if (direct !== null) {
        return direct;
    }
    const admission = a.admission;
    if (typeof admission === "object" && admission !== null && !Array.isArray(admission)) {
        return finiteNonNeg((admission as Record<string, unknown>).queue_ms);
    }
    return null;
}

function readReloadFlag(event: ObservatoryEvent): boolean {
    const a = event.attributes;
    return a.reloaded === true || a.cold_start === true || a.model_reloaded === true;
}

function msToStats(valuesMs: readonly number[]): LatencyStats {
    return latencyStats(valuesMs.map((ms) => ms * 1e6));
}

function combineProvenance(backendCount: number, derivedCount: number): PhaseProvenance {
    if (backendCount > 0 && derivedCount > 0) {
        return "mixed";
    }
    if (backendCount > 0) {
        return "backend-reported";
    }
    if (derivedCount > 0) {
        return "derived";
    }
    return "unavailable";
}

function isBackendPrefillSource(source: PrefillSource): boolean {
    return source === "backend-timing-prefill" || source === "backend-prompt-eval" || source === "backend-reported-rate";
}

function isBackendDecodeSource(source: PhaseDecodeSource): boolean {
    return source === "backend-timing-decode" || source === "backend-eval" || source === "backend-reported-rate";
}

function finalizeRequest(w: RequestWork, sessionModels: ReadonlyMap<string, string>): RequestPhaseMetrics {
    const model = w.attrModel ?? sessionModels.get(w.sessionKey) ?? w.envModel;

    // 1. Prefill resolution (divide by uncached evaluated tokens to prevent prefix-cache inflation).
    const promptTokens = w.promptTokens;
    const cachedPromptTokens =
        w.cachedPromptTokens !== null && promptTokens !== null && w.cachedPromptTokens <= promptTokens
            ? w.cachedPromptTokens
            : null;
    const evaluatedPromptTokens =
        promptTokens !== null ? (cachedPromptTokens !== null ? promptTokens - cachedPromptTokens : promptTokens) : null;
    const fullPromptCacheHit = promptTokens !== null && promptTokens > 0 && evaluatedPromptTokens === 0;

    let prefillMs: number | null = null;
    let prefillSource: PrefillSource | null = null;
    if (w.backendTimingPrefillMs !== null) {
        prefillMs = w.backendTimingPrefillMs;
        prefillSource = "backend-timing-prefill";
    } else if (w.backendPromptEvalMs !== null) {
        prefillMs = w.backendPromptEvalMs;
        prefillSource = "backend-prompt-eval";
    } else if (w.genericPrefillMs !== null) {
        prefillMs = w.genericPrefillMs;
        prefillSource = "prefill-ms";
    } else if (w.prefillStartNs !== null && w.prefillEndNs !== null && w.prefillEndNs > w.prefillStartNs) {
        prefillMs = (w.prefillEndNs - w.prefillStartNs) / 1e6;
        prefillSource = "prefill-span";
    }

    let prefillTokPerSec: number | null = null;
    if (fullPromptCacheHit) {
        prefillTokPerSec = null;
    } else if (prefillMs !== null && prefillMs > 0 && evaluatedPromptTokens !== null && evaluatedPromptTokens > 0) {
        prefillTokPerSec = evaluatedPromptTokens / (prefillMs / 1000);
    } else if (prefillMs === null && w.reportedPrefillRate !== null && cachedPromptTokens === null) {
        prefillTokPerSec = w.reportedPrefillRate;
        prefillSource = "backend-reported-rate";
    }

    // 2. Decode resolution (best-first, never counting chunks as tokens).
    let decodeTokens: number | null = null;
    let decodeMs: number | null = null;
    let decodeTokPerSec: number | null = null;
    let decodeSource: PhaseDecodeSource | null = null;

    if (w.backendTimingDecodeMs !== null && w.backendTimingDecodeTokens !== null && w.backendTimingDecodeTokens > 0) {
        decodeMs = w.backendTimingDecodeMs;
        decodeTokens = w.backendTimingDecodeTokens;
        decodeTokPerSec = decodeTokens / (decodeMs / 1000);
        decodeSource = "backend-timing-decode";
    } else if (w.backendEvalMs !== null) {
        const count = w.backendOutcomeTokens ?? w.decodeCompletionTokens;
        if (count !== null && count > 0) {
            decodeMs = w.backendEvalMs;
            decodeTokens = count;
            decodeTokPerSec = decodeTokens / (decodeMs / 1000);
            decodeSource = "backend-eval";
        }
    }
    if (decodeSource === null && w.backendOutcomeTokens !== null && w.backendOutcomeTokens >= 2 && w.totalMs !== null && w.reportedTtftMs !== null && w.totalMs > w.reportedTtftMs) {
        decodeMs = w.totalMs - w.reportedTtftMs;
        decodeTokens = w.backendOutcomeTokens - 1;
        decodeTokPerSec = decodeTokens / (decodeMs / 1000);
        decodeSource = "reported-total-minus-ttft";
    }
    if (
        decodeSource === null &&
        w.backendOutcomeTokens === null &&
        w.tokenCount >= 2 &&
        w.firstMeasuredTokenNs !== null &&
        w.lastMeasuredTokenNs !== null &&
        w.lastMeasuredTokenNs > w.firstMeasuredTokenNs
    ) {
        decodeMs = (w.lastMeasuredTokenNs - w.firstMeasuredTokenNs) / 1e6;
        decodeTokens = w.tokenCount - w.firstMeasuredTokenN;
        if (decodeTokens > 0) {
            decodeTokPerSec = decodeTokens / (decodeMs / 1000);
            decodeSource = "token-events";
        }
    }
    if (decodeSource === null && w.reportedDecodeRate !== null) {
        decodeTokPerSec = w.reportedDecodeRate;
        decodeSource = "backend-reported-rate";
    }

    // 3. TTFT and Reload vs Steady Prefill classification.
    const measuredTtftMs = w.firstTokenNs !== null && w.firstTokenNs >= w.startNs ? (w.firstTokenNs - w.startNs) / 1e6 : null;
    const ttftMs = measuredTtftMs ?? w.reportedTtftMs;
    const overheadMs = ttftMs !== null && prefillMs !== null ? Math.max(0, ttftMs - prefillMs) : null;

    let ttftClass: TtftClassification = "unknown";
    let reloadReason: string | null = null;
    if (ttftMs !== null) {
        const heavyLoad =
            w.loadMs !== null &&
            (w.loadMs >= MODEL_RELOAD_MIN_MS || (ttftMs > 0 && w.loadMs / ttftMs >= 0.4 && w.loadMs >= 100));
        if (w.explicitReload || heavyLoad) {
            ttftClass = "reload";
            reloadReason = w.loadMs !== null ? `model load ${w.loadMs >= 1000 ? `${(w.loadMs / 1000).toFixed(2)} s` : `${w.loadMs.toFixed(0)} ms`}` : "producer flagged reload";
        } else if (prefillMs !== null) {
            const unexplainedMs = Math.max(0, (overheadMs ?? 0) - (w.queueMs ?? 0));
            if (ttftMs >= OVERHEAD_SPIKE_MIN_TTFT_MS && unexplainedMs >= OVERHEAD_SPIKE_MIN_EXTRA_MS && unexplainedMs >= prefillMs * 1.5) {
                ttftClass = "overhead-spike";
                reloadReason = `unexplained TTFT gap (${(unexplainedMs / 1000).toFixed(2)} s above prefill)`;
            } else {
                ttftClass = "steady-prefill";
            }
        } else if (w.loadMs !== null && w.loadMs < MODEL_RELOAD_MIN_MS) {
            ttftClass = "steady-prefill";
        }
    }

    return {
        requestId: w.requestId,
        streamKey: w.streamKey,
        producer: w.producer,
        nodeId: w.nodeId,
        model,
        outcome: w.outcome,
        startNs: w.startNs,
        endNs: w.endNs,
        promptTokens,
        cachedPromptTokens,
        evaluatedPromptTokens,
        fullPromptCacheHit,
        prefillMs,
        prefillTokPerSec,
        prefillSource,
        decodeTokens,
        decodeMs,
        decodeTokPerSec,
        decodeSource,
        ttftMs,
        loadMs: w.loadMs,
        queueMs: w.queueMs,
        overheadMs,
        ttftClass,
        reloadReason,
    };
}

/**
 * Derives Prefill tok/s, Decode tok/s, and TTFT reload-vs-steady-prefill metrics
 * from events in replay order. Never invents rates when timing evidence is absent.
 */
export function derivePrefillDecode(events: Iterable<ObservatoryEvent>): PrefillDecodeMetrics {
    const spans = new Map<string, RequestWork>();
    const openByStream = new Map<string, RequestWork[]>();
    const recentLoadsByStream = new Map<string, PendingLoad>();
    const sessionModels = new Map<string, string>();
    let gaugePrefillRate: number | null = null;
    let gaugeDecodeRate: number | null = null;

    const addOpen = (stream: string, w: RequestWork): void => {
        const list = openByStream.get(stream) ?? [];
        list.push(w);
        openByStream.set(stream, list);
    };

    const removeOpen = (stream: string, w: RequestWork): void => {
        const list = openByStream.get(stream);
        if (!list) return;
        const idx = list.indexOf(w);
        if (idx >= 0) list.splice(idx, 1);
    };

    for (const e of events) {
        const t = e.event_type;
        if (!RELEVANT_TYPES.has(t)) {
            continue;
        }
        const a = e.attributes;
        if (t === "session.created") {
            const m = sessionCreatedModel(e);
            if (m !== null) {
                const key = sessionModelKey(streamKey(e), e.session_id);
                if (!sessionModels.has(key)) {
                    sessionModels.set(key, m);
                }
            }
            continue;
        }
        if (t === "backend.metrics.sample") {
            if (a.status === "ok" && typeof a.metrics === "object" && a.metrics !== null && !Array.isArray(a.metrics)) {
                const m = a.metrics as Record<string, unknown>;
                const pRate = finitePos(m.prompt_tokens_seconds);
                const dRate = finitePos(m.predicted_tokens_seconds);
                if (pRate !== null) gaugePrefillRate = pRate;
                if (dRate !== null) gaugeDecodeRate = dRate;
            }
            continue;
        }

        const stream = streamKey(e);
        const rid = e.request_id ?? null;

        if (t === "model.load.completed" || t === "backend.model.load.reported") {
            if (t === "model.load.completed" && a.resident === false) {
                continue;
            }
            const loadMs = extractLoadMs(e);
            if (loadMs === null) {
                continue;
            }
            if (rid) {
                const w = spans.get(scopedRequestKey(stream, rid));
                if (w) {
                    w.loadMs = w.loadMs === null ? loadMs : Math.max(w.loadMs, loadMs);
                    continue;
                }
            }
            // Attach un-scoped model.load.completed to an open request awaiting its first token on the same stream,
            // or remember it briefly for the next request.started on the same stream.
            const open = openByStream.get(stream);
            const waiting = open?.find((w) => w.firstTokenNs === null && w.endNs === null);
            if (waiting && loadMs >= MODEL_RELOAD_MIN_MS) {
                waiting.loadMs = waiting.loadMs === null ? loadMs : Math.max(waiting.loadMs, loadMs);
            } else if (loadMs >= MODEL_RELOAD_MIN_MS) {
                recentLoadsByStream.set(stream, {
                    monoNs: e.mono_ns,
                    durationMs: loadMs,
                    model: text(a.model),
                    claimed: false,
                });
            }
            continue;
        }

        if (!rid) {
            continue;
        }
        const key = scopedRequestKey(stream, rid);

        if (t === "request.started") {
            const w: RequestWork = {
                requestId: rid,
                streamKey: stream,
                producer: e.producer.name,
                nodeId: e.producer.node_id,
                sessionKey: sessionModelKey(stream, e.session_id),
                envModel: text(e.model_instance_id),
                attrModel: text(a.model),
                outcome: "open",
                startNs: e.mono_ns,
                endNs: null,
                firstTokenNs: null,
                reportedTtftMs: null,
                totalMs: null,
                queueMs: extractQueueMs(e),
                prefillStartNs: null,
                prefillEndNs: null,
                promptTokens: intNonNeg(a.prompt_tokens),
                cachedPromptTokens: null,
                backendTimingPrefillMs: null,
                backendPromptEvalMs: null,
                genericPrefillMs: null,
                reportedPrefillRate: null,
                backendTimingDecodeMs: null,
                backendTimingDecodeTokens: null,
                backendEvalMs: null,
                decodeCompletionTokens: null,
                backendOutcomeTokens: null,
                reportedDecodeRate: null,
                tokenCount: 0,
                firstMeasuredTokenNs: null,
                firstMeasuredTokenN: 0,
                lastMeasuredTokenNs: null,
                loadMs: null,
                explicitReload: readReloadFlag(e),
            };
            const pendingLoad = recentLoadsByStream.get(stream);
            if (pendingLoad && !pendingLoad.claimed && e.mono_ns >= pendingLoad.monoNs && e.mono_ns - pendingLoad.monoNs <= PRE_REQUEST_LOAD_WINDOW_NS) {
                w.loadMs = pendingLoad.durationMs;
                pendingLoad.claimed = true;
            }
            const previous = spans.get(key);
            if (previous) {
                removeOpen(stream, previous);
            }
            spans.set(key, w);
            addOpen(stream, w);
            continue;
        }

        const w = spans.get(key);
        if (!w) {
            continue;
        }

        if (w.attrModel === null) {
            w.attrModel = text(a.model);
        }
        if (readReloadFlag(e)) {
            w.explicitReload = true;
        }
        const qMs = extractQueueMs(e);
        if (qMs !== null) {
            w.queueMs = qMs;
        }
        const cache = promptCacheReport(e);
        if (cache) {
            w.promptTokens = cache.promptTokens;
            w.cachedPromptTokens = cache.cachedTokens;
        }

        if (t === "inference.prefill.started") {
            if (w.prefillStartNs === null) {
                w.prefillStartNs = e.mono_ns;
            }
            const pt = intNonNeg(a.prompt_tokens);
            if (pt !== null && w.promptTokens === null) {
                w.promptTokens = pt;
            }
        } else if (t === "inference.prefill.completed") {
            w.prefillEndNs = e.mono_ns;
            const pt = intNonNeg(a.prompt_tokens);
            if (pt !== null && w.cachedPromptTokens === null) {
                w.promptTokens = pt;
            } else if (pt !== null && w.promptTokens === null) {
                w.promptTokens = pt;
            }
            const bpe = finitePos(a.backend_prompt_eval_ms);
            if (bpe !== null) {
                w.backendPromptEvalMs = bpe;
            }
            const pms = finitePos(a.prefill_ms);
            if (pms !== null) {
                w.genericPrefillMs = pms;
            }
            const ttft = finiteNonNeg(a.ttft_ms);
            if (ttft !== null) {
                w.reportedTtftMs = ttft;
            }
            const rate = finitePos(a.backend_prompt_tokens_per_second) ?? finitePos(a.prefill_tokens_per_sec) ?? finitePos(a.prompt_tokens_per_sec);
            if (rate !== null) {
                w.reportedPrefillRate = rate;
            }
        } else if (t === "backend.timing.prefill") {
            const pt = intNonNeg(a.prompt_eval_count);
            if (pt !== null && w.cachedPromptTokens === null) {
                w.promptTokens = pt;
            } else if (pt !== null && w.promptTokens === null) {
                w.promptTokens = pt;
            }
            const durNs = finitePos(a.prompt_eval_duration_ns);
            if (durNs !== null) {
                w.backendTimingPrefillMs = durNs / 1e6;
            }
            const rate = finitePos(a.prompt_tokens_per_sec);
            if (rate !== null) {
                w.reportedPrefillRate = rate;
            }
        } else if (t === "inference.decode.started") {
            const ttft = finiteNonNeg(a.ttft_ms);
            if (ttft !== null && w.reportedTtftMs === null) {
                w.reportedTtftMs = ttft;
            }
        } else if (t === "inference.token.generated") {
            if (w.firstTokenNs === null) {
                w.firstTokenNs = e.mono_ns;
            }
            const n = outputTokenCount(e);
            if (n !== null) {
                if (w.firstMeasuredTokenNs === null) {
                    w.firstMeasuredTokenNs = e.mono_ns;
                    w.firstMeasuredTokenN = n;
                }
                w.lastMeasuredTokenNs = e.mono_ns;
                w.tokenCount += n;
            }
        } else if (t === "backend.timing.decode") {
            const evalCount = intNonNeg(a.eval_count);
            const evalDurNs = finitePos(a.eval_duration_ns);
            if (evalCount !== null && evalCount > 0 && evalDurNs !== null) {
                w.backendTimingDecodeTokens = evalCount;
                w.backendTimingDecodeMs = evalDurNs / 1e6;
            }
            const rate = finitePos(a.decode_tokens_per_sec);
            if (rate !== null) {
                w.reportedDecodeRate = rate;
            }
            const ttft = finiteNonNeg(a.ttft_ms);
            if (ttft !== null && w.reportedTtftMs === null) {
                w.reportedTtftMs = ttft;
            }
        } else if (t === "inference.decode.completed") {
            const evalMs = backendEvalMs(e);
            if (evalMs !== null) {
                w.backendEvalMs = evalMs;
            }
            const ct = intNonNeg(a.completion_tokens);
            if (ct !== null) {
                w.decodeCompletionTokens = ct;
            }
            const bpe = finitePos(a.backend_prompt_eval_ms);
            if (bpe !== null && w.backendPromptEvalMs === null) {
                w.backendPromptEvalMs = bpe;
            }
            const rate = finitePos(a.backend_tokens_per_sec) ?? finitePos(a.backend_predicted_tokens_per_second);
            if (rate !== null) {
                w.reportedDecodeRate = rate;
            }
        } else if (t === "request.completed" || t === "request.failed" || t === "request.cancelled") {
            if (w.endNs === null) {
                w.endNs = e.mono_ns;
                w.outcome = t === "request.completed" ? "completed" : t === "request.failed" ? "failed" : "cancelled";
                w.backendOutcomeTokens = backendTokenCount(e);
                w.totalMs = finitePos(a.total_ms);
                const ttft = finiteNonNeg(a.ttft_ms);
                if (ttft !== null) {
                    w.reportedTtftMs = ttft;
                }
                const pt = intNonNeg(a.prompt_tokens);
                if (pt !== null && w.promptTokens === null) {
                    w.promptTokens = pt;
                }
                const rate = finitePos(a.backend_predicted_tokens_per_second);
                if (rate !== null && w.reportedDecodeRate === null) {
                    w.reportedDecodeRate = rate;
                }
                removeOpen(stream, w);
            }
        }
    }

    const requests: RequestPhaseMetrics[] = [];
    let prefillEvalTokensSum = 0;
    let prefillPromptTokensSum = 0;
    let prefillMsSum = 0;
    let prefillBackendCount = 0;
    let prefillDerivedCount = 0;
    let prefillMeasuredCount = 0;
    let fullCacheHitRequests = 0;
    let latestPrefillRate: number | null = null;
    const prefillDurationsMs: number[] = [];

    let decodeTokensSum = 0;
    let decodeMsSum = 0;
    let decodeBackendCount = 0;
    let decodeDerivedCount = 0;
    let decodeMeasuredCount = 0;
    let latestDecodeRate: number | null = null;
    const decodeDurationsMs: number[] = [];

    const ttftAll: number[] = [];
    const ttftSteady: number[] = [];
    const ttftReload: number[] = [];
    const ttftOverhead: number[] = [];
    let latestClassification: TtftClassification | null = null;
    let latestTtftMs: number | null = null;
    let latestLoadMs: number | null = null;

    for (const w of spans.values()) {
        const req = finalizeRequest(w, sessionModels);
        requests.push(req);

        if (req.promptTokens !== null) {
            prefillPromptTokensSum += req.promptTokens;
        }
        if (req.fullPromptCacheHit) {
            fullCacheHitRequests += 1;
        }
        if (req.prefillMs !== null) {
            prefillDurationsMs.push(req.prefillMs);
        }
        if (req.prefillTokPerSec !== null && req.prefillSource !== null) {
            prefillMeasuredCount += 1;
            latestPrefillRate = req.prefillTokPerSec;
            if (isBackendPrefillSource(req.prefillSource)) {
                prefillBackendCount += 1;
            } else {
                prefillDerivedCount += 1;
            }
            if (req.prefillMs !== null && req.evaluatedPromptTokens !== null && req.evaluatedPromptTokens > 0) {
                prefillEvalTokensSum += req.evaluatedPromptTokens;
                prefillMsSum += req.prefillMs;
            }
        }

        if (req.decodeMs !== null) {
            decodeDurationsMs.push(req.decodeMs);
        }
        if (req.decodeTokPerSec !== null && req.decodeSource !== null) {
            decodeMeasuredCount += 1;
            latestDecodeRate = req.decodeTokPerSec;
            if (isBackendDecodeSource(req.decodeSource)) {
                decodeBackendCount += 1;
            } else {
                decodeDerivedCount += 1;
            }
            if (req.decodeMs !== null && req.decodeTokens !== null && req.decodeTokens > 0) {
                decodeTokensSum += req.decodeTokens;
                decodeMsSum += req.decodeMs;
            }
        }

        if (req.ttftMs !== null) {
            ttftAll.push(req.ttftMs);
            latestTtftMs = req.ttftMs;
            latestClassification = req.ttftClass;
            latestLoadMs = req.loadMs;
            if (req.ttftClass === "steady-prefill") {
                ttftSteady.push(req.ttftMs);
            } else if (req.ttftClass === "reload") {
                ttftReload.push(req.ttftMs);
            } else if (req.ttftClass === "overhead-spike") {
                ttftOverhead.push(req.ttftMs);
            }
        }
    }

    const prefillRate =
        prefillMsSum > 0 && prefillEvalTokensSum > 0
            ? prefillEvalTokensSum / (prefillMsSum / 1000)
            : latestPrefillRate ?? gaugePrefillRate;
    const decodeRate =
        decodeMsSum > 0 && decodeTokensSum > 0
            ? decodeTokensSum / (decodeMsSum / 1000)
            : latestDecodeRate ?? gaugeDecodeRate;

    const prefillProvenance =
        prefillBackendCount > 0 || prefillDerivedCount > 0
            ? combineProvenance(prefillBackendCount, prefillDerivedCount)
            : gaugePrefillRate !== null
              ? "backend-reported"
              : "unavailable";
    const decodeProvenance =
        decodeBackendCount > 0 || decodeDerivedCount > 0
            ? combineProvenance(decodeBackendCount, decodeDerivedCount)
            : gaugeDecodeRate !== null
              ? "backend-reported"
              : "unavailable";

    return {
        prefill: {
            rateTokPerSec: prefillRate,
            latestRateTokPerSec: latestPrefillRate,
            gaugeRateTokPerSec: gaugePrefillRate,
            latency: msToStats(prefillDurationsMs),
            totalPromptTokens: prefillPromptTokensSum,
            totalEvaluatedTokens: prefillEvalTokensSum,
            fullCacheHitRequests,
            requests: prefillMeasuredCount,
            provenance: prefillProvenance,
        },
        decode: {
            rateTokPerSec: decodeRate,
            latestRateTokPerSec: latestDecodeRate,
            gaugeRateTokPerSec: gaugeDecodeRate,
            latency: msToStats(decodeDurationsMs),
            totalTokens: decodeTokensSum,
            requests: decodeMeasuredCount,
            provenance: decodeProvenance,
        },
        ttft: {
            all: msToStats(ttftAll),
            steadyPrefill: msToStats(ttftSteady),
            reload: msToStats(ttftReload),
            overheadSpike: msToStats(ttftOverhead),
            classifiedCount: ttftSteady.length + ttftReload.length + ttftOverhead.length,
            latestClassification,
            latestTtftMs,
            latestLoadMs,
        },
        requests,
    };
}
