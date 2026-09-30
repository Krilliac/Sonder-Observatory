/**
 * Backend GPU telemetry (Sonder-Inference's vram-spill-guard contract).
 * Kept separate from Metrics so legacy resource/token calculations are unchanged.
 * Input is deduplicated replay order, as supplied by SessionStore/orderEvents.
 */
import type { ObservatoryEvent } from "../protocol/events";
import { producerInstance } from "./attributes";

export interface GpuMemorySample {
    eventId: string;
    monoNs: number;
    wallTime: string;
    dedicatedBytes: number | null;
    sharedBytes: number | null;
    spillThresholdBytes: number | null;
    sharedBaselineBytes: number | null;
    /** Shared baseline + spill threshold, not the dedicated VRAM capacity. */
    spillLimitBytes: number | null;
    spilled: boolean | null;
    fittedCtx: number | null;
    sampleCount: number | null;
    status: string | null;
    /** Observed sample-counter reset; no PID is supplied by this producer. */
    epoch: number;
}

export interface GpuContextChange {
    eventId: string;
    monoNs: number;
    fittedCtx: number | null;
    fitOutcome: string | null;
}

export interface GpuWarning {
    code: string;
    message: string | null;
    severity: string | null;
    source: string | null;
    count: number;
    firstSeenNs: number;
    lastSeenNs: number;
    firstSeenWallTime: string;
    lastSeenWallTime: string;
    firstEventId: string;
    lastEventId: string;
}

export interface GpuBackendMetrics {
    key: string;
    backend: string | null;
    producer: string;
    nodeId: string;
    instanceId: string | null;
    synthetic: boolean;
    samples: GpuMemorySample[];
    latest: GpuMemorySample | null;
    fittedCtx: number | null;
    contextChanges: GpuContextChange[];
    warnings: GpuWarning[];
}

export interface GpuMetrics {
    backends: GpuBackendMetrics[];
}

function nonnegative(value: unknown): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

export function isGpuEvent(event: ObservatoryEvent): boolean {
    return event.event_type === "backend.gpu_memory.sample" || event.event_type === "backend.warning";
}

/** Nulls, disabled/failed probes and unsampled zero placeholders are never measurements. */
export function gpuMemorySample(event: ObservatoryEvent): GpuMemorySample | null {
    if (event.event_type !== "backend.gpu_memory.sample") {
        return null;
    }
    const a = event.attributes;
    const status = text(a.status);
    const sampleCount = nonnegative(a.samples);
    const usable = (status === null || status === "ok") && sampleCount !== 0;
    const dedicatedBytes = usable ? nonnegative(a.dedicated_bytes) : null;
    const sharedBytes = usable ? nonnegative(a.shared_bytes) : null;
    const spillThresholdBytes = nonnegative(a.spill_threshold_bytes);
    const sharedBaselineBytes = nonnegative(a.shared_baseline_bytes);
    // Older samples may omit the baseline; the producer's documented default is zero.
    // There is deliberately no default threshold when that field is absent.
    const baseline = a.shared_baseline_bytes === undefined ? 0 : sharedBaselineBytes;
    const sum = spillThresholdBytes === null || baseline === null ? null : spillThresholdBytes + baseline;
    const spillLimitBytes = sum !== null && Number.isSafeInteger(sum) ? sum : null;
    const spilled = !usable
        ? null
        : typeof a.spilled === "boolean"
          ? a.spilled
          : sharedBytes !== null && spillLimitBytes !== null
            ? sharedBytes > spillLimitBytes
            : null;
    const ctx = nonnegative(a.fitted_ctx);
    return {
        eventId: event.event_id,
        monoNs: event.mono_ns,
        wallTime: event.wall_time,
        dedicatedBytes,
        sharedBytes,
        spillThresholdBytes,
        sharedBaselineBytes,
        spillLimitBytes,
        spilled,
        fittedCtx: ctx !== null && ctx > 0 ? ctx : null,
        sampleCount,
        status,
        epoch: 0,
    };
}

