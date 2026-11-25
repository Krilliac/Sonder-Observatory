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

// ---------------------------------------------------------------------------
// Per-node multi-GPU VRAM inventory (device.memory.sample with kind === "gpu")
// Distinguishes discrete GPUs (e.g. RX 9060 XT, RTX 5070 Ti) from integrated
// UMA GPUs (e.g. Radeon 780M) and computes combined hybrid VRAM pool status.
// ---------------------------------------------------------------------------

const MIB = 1024 * 1024;

/** Minimum active VRAM allocation treated as observed model-weight residency when unreported. */
export const GPU_WEIGHT_ACTIVITY_THRESHOLD_BYTES = 512 * MIB;
/** Minimum VRAM growth above a device's initial sample treated as observed model-weight load. */
export const GPU_WEIGHT_GROWTH_THRESHOLD_BYTES = 256 * MIB;

export type GpuDeviceClass = "discrete" | "integrated-uma" | "unknown";
export type GpuWeightsEvidence = "reported" | "observed-vram" | "none";

export interface NodeGpuDeviceSample {
    eventId: string;
    monoNs: number;
    wallTime: string;
    /** Discrete VRAM total, or BIOS carveout for integrated UMA. */
    dedicatedTotalBytes: number | null;
    /** Discrete VRAM free, or unified free (VRAM + GTT) for integrated UMA. */
    dedicatedFreeBytes: number | null;
    /** Shared system RAM budget (GTT/UMA pool for integrated UMA). */
    sharedTotalBytes: number | null;
    /** Effective usable VRAM total (dedicated for discrete; effective_vram_mib or dedicated+shared for UMA). */
    effectiveTotalBytes: number | null;
    /** Effective usable VRAM free. */
    effectiveFreeBytes: number | null;
    /** Measured or derived used bytes inside the effective VRAM pool. */
    effectiveUsedBytes: number | null;
    /** effectiveUsedBytes / effectiveTotalBytes in [0, 1], or null when unknown. */
    usedFraction: number | null;
    /** Producer-reported model weights resident on this device, if any. */
    modelWeightsBytes: number | null;
    /** Producer-reported flag that this device carries model weights, if present. */
    carryingModelWeights: boolean | null;
}

export interface NodeGpuDeviceMetrics {
    key: string;
    deviceId: string;
    name: string;
    vendor: string | null;
    gpuClass: GpuDeviceClass;
    isIntegratedUma: boolean | null;
    backendHint: string | null;
    source: string | null;
    samples: NodeGpuDeviceSample[];
    latest: NodeGpuDeviceSample | null;
    baselineUsedBytes: number | null;
    peakUsedBytes: number | null;
    carryingModelWeights: boolean;
    weightsEvidence: GpuWeightsEvidence;
}

export interface CombinedGpuPool {
    discreteCount: number;
    integratedUmaCount: number;
    unknownCount: number;
    discreteTotalBytes: number | null;
    discreteUsedBytes: number | null;
    discreteFreeBytes: number | null;
    umaTotalBytes: number | null;
    umaUsedBytes: number | null;
    umaFreeBytes: number | null;
    combinedTotalBytes: number | null;
    combinedUsedBytes: number | null;
    combinedFreeBytes: number | null;
    combinedUsedFraction: number | null;
    reportedCombinedTotalBytes: number | null;
    isHybridDiscreteUma: boolean;
    /** True when at least one discrete GPU AND at least one integrated UMA GPU both carry model weights. */
    bothCarryingWeights: boolean;
    /** True when two or more GPUs on this node simultaneously carry model weights. */
    multiGpuActive: boolean;
    weightsEvidence: GpuWeightsEvidence;
    activeDevices: string[];
}

export interface NodeGpuMetrics {
    key: string;
    nodeId: string;
    producer: string;
    instanceId: string | null;
    synthetic: boolean;
    devices: NodeGpuDeviceMetrics[];
    combinedPool: CombinedGpuPool | null;
    latestWallTime: string | null;
}

export interface MultiGpuMetrics {
    nodes: NodeGpuMetrics[];
}

function mibToBytes(value: unknown): number | null {
    const mib = nonnegative(value);
    if (mib === null) {
        return null;
    }
    const bytes = mib * MIB;
    return Number.isSafeInteger(bytes) ? bytes : null;
}

function safeAdd(a: number | null, b: number | null): number | null {
    if (a === null || b === null) {
        return null;
    }
    const sum = a + b;
    return Number.isSafeInteger(sum) ? sum : null;
}

