/**
 * Per-event session counters (agents, tools, device resources, pressure, and
 * producer-reported drops). Small enough to checkpoint in MetricsIndex.
 *
 * Tracks latest and peak memory per `(device_id, kind)` so host CPU RAM and
 * discrete/integrated-UMA GPU VRAM samples never overwrite each other, while
 * preserving the backward-compatible `latest`/`peak` fields read by legacy
 * metrics and digests.
 */
import type { ObservatoryEvent } from "../protocol/events";
import { deviceMemoryKind, memoryUsage, noteDroppedReport } from "./attributes";

export interface ResourceSample {
    monoNs: number;
    deviceId: string | null;
    usedBytes: number;
    totalBytes: number;
    fraction: number;
    eventId: string;
}

/** Latest and peak memory observations isolated for one `(device_id, kind)` stream. */
export interface DeviceMemoryRecord {
    key: string;
    deviceId: string | null;
    kind: string | null;
    name: string | null;
    isIntegratedUma: boolean | null;
    latest: ResourceSample;
    peak: ResourceSample;
    samples: number;
}

export interface DeviceMemorySummary {
    /** Backward-compatible overall latest sample across all devices/kinds. */
    latest: ResourceSample | null;
    /** Backward-compatible overall peak-fraction sample across all devices/kinds. */
    peak: ResourceSample | null;
    /** Isolated per-(device_id, kind) latest and peak records, in first-seen order. */
    byDevice: DeviceMemoryRecord[];
    /** Latest host/CPU memory sample (`kind` in `cpu`/`ram`), or null when none. */
    hostLatest: ResourceSample | null;
    /** Peak host/CPU memory sample (`kind` in `cpu`/`ram`), or null when none. */
    hostPeak: ResourceSample | null;
    /** Latest GPU memory sample (`kind` in `gpu`/`vram`), or null when none. */
    gpuLatest: ResourceSample | null;
    /** Peak GPU memory sample (`kind` in `gpu`/`vram`), or null when none. */
    gpuPeak: ResourceSample | null;
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
    /** Per-`(device_id, kind)` memory tracking so CPU RAM and discrete/UMA GPUs never clobber each other. */
    devices: Map<string, DeviceMemoryRecord>;
    pressureEvents: number;
    latestCompute: number | null;
    /** Latest cumulative drop report per producer instance (see totalDroppedEvents). */
    dropped: Map<string, number>;
}

/** Canonical collision-free key for one `(device_id, kind)` pair. */
export function deviceMemoryKey(deviceId: string | null, kind: string | null): string {
    return JSON.stringify([deviceId, kind]);
}

function nonEmptyString(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
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
        devices: new Map(),
        pressureEvents: 0,
        latestCompute: null,
        dropped: new Map(),
    };
}

/** Independent copy (sets, maps, and per-device records keep their iteration order without aliasing). */
export function cloneCounters(c: SessionCounters): SessionCounters {
    const devices = new Map<string, DeviceMemoryRecord>();
    for (const [k, rec] of c.devices) {
        devices.set(k, { ...rec });
    }
    return {
        ...c,
        activeAgents: new Set(c.activeAgents),
        activeTools: new Set(c.activeTools),
        devices,
        dropped: new Map(c.dropped),
    };
}

/** Returns the tracked record for one `(device_id, kind)` pair, or null when absent. */
export function deviceMemoryRecord(
    c: Pick<SessionCounters, "devices">,
    deviceId: string | null,
    kind: string | null,
): DeviceMemoryRecord | null {
    return c.devices.get(deviceMemoryKey(deviceId, kind)) ?? null;
}

/** Returns all tracked `(device_id, kind)` memory records in first-seen order. */
export function deviceMemoryRecords(c: Pick<SessionCounters, "devices">): DeviceMemoryRecord[] {
    return [...c.devices.values()];
}

/** Returns all tracked device memory records matching a given `kind` (case-insensitive). */
export function deviceMemoryByKind(c: Pick<SessionCounters, "devices">, kind: string): DeviceMemoryRecord[] {
    const target = kind.trim().toLowerCase();
    return [...c.devices.values()].filter((r) => r.kind !== null && r.kind.toLowerCase() === target);
}

/** Backward-compatible summary getter plus isolated host-RAM vs GPU-VRAM latest/peak views. */
export function summarizeDeviceMemory(c: Pick<SessionCounters, "latest" | "peak" | "devices">): DeviceMemorySummary {
    const byDevice = deviceMemoryRecords(c);
    let hostLatest: ResourceSample | null = null;
    let hostPeak: ResourceSample | null = null;
    let gpuLatest: ResourceSample | null = null;
    let gpuPeak: ResourceSample | null = null;

    for (const rec of byDevice) {
        const k = rec.kind?.toLowerCase() ?? null;
        if (k === "cpu" || k === "ram") {
            if (!hostLatest || rec.latest.monoNs >= hostLatest.monoNs) {
                hostLatest = rec.latest;
            }
            if (!hostPeak || rec.peak.fraction > hostPeak.fraction) {
                hostPeak = rec.peak;
            }
        } else if (k === "gpu" || k === "vram") {
            if (!gpuLatest || rec.latest.monoNs >= gpuLatest.monoNs) {
                gpuLatest = rec.latest;
            }
            if (!gpuPeak || rec.peak.fraction > gpuPeak.fraction) {
                gpuPeak = rec.peak;
            }
        }
    }

    return {
        latest: c.latest,
        peak: c.peak,
        byDevice,
        hostLatest,
        hostPeak,
        gpuLatest,
        gpuPeak,
    };
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
            const deviceId = e.device_id ?? null;
            const kind = deviceMemoryKind(e);
            const sample: ResourceSample = {
                monoNs: e.mono_ns,
                deviceId,
                usedBytes: usage.usedBytes,
                totalBytes: usage.totalBytes,
                fraction: usage.fraction,
                eventId: e.event_id,
            };
            c.latest = sample;
            if (!c.peak || sample.fraction > c.peak.fraction) {
                c.peak = sample;
            }
            const key = deviceMemoryKey(deviceId, kind);
            const existing = c.devices.get(key);
            const name = nonEmptyString(e.attributes.name);
            const isUma = typeof e.attributes.is_integrated_uma === "boolean" ? e.attributes.is_integrated_uma : null;
            if (existing) {
                existing.latest = sample;
                if (sample.fraction > existing.peak.fraction) {
                    existing.peak = sample;
                }
                if (name !== null) {
                    existing.name = name;
                }
                if (isUma !== null) {
                    existing.isIntegratedUma = isUma;
                }
                existing.samples += 1;
            } else {
                c.devices.set(key, {
                    key,
                    deviceId,
                    kind,
                    name,
                    isIntegratedUma: isUma,
                    latest: sample,
                    peak: sample,
                    samples: 1,
                });
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