interface BackendWork {
    metrics: GpuBackendMetrics;
    warnings: Map<string, GpuWarning>;
    warningCounts: Map<string, number>;
    sampleCount: number | null;
    epoch: number;
}

/**
 * First/last seen and warning counts describe retained telemetry, not wall-clock
 * polling. Backend process IDs are not in this contract: scope by producer
 * instance, node and backend, falling back to session when instance is unknown.
 */
export function deriveGpuMemory(events: Iterable<ObservatoryEvent>): GpuMetrics {
    const backends = new Map<string, BackendWork>();
    for (const event of events) {
        if (!isGpuEvent(event)) {
            continue;
        }
        const a = event.attributes;
        const code = event.event_type === "backend.warning" ? text(a.code) : null;
        if (event.event_type === "backend.warning" && code === null) {
            continue;
        }
        const instanceId = producerInstance(event);
        const backend = text(a.backend);
        const key = JSON.stringify([event.producer.name, event.producer.node_id, instanceId, instanceId === null ? event.session_id : null, backend]);
        let work = backends.get(key);
        if (!work) {
            work = {
                metrics: {
                    key, backend, producer: event.producer.name, nodeId: event.producer.node_id,
                    instanceId, synthetic: event.producer.synthetic === true, samples: [], latest: null,
                    fittedCtx: null, contextChanges: [], warnings: [],
                },
                warnings: new Map(), warningCounts: new Map(), sampleCount: null, epoch: 0,
            };
            backends.set(key, work);
        }
        const b = work.metrics;
        b.synthetic ||= event.producer.synthetic === true;
        const sample = gpuMemorySample(event);
        if (sample) {
            if (sample.sampleCount !== null) {
                if (work.sampleCount !== null && sample.sampleCount < work.sampleCount) {
                    work.epoch += 1;
                }
                work.sampleCount = sample.sampleCount;
            }
            sample.epoch = work.epoch;
            b.samples.push(sample);
            b.latest = sample;
            if (Object.hasOwn(a, "fitted_ctx")) {
                const previous = b.contextChanges.at(-1);
                if (!previous || previous.fittedCtx !== sample.fittedCtx) {
                    b.contextChanges.push({ eventId: event.event_id, monoNs: event.mono_ns, fittedCtx: sample.fittedCtx, fitOutcome: text(a.fit_outcome) });
                }
                b.fittedCtx = sample.fittedCtx;
            }
        } else if (code !== null) {
            const existing = work.warnings.get(code);
            // Inference emits the first cumulative snapshot for each distinct
            // code/source/message. Repeated snapshots must not inflate counts;
            // different messages of the same code are independent occurrences.
            const signature = JSON.stringify([code, text(a.source), text(a.message)]);
            const previousCount = work.warningCounts.get(signature) ?? 0;
            const reported = nonnegative(a.count);
            const nextCount = reported !== null && reported > 0 ? Math.max(previousCount, reported) : previousCount + 1;
            work.warningCounts.set(signature, nextCount);
            const count = nextCount - previousCount;
            if (existing) {
                existing.lastSeenNs = event.mono_ns;
                existing.lastSeenWallTime = event.wall_time;
                existing.lastEventId = event.event_id;
                existing.message = text(a.message) ?? existing.message;
                existing.severity = text(a.severity) ?? existing.severity;
                existing.source = text(a.source) ?? existing.source;
                existing.count += count;
            } else {
                const warning: GpuWarning = {
                    code, count, message: text(a.message), severity: text(a.severity), source: text(a.source),
                    firstSeenNs: event.mono_ns, lastSeenNs: event.mono_ns,
                    firstSeenWallTime: event.wall_time, lastSeenWallTime: event.wall_time,
                    firstEventId: event.event_id, lastEventId: event.event_id,
                };
                work.warnings.set(code, warning);
                b.warnings.push(warning);
            }
        }
    }
    return { backends: [...backends.values()].map((w) => w.metrics) };
}