function stringList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function sumAllKnown(values: readonly (number | null)[]): number | null {
    if (values.length === 0) {
        return null;
    }
    let total = 0;
    for (const v of values) {
        if (v === null) {
            return null;
        }
        total += v;
        if (!Number.isSafeInteger(total)) {
            return null;
        }
    }
    return total;
}

/** True for events carrying per-device GPU inventory or multi-GPU pool placement metadata. */
export function isNodeGpuDeviceEvent(event: ObservatoryEvent): boolean {
    if (event.event_type === "device.memory.sample") {
        return event.attributes.kind === "gpu";
    }
    if (event.event_type === "model.load.completed" || event.event_type === "backend.gpu_memory.sample") {
        const a = event.attributes;
        return (
            nonnegative(a.combined_gpu_vram_mib) !== null ||
            stringList(a.recommended_devices).length > 0 ||
            stringList(a.active_devices).length > 0 ||
            stringList(a.devices).length > 0
        );
    }
    return false;
}

/** Parses one `device.memory.sample` with `kind === "gpu"`. Returns null for other events. */
export function nodeGpuDeviceSample(event: ObservatoryEvent): NodeGpuDeviceSample | null {
    if (event.event_type !== "device.memory.sample" || event.attributes.kind !== "gpu") {
        return null;
    }
    const a = event.attributes;
    const isUma = typeof a.is_integrated_uma === "boolean" ? a.is_integrated_uma : null;
    const dedicatedTotalBytes = nonnegative(a.dedicated_total_bytes);
    const dedicatedFreeBytes = nonnegative(a.dedicated_free_bytes);
    const sharedTotalBytes = nonnegative(a.shared_total_bytes);
    const genericTotalBytes = nonnegative(a.total_bytes);
    const genericAvailableBytes = nonnegative(a.available_bytes);
    const genericUsedBytes = nonnegative(a.used_bytes);
    const effectiveVramBytes = mibToBytes(a.effective_vram_mib);
    const effectiveFreeVramBytes = mibToBytes(a.effective_free_vram_mib);
    const usedVramMibBytes = mibToBytes(a.used_vram_mib);

    let effectiveTotalBytes: number | null;
    let effectiveFreeBytes: number | null;
    let effectiveUsedBytes: number | null;

    if (isUma === true) {
        // Integrated UMA (e.g. Radeon 780M): effective VRAM spans BIOS carveout + shared GTT.
        effectiveTotalBytes =
            effectiveVramBytes ??
            (dedicatedTotalBytes !== null && sharedTotalBytes !== null ? safeAdd(dedicatedTotalBytes, sharedTotalBytes) : null) ??
            sharedTotalBytes ??
            dedicatedTotalBytes;
        const candidateFree = effectiveFreeVramBytes ?? dedicatedFreeBytes;
        effectiveFreeBytes =
            candidateFree !== null && (effectiveTotalBytes === null || candidateFree <= effectiveTotalBytes) ? candidateFree : null;
        if (usedVramMibBytes !== null && (effectiveTotalBytes === null || usedVramMibBytes <= effectiveTotalBytes)) {
            effectiveUsedBytes = usedVramMibBytes;
        } else if (genericUsedBytes !== null && (effectiveTotalBytes === null || genericUsedBytes <= effectiveTotalBytes)) {
            effectiveUsedBytes = genericUsedBytes;
        } else if (effectiveTotalBytes !== null && effectiveFreeBytes !== null && effectiveTotalBytes >= effectiveFreeBytes) {
            effectiveUsedBytes = effectiveTotalBytes - effectiveFreeBytes;
        } else {
            effectiveUsedBytes = null;
        }
    } else {
        effectiveTotalBytes = dedicatedTotalBytes ?? genericTotalBytes ?? effectiveVramBytes;
        const candidateFree = dedicatedFreeBytes ?? genericAvailableBytes ?? effectiveFreeVramBytes;
        effectiveFreeBytes =
            candidateFree !== null && (effectiveTotalBytes === null || candidateFree <= effectiveTotalBytes) ? candidateFree : null;
        if (genericUsedBytes !== null && (effectiveTotalBytes === null || genericUsedBytes <= effectiveTotalBytes)) {
            effectiveUsedBytes = genericUsedBytes;
        } else if (usedVramMibBytes !== null && (effectiveTotalBytes === null || usedVramMibBytes <= effectiveTotalBytes)) {
            effectiveUsedBytes = usedVramMibBytes;
        } else if (effectiveTotalBytes !== null && effectiveFreeBytes !== null && effectiveTotalBytes >= effectiveFreeBytes) {
            effectiveUsedBytes = effectiveTotalBytes - effectiveFreeBytes;
        } else {
            effectiveUsedBytes = null;
        }
    }

    const usedFraction =
        effectiveTotalBytes !== null && effectiveTotalBytes > 0 && effectiveUsedBytes !== null
            ? Math.max(0, Math.min(1, effectiveUsedBytes / effectiveTotalBytes))
            : null;

    const modelWeightsBytes = nonnegative(a.model_weights_bytes) ?? mibToBytes(a.model_weights_mib);
    const carryingModelWeights =
        typeof a.carrying_model_weights === "boolean"
            ? a.carrying_model_weights
            : modelWeightsBytes !== null
              ? modelWeightsBytes > 0
              : null;

    return {
        eventId: event.event_id,
        monoNs: event.mono_ns,
        wallTime: event.wall_time,
        dedicatedTotalBytes,
        dedicatedFreeBytes,
        sharedTotalBytes,
        effectiveTotalBytes,
        effectiveFreeBytes,
        effectiveUsedBytes,
        usedFraction,
        modelWeightsBytes,
        carryingModelWeights,
    };
}

