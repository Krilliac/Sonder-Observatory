import type { ObservatoryEvent } from "../../protocol/events";
import { memoryUsage, producerInstance } from "../../query/attributes";
import { deriveGpuMemory, nodeGpuDeviceSample } from "../../query/gpuMemory";
import type { Detector, Finding } from "../types";
import { groupBy, makeFinding, num, pct, str } from "../util";
import { episodes, severityFor } from "./shared";

interface MemSample {
    event: ObservatoryEvent;
    fraction: number;
    used: number | null;
    total: number | null;
    scope: string;
}

const MIB = 1024 * 1024;

function nonnegativeFinite(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function mibBytes(value: unknown): number | null {
    const mib = nonnegativeFinite(value);
    if (mib === null) {
        return null;
    }
    const bytes = mib * MIB;
    return Number.isSafeInteger(bytes) ? bytes : null;
}

function umaEffectiveUsage(e: ObservatoryEvent): { fraction: number; used: number | null; total: number | null } | null {
    const uma = nodeGpuDeviceSample(e);
    if (uma && uma.effectiveTotalBytes !== null && uma.effectiveTotalBytes > 0 && uma.usedFraction !== null) {
        return { fraction: uma.usedFraction, used: uma.effectiveUsedBytes, total: uma.effectiveTotalBytes };
    }
    const a = e.attributes;
    const effectiveTotal =
        mibBytes(a.effective_vram_mib) ??
        (() => {
            const ded = nonnegativeFinite(a.dedicated_total_bytes);
            const shared = nonnegativeFinite(a.shared_total_bytes);
            if (ded !== null && shared !== null) {
                const sum = ded + shared;
                return Number.isSafeInteger(sum) ? sum : null;
            }
            return shared ?? ded;
        })();
    if (effectiveTotal === null || effectiveTotal <= 0) {
        return null;
    }
    const effectiveFree = mibBytes(a.effective_free_vram_mib) ?? nonnegativeFinite(a.dedicated_free_bytes);
    if (effectiveFree !== null && effectiveFree > effectiveTotal) {
        return null;
    }
    const usedVram = mibBytes(a.used_vram_mib);
    const genericUsed = nonnegativeFinite(a.used_bytes);
    let used: number | null = null;
    if (usedVram !== null && usedVram <= effectiveTotal) {
        used = usedVram;
    } else if (effectiveFree !== null) {
        used = effectiveTotal - effectiveFree;
    } else if (genericUsed !== null && genericUsed <= effectiveTotal) {
        used = genericUsed;
    }
    if (used === null) {
        return null;
    }
    return { fraction: used / effectiveTotal, used, total: effectiveTotal };
}

function memSample(e: ObservatoryEvent): MemSample | null {
    const scope = `${e.device_id ?? "unknown-device"}/${str(e, "kind") ?? "memory"}`;
    // Integrated UMA GPUs report a tiny BIOS carveout (e.g. 512 MiB) alongside
    // a large unified GTT pool (e.g. 16-32 GiB). When UMA effective pool bounds
    // are present, evaluate pressure against the unified effective pool rather
    // than falsely alerting on the BIOS carveout.
    if (e.attributes.is_integrated_uma === true) {
        const uma = umaEffectiveUsage(e);
        if (uma !== null) {
            return { event: e, fraction: uma.fraction, used: uma.used, total: uma.total, scope };
        }
    }
    // used_bytes/total_bytes, total_bytes - available_bytes, or used_fraction.
    const usage = memoryUsage(e);
    return usage === null ? null : { event: e, fraction: usage.fraction, used: usage.usedBytes, total: usage.totalBytes, scope };
}

function gib(bytes: number): string {
    return `${(bytes / 2 ** 30).toFixed(2)} GiB`;
}

/**
 * Resource pressure.
 *
 * - `device.memory.sample` series per producer/node, device, and memory kind (vram/ram/gpu/...):
 *   each contiguous run with used/total >= `resource.warnFraction` is one
 *   finding; severity from the peak. Integrated UMA devices are evaluated
 *   against their unified effective UMA pool rather than a small BIOS carveout.
 * - `backend.gpu_memory.sample` series per producer/node/backend/device:
 *   genuine discrete GDDR VRAM spills (`spilled === true`) emit `resource-pressure`
 *   findings, whereas intentional integrated UMA and hybrid discrete+iGPU UMA
 *   shared allocations never emit false-positive VRAM spill findings.
 * - `kv.pressure` events are restated as producer-reported findings; severity
 *   from `occupancy` when present, otherwise warning.
 */
export const detectResourcePressure: Detector = (events, config) => {
    const { warnFraction, criticalFraction } = config.resource;
    const findings: Finding[] = [];

    const samples: MemSample[] = [];
    let hasBackendGpuSamples = false;
    for (const e of events) {
        if (e.event_type === "device.memory.sample") {
            const s = memSample(e);
            if (s) {
                samples.push(s);
            }
        } else if (e.event_type === "backend.gpu_memory.sample") {
            hasBackendGpuSamples = true;
        }
    }

    const seriesKey = (s: MemSample) =>
        JSON.stringify([
            s.event.producer.name,
            s.event.producer.node_id,
            producerInstance(s.event),
            s.event.device_id ?? null,
            str(s.event, "kind") ?? null,
        ]);
    for (const series of groupBy(samples, seriesKey).values()) {
        const scope = series[0]!.scope;
        for (const ep of episodes(series, (s) => s.fraction >= warnFraction)) {
            const peak = ep.reduce((a, b) => (b.fraction > a.fraction ? b : a));
            const bytes = peak.used !== null && peak.total !== null ? ` (${gib(peak.used)} of ${gib(peak.total)})` : "";
            findings.push(
                makeFinding(
                    "resource-pressure",
                    severityFor(peak.fraction, warnFraction, criticalFraction) ?? "warning",
                    ep.map((s) => s.event),
                    `${scope} memory at or above ${pct(warnFraction)} for ${ep.length} sample(s); peak ${pct(peak.fraction)}${bytes}.`,
                    { scope, samples: ep.length, peak_fraction: peak.fraction },
                ),
            );
        }
    }

    if (hasBackendGpuSamples) {
        const byId = new Map<string, ObservatoryEvent>();
        for (const e of events) {
            if (e.event_type === "backend.gpu_memory.sample") {
                byId.set(e.event_id, e);
            }
        }
        const gpuMetrics = deriveGpuMemory(events);
        for (const backend of gpuMetrics.backends) {
            for (const ep of episodes(backend.samples, (s) => s.spilled === true)) {
                const epEvents = ep
                    .map((s) => byId.get(s.eventId))
                    .filter((e): e is ObservatoryEvent => e !== undefined);
                if (epEvents.length === 0) {
                    continue;
                }
                const peak = ep.reduce((a, b) => ((b.sharedBytes ?? -1) > (a.sharedBytes ?? -1) ? b : a));
                const severe =
                    peak.sharedBytes !== null &&
                    peak.spillLimitBytes !== null &&
                    peak.spillLimitBytes > 0 &&
                    peak.sharedBytes >= peak.spillLimitBytes * 2;
                const scope = [backend.deviceId, backend.backend].filter(Boolean).join("/") || "gpu/vram";
                const sharedDetail =
                    peak.sharedBytes !== null
                        ? `; peak ${gib(peak.sharedBytes)} shared${peak.spillLimitBytes !== null ? ` (limit ${gib(peak.spillLimitBytes)})` : ""}`
                        : "";
                const facts: Record<string, number | string> = {
                    scope,
                    signal: "vram-spill",
                    memory_mode: backend.memoryMode ?? "discrete-gddr",
                    samples: ep.length,
                };
                if (peak.sharedBytes !== null) {
                    facts.peak_shared_bytes = peak.sharedBytes;
                }
                if (peak.spillLimitBytes !== null) {
                    facts.spill_limit_bytes = peak.spillLimitBytes;
                }
                findings.push(
                    makeFinding(
                        "resource-pressure",
                        severe ? "critical" : "warning",
                        epEvents,
                        `${scope} discrete VRAM spill into shared system RAM for ${ep.length} sample(s)${sharedDetail}.`,
                        facts,
                    ),
                );
            }
        }
    }

    for (const e of events) {
        if (e.event_type !== "kv.pressure") {
            continue;
        }
        const occupancy = num(e, "occupancy", "used_fraction");
        findings.push(
            makeFinding(
                "resource-pressure",
                occupancy === null ? "warning" : (severityFor(occupancy, warnFraction, criticalFraction) ?? "info"),
                [e],
                `Producer reported KV cache pressure${occupancy === null ? "" : ` at ${pct(occupancy)} occupancy`}${e.device_id ? ` on ${e.device_id}` : ""}.`,
                occupancy === null ? {} : { occupancy },
                "producer-reported",
            ),
        );
    }
    return findings;
};
