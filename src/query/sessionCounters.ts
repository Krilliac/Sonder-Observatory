/**
 * Per-event session counters (agents, tools, device resources, pressure, and
 * producer-reported drops). Small enough to checkpoint in MetricsIndex.
 */
import type { ObservatoryEvent } from "../protocol/events";
import { memoryUsage, noteDroppedReport } from "./attributes";

export interface ResourceSample {
    monoNs: number;
    deviceId: string | null;
    usedBytes: number;
    totalBytes: number;
    fraction: number;
    eventId: string;
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

export function numberAttr(event: ObservatoryEvent, key: string): number | null {
    const v = event.attributes[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
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