interface NodeGpuWork {
    key: string;
    nodeId: string;
    producer: string;
    instanceId: string | null;
    synthetic: boolean;
    devices: Map<string, NodeGpuDeviceMetrics>;
    reportedCombinedTotalBytes: number | null;
    activeDevices: string[];
    /** True only when activeDevices came from actual active/loaded device lists (not planner-only recommendations). */
    activeDevicesConfirmed: boolean;
    combinedPoolActiveReported: boolean | null;
    latestWallTime: string | null;
}

function classifyDeviceWeights(
    device: NodeGpuDeviceMetrics,
    activeDeviceSet: ReadonlySet<string>,
    activeDeviceCount: number,
    activeDevicesConfirmed: boolean,
    nodeDeviceCount: number,
): { carrying: boolean; evidence: GpuWeightsEvidence } {
    const latest = device.latest;
    if (!latest) {
        return { carrying: false, evidence: "none" };
    }
    if (latest.carryingModelWeights === true) {
        return { carrying: true, evidence: "reported" };
    }
    if (latest.carryingModelWeights === false) {
        return { carrying: false, evidence: "none" };
    }
    if (activeDevicesConfirmed) {
        if (activeDeviceSet.has(device.deviceId.toLowerCase()) || activeDeviceSet.has(device.name.toLowerCase())) {
            return { carrying: true, evidence: "reported" };
        }
        if (activeDeviceCount >= 2 && activeDeviceCount >= nodeDeviceCount && nodeDeviceCount >= 2) {
            // E.g. producer reported active_devices=["Vulkan0", "Vulkan1"] on a 2-GPU node.
            return { carrying: true, evidence: "reported" };
        }
    }
    const used = latest.effectiveUsedBytes;
    if (used !== null) {
        if (device.baselineUsedBytes !== null && used - device.baselineUsedBytes >= GPU_WEIGHT_GROWTH_THRESHOLD_BYTES) {
            return { carrying: true, evidence: "observed-vram" };
        }
        if (used >= GPU_WEIGHT_ACTIVITY_THRESHOLD_BYTES) {
            return { carrying: true, evidence: "observed-vram" };
        }
    }
    return { carrying: false, evidence: "none" };
}

