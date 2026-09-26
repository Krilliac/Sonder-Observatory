/**
 * Metric derivation from protocol events. Every metric is "derived" from
 * measured producer events and carries the event ids it was computed from so
 * the inspector can show evidence. Nothing here estimates values that the
 * producer did not report: a metric with no evidence is `null` (unavailable).
 */
import type { ObservatoryEvent } from "../protocol/events";
import { backendTokenCount, droppedCount, memoryUsage } from "./attributes";
import { isErrorEvent } from "./classify";

export type Provenance = "measured" | "backend-reported" | "derived" | "estimated" | "unavailable";

export interface LatencyStats {
    count: number;
    p50Ms: number | null;
    p95Ms: number | null;
    maxMs: number | null;
}

export interface RequestSpan {
    requestId: string;
    startNs: number;
    endNs: number | null;
    outcome: "completed" | "failed" | "cancelled" | "open";
    firstTokenNs: number | null;
    /** Tokens counted from inference.token.generated events. */
    tokens: number;
    /** Completion tokens reported by the backend on the outcome event, if any. */
    backendTokens: number | null;
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
    timeToFirstToken: LatencyStats;
    tokens: {
        total: number;
        /** Tokens per second over the whole observed decode window. */
        overallRate: number | null;
        /** Tokens per second over the trailing window ending at the last event. */
        recentRate: number | null;
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
    return {
        count: ms.length,
        p50Ms: percentile(ms, 50),
        p95Ms: percentile(ms, 95),
        maxMs: ms.length > 0 ? Math.max(...ms) : null,
    };
}

function tokenCount(event: ObservatoryEvent): number {
    // One inference.token.generated event is one token unless the producer
    // explicitly batches with an integer `count` attribute.
    const n = event.attributes.count;
    return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 1;
}

function numberAttr(event: ObservatoryEvent, key: string): number | null {
    const v = event.attributes[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Derives metrics from events that are already in replay order. */
export function deriveMetrics(events: readonly ObservatoryEvent[]): Metrics {
    const spans = new Map<string, RequestSpan>();
    const tokenTimes: { ns: number; n: number }[] = [];
    const errorsByType: Record<string, number> = {};
    const errorIds: string[] = [];
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
    let dropped = 0;

    for (const e of events) {
        const t = e.event_type;
        const rid = e.request_id ?? null;

        if (t === "request.started" && rid) {
            spans.set(rid, {
                requestId: rid,
                startNs: e.mono_ns,
                endNs: null,
                outcome: "open",
                firstTokenNs: null,
                tokens: 0,
                backendTokens: null,
            });
        } else if (
            (t === "request.completed" || t === "request.failed" || t === "request.cancelled") &&
            rid
        ) {
            const span = spans.get(rid);
            if (span && span.endNs === null) {
                span.endNs = e.mono_ns;
                span.outcome =
                    t === "request.completed"
                        ? "completed"
                        : t === "request.failed"
                          ? "failed"
                          : "cancelled";
                span.backendTokens = backendTokenCount(e);
            }
        } else if (t === "inference.token.generated") {
            const n = tokenCount(e);
            tokenTimes.push({ ns: e.mono_ns, n });
            const span = rid ? spans.get(rid) : undefined;
            if (span) {
                span.tokens += n;
                if (span.firstTokenNs === null) {
                    span.firstTokenNs = e.mono_ns;
                }
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

        if (t === "telemetry.dropped") {
            dropped += droppedCount(e) ?? 1;
        }
    }

    const requests = [...spans.values()];
    const finished = requests.filter((s) => s.endNs !== null);
    const withFirstToken = requests.filter((s) => s.firstTokenNs !== null);

    const totalTokens = tokenTimes.reduce((sum, x) => sum + x.n, 0);
    const reporting = requests.filter((s) => s.backendTokens !== null);
    const backendReported = reporting.length > 0 ? reporting.reduce((sum, s) => sum + s.backendTokens!, 0) : null;
    let overallRate: number | null = null;
    let recentRate: number | null = null;
    if (tokenTimes.length >= 2) {
        const spanNs = tokenTimes[tokenTimes.length - 1]!.ns - tokenTimes[0]!.ns;
        if (spanNs > 0) {
            overallRate = totalTokens / (spanNs / 1e9);
        }
    }
    const lastEvent = events[events.length - 1];
    if (lastEvent && tokenTimes.length > 0) {
        const windowStart = lastEvent.mono_ns - RECENT_WINDOW_MS * 1e6;
        const recent = tokenTimes.filter((x) => x.ns > windowStart);
        recentRate = recent.reduce((s, x) => s + x.n, 0) / (RECENT_WINDOW_MS / 1000);
    }

    return {
        eventCount: events.length,
        requests,
        requestLatency: latencyStats(finished.map((s) => s.endNs! - s.startNs)),
        timeToFirstToken: latencyStats(withFirstToken.map((s) => s.firstTokenNs! - s.startNs)),
        tokens: { total: totalTokens, overallRate, recentRate, windowMs: RECENT_WINDOW_MS, backendReported },
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
        droppedEvents: dropped,
    };
}