function buildCombinedPool(work: NodeGpuWork, devices: readonly NodeGpuDeviceMetrics[]): CombinedGpuPool | null {
    if (devices.length < 2) {
        return null;
    }
    const discrete = devices.filter((d) => d.gpuClass === "discrete");
    const uma = devices.filter((d) => d.gpuClass === "integrated-uma");
    const unknown = devices.filter((d) => d.gpuClass === "unknown");

    const discreteTotalBytes = sumAllKnown(discrete.map((d) => d.latest?.effectiveTotalBytes ?? null));
    const discreteUsedBytes = sumAllKnown(discrete.map((d) => d.latest?.effectiveUsedBytes ?? null));
    const discreteFreeBytes = sumAllKnown(discrete.map((d) => d.latest?.effectiveFreeBytes ?? null));
    const umaTotalBytes = sumAllKnown(uma.map((d) => d.latest?.effectiveTotalBytes ?? null));
    const umaUsedBytes = sumAllKnown(uma.map((d) => d.latest?.effectiveUsedBytes ?? null));
    const umaFreeBytes = sumAllKnown(uma.map((d) => d.latest?.effectiveFreeBytes ?? null));

    const summedTotal = sumAllKnown(devices.map((d) => d.latest?.effectiveTotalBytes ?? null));
    const combinedTotalBytes = summedTotal ?? work.reportedCombinedTotalBytes;
    const combinedUsedBytes = sumAllKnown(devices.map((d) => d.latest?.effectiveUsedBytes ?? null));
    const combinedFreeBytes = sumAllKnown(devices.map((d) => d.latest?.effectiveFreeBytes ?? null));
    const combinedUsedFraction =
        combinedTotalBytes !== null && combinedTotalBytes > 0 && combinedUsedBytes !== null
            ? Math.max(0, Math.min(1, combinedUsedBytes / combinedTotalBytes))
            : null;

    const isHybridDiscreteUma = discrete.length > 0 && uma.length > 0;
    const discreteCarrying = discrete.filter((d) => d.carryingModelWeights);
    const umaCarrying = uma.filter((d) => d.carryingModelWeights);
    const anyCarrying = devices.filter((d) => d.carryingModelWeights);

    const bothCarryingWeights =
        work.combinedPoolActiveReported === true
            ? isHybridDiscreteUma
            : work.combinedPoolActiveReported === false
              ? false
              : isHybridDiscreteUma && discreteCarrying.length > 0 && umaCarrying.length > 0;
    const multiGpuActive = bothCarryingWeights || anyCarrying.length >= 2;

    let weightsEvidence: GpuWeightsEvidence = "none";
    if (work.combinedPoolActiveReported === true) {
        weightsEvidence = "reported";
    } else if (bothCarryingWeights || multiGpuActive) {
        const relevant = bothCarryingWeights ? [...discreteCarrying, ...umaCarrying] : anyCarrying;
        weightsEvidence = relevant.some((d) => d.weightsEvidence === "reported") ? "reported" : "observed-vram";
    }

    return {
        discreteCount: discrete.length,
        integratedUmaCount: uma.length,
        unknownCount: unknown.length,
        discreteTotalBytes,
        discreteUsedBytes,
        discreteFreeBytes,
        umaTotalBytes,
        umaUsedBytes,
        umaFreeBytes,
        combinedTotalBytes,
        combinedUsedBytes,
        combinedFreeBytes,
        combinedUsedFraction,
        reportedCombinedTotalBytes: work.reportedCombinedTotalBytes,
        isHybridDiscreteUma,
        bothCarryingWeights,
        multiGpuActive,
        weightsEvidence,
        activeDevices: work.activeDevices,
    };
}

/**
 * Derives per-node multi-GPU VRAM inventory from `device.memory.sample` events
 * with `kind === "gpu"`. Isolates nodes/instances cleanly so dual-PC setups
 * (e.g. workstation + Node1) each show their own GPU breakdown and hybrid
 * discrete + integrated UMA combined pool indicator.
 */
export function deriveNodeGpuMemory(events: Iterable<ObservatoryEvent>): MultiGpuMetrics {
    const nodes = new Map<string, NodeGpuWork>();

    const getOrCreateNode = (event: ObservatoryEvent): NodeGpuWork => {
        const instanceId = producerInstance(event);
        const key = JSON.stringify([event.producer.name, event.producer.node_id, instanceId, instanceId === null ? event.session_id : null]);
        let work = nodes.get(key);
        if (!work) {
            work = {
                key,
                nodeId: event.producer.node_id,
                producer: event.producer.name,
                instanceId,
                synthetic: event.producer.synthetic === true,
                devices: new Map(),
                reportedCombinedTotalBytes: null,
                activeDevices: [],
                activeDevicesConfirmed: false,
                combinedPoolActiveReported: null,
                latestWallTime: null,
            };
            nodes.set(key, work);
        }
        work.synthetic ||= event.producer.synthetic === true;
        return work;
    };

    for (const event of events) {
        if (!isNodeGpuDeviceEvent(event)) {
            continue;
        }
        const a = event.attributes;
        if (event.event_type !== "device.memory.sample") {
            if (event.event_type === "model.load.completed" && a.resident === false) {
                continue;
            }
            // Optional placement/pool metadata attached to model.load.completed or backend.gpu_memory.sample.
            // Nodes without any GPU device samples are skipped when assembling the final list.
            const work = getOrCreateNode(event);
            const reportedCombined = mibToBytes(a.combined_gpu_vram_mib);
            if (reportedCombined !== null) {
                work.reportedCombinedTotalBytes = reportedCombined;
            }
            const devs = stringList(a.active_devices);
            const loadDevs = stringList(a.devices);
            const rec = stringList(a.recommended_devices);
            if (devs.length > 0) {
                work.activeDevices = devs;
                work.activeDevicesConfirmed = true;
            } else if (loadDevs.length > 0) {
                work.activeDevices = loadDevs;
                work.activeDevicesConfirmed = true;
            } else if (rec.length > 0) {
                work.activeDevices = rec;
            }
            if (typeof a.combined_pool_active === "boolean") {
                work.combinedPoolActiveReported = a.combined_pool_active;
            }
            continue;
        }

        const sample = nodeGpuDeviceSample(event);
        if (!sample) {
            continue;
        }
        const work = getOrCreateNode(event);
        work.latestWallTime = event.wall_time || work.latestWallTime;

        const reportedCombined = mibToBytes(a.combined_gpu_vram_mib);
        if (reportedCombined !== null) {
            work.reportedCombinedTotalBytes = reportedCombined;
        }
        const activeDevs = stringList(a.active_devices);
        const recDevs = stringList(a.recommended_devices);
        if (activeDevs.length > 0) {
            work.activeDevices = activeDevs;
            work.activeDevicesConfirmed = true;
        } else if (recDevs.length > 0) {
            work.activeDevices = recDevs;
        }
        if (typeof a.combined_pool_active === "boolean") {
            work.combinedPoolActiveReported = a.combined_pool_active;
        }

        const deviceId = text(event.device_id) ?? text(a.name) ?? `gpu:${work.devices.size}`;
        const name = text(a.name) ?? deviceId;
        const isUma = typeof a.is_integrated_uma === "boolean" ? a.is_integrated_uma : null;
        const gpuClass: GpuDeviceClass = isUma === true ? "integrated-uma" : isUma === false ? "discrete" : "unknown";
        let dev = work.devices.get(deviceId);
        if (!dev) {
            dev = {
                key: JSON.stringify([work.key, deviceId]),
                deviceId,
                name,
                vendor: text(a.vendor),
                gpuClass,
                isIntegratedUma: isUma,
                backendHint: text(a.backend_hint),
                source: text(a.source),
                samples: [],
                latest: null,
                baselineUsedBytes: null,
                peakUsedBytes: null,
                carryingModelWeights: false,
                weightsEvidence: "none",
            };
            work.devices.set(deviceId, dev);
        } else {
            dev.name = text(a.name) ?? dev.name;
            dev.vendor = text(a.vendor) ?? dev.vendor;
            if (isUma !== null) {
                dev.isIntegratedUma = isUma;
                dev.gpuClass = isUma ? "integrated-uma" : "discrete";
            }
            dev.backendHint = text(a.backend_hint) ?? dev.backendHint;
            dev.source = text(a.source) ?? dev.source;
        }
        dev.samples.push(sample);
        dev.latest = sample;
        if (dev.baselineUsedBytes === null && sample.effectiveUsedBytes !== null) {
            dev.baselineUsedBytes = sample.effectiveUsedBytes;
        }
        if (sample.effectiveUsedBytes !== null && (dev.peakUsedBytes === null || sample.effectiveUsedBytes > dev.peakUsedBytes)) {
            dev.peakUsedBytes = sample.effectiveUsedBytes;
        }
    }

    const result: NodeGpuMetrics[] = [];
    for (const work of nodes.values()) {
        if (work.devices.size === 0) {
            continue;
        }
        const devices = [...work.devices.values()];
        const activeDeviceSet = new Set(work.activeDevices.map((d) => d.toLowerCase()));
        for (const device of devices) {
            const w = classifyDeviceWeights(device, activeDeviceSet, work.activeDevices.length, work.activeDevicesConfirmed, devices.length);
            device.carryingModelWeights = w.carrying;
            device.weightsEvidence = w.evidence;
        }
        result.push({
            key: work.key,
            nodeId: work.nodeId,
            producer: work.producer,
            instanceId: work.instanceId,
            synthetic: work.synthetic,
            devices,
            combinedPool: buildCombinedPool(work, devices),
            latestWallTime: work.latestWallTime,
        });
    }
    return { nodes: result };
}
