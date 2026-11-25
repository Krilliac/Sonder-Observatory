/**
 * Backend GPU telemetry (Sonder-Inference's vram-spill-guard contract).
 * Kept separate from Metrics so legacy resource/token calculations are unchanged.
 * Input is deduplicated replay order, as supplied by SessionStore/orderEvents.
 */
import type { ObservatoryEvent } from "../protocol/events";
import { producerInstance } from "./attributes";

export type GpuDeviceClass = "discrete" | "integrated-uma" | "unknown";
export type GpuMemoryMode = "discrete-gddr" | "integrated-uma" | "hybrid-uma" | "unknown";
export type GpuWeightsEvidence = "reported" | "observed-vram" | "none";

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
    /** Optional per-GPU & UMA semantics (populated by gpuMemorySample / deriveGpuMemory). */
    deviceId?: string | null;
    gpuClass?: GpuDeviceClass;
    memoryMode?: GpuMemoryMode;
    isIntegratedUma?: boolean | null;
    umaMode?: boolean | null;
    memoryKind?: string | null;
    /** True when shared memory on this sample reflects intentional UMA / hybrid UMA pooling rather than discrete GDDR spill. */
    umaIntentionalShared?: boolean;
    dedicatedTotalBytes?: number | null;
    sharedTotalBytes?: number | null;
    effectiveTotalBytes?: number | null;
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
    /** Optional per-GPU identity & UMA pool semantics (populated by deriveGpuMemory). */
    deviceId?: string | null;
    deviceName?: string | null;
    gpuClass?: GpuDeviceClass;
    memoryMode?: GpuMemoryMode;
    isIntegratedUma?: boolean | null;
    umaMode?: boolean | null;
    dedicatedTotalBytes?: number | null;
    sharedTotalBytes?: number | null;
    effectiveTotalBytes?: number | null;
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

function trimmedText(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function backendDeviceId(event: ObservatoryEvent): string | null {
    const a = event.attributes;
    return trimmedText(event.device_id) ?? trimmedText(a.device_id) ?? trimmedText(a.gpu_device_id) ?? trimmedText(a.device);
}

const HYBRID_UMA_TOKENS = new Set(["hybrid", "hybrid_uma", "hybrid-uma", "hybrid_pool", "hybrid-pool", "combined_uma", "combined-uma", "mixed"]);
const INTEGRATED_UMA_TOKENS = new Set([
    "uma",
    "integrated_uma",
    "integrated-uma",
    "integrated",
    "unified",
    "unified_memory",
    "unified-memory",
    "gtt",
    "shared_uma",
    "shared-uma",
    "igpu",
    "apu",
]);
const DISCRETE_GDDR_TOKENS = new Set(["discrete", "discrete_gddr", "discrete-gddr", "gddr", "dgpu", "dedicated", "vram"]);

function parseUmaModeAttr(value: unknown): { enabled: boolean | null; hybrid: boolean } {
    if (typeof value === "boolean") {
        return { enabled: value, hybrid: false };
    }
    const raw = trimmedText(value);
    if (raw === null) {
        return { enabled: null, hybrid: false };
    }
    const norm = raw.toLowerCase();
    if (HYBRID_UMA_TOKENS.has(norm)) {
        return { enabled: true, hybrid: true };
    }
    if (norm === "on" || norm === "true" || INTEGRATED_UMA_TOKENS.has(norm)) {
        return { enabled: true, hybrid: false };
    }
    if (norm === "off" || norm === "false" || DISCRETE_GDDR_TOKENS.has(norm)) {
        return { enabled: false, hybrid: false };
    }
    return { enabled: null, hybrid: false };
}

function parseMemoryKindAttr(a: Record<string, unknown>): { memoryKind: string | null; kindMode: GpuMemoryMode } {
    const candidates = [a.memory_kind, a.gpu_memory_kind, a.memory_mode, a.pool_kind, a.gpu_class, a.device_class, a.kind];
    let firstRaw: string | null = null;
    for (const candidate of candidates) {
        const raw = trimmedText(candidate);
        if (raw === null) {
            continue;
        }
        if (firstRaw === null) {
            firstRaw = raw;
        }
        const norm = raw.toLowerCase();
        if (HYBRID_UMA_TOKENS.has(norm)) {
            return { memoryKind: raw, kindMode: "hybrid-uma" };
        }
        if (INTEGRATED_UMA_TOKENS.has(norm)) {
            return { memoryKind: raw, kindMode: "integrated-uma" };
        }
        if (DISCRETE_GDDR_TOKENS.has(norm)) {
            return { memoryKind: raw, kindMode: "discrete-gddr" };
        }
    }
    return { memoryKind: firstRaw, kindMode: "unknown" };
}

interface SampleMemorySemantics {
    gpuClass: GpuDeviceClass;
    memoryMode: GpuMemoryMode;
    isIntegratedUma: boolean | null;
    umaMode: boolean | null;
    memoryKind: string | null;
    umaIntentionalShared: boolean;
    explicitDiscrete: boolean;
    explicitDiscreteSpilled: boolean;
}

function parseSampleMemorySemantics(a: Record<string, unknown>): SampleMemorySemantics {
    const isIntegratedUma = typeof a.is_integrated_uma === "boolean" ? a.is_integrated_uma : null;
    const umaParsed = parseUmaModeAttr(a.uma_mode);
    const { memoryKind, kindMode } = parseMemoryKindAttr(a);
    const explicitHybridFlag = a.hybrid_uma === true || a.is_hybrid_uma === true || a.hybrid_pool === true || a.combined_pool_active === true;
    const explicitHybrid = explicitHybridFlag || umaParsed.hybrid || kindMode === "hybrid-uma";
    const explicitDiscreteSpilled = typeof a.discrete_spilled === "boolean";

    if (isIntegratedUma === true) {
        return {
            gpuClass: "integrated-uma",
            memoryMode: explicitHybrid ? "hybrid-uma" : "integrated-uma",
            isIntegratedUma: true,
            umaMode: umaParsed.enabled ?? true,
            memoryKind,
            umaIntentionalShared: true,
            explicitDiscrete: false,
            explicitDiscreteSpilled,
        };
    }
    if (explicitHybrid && umaParsed.enabled !== false) {
        return {
            gpuClass: isIntegratedUma === false ? "discrete" : "unknown",
            memoryMode: "hybrid-uma",
            isIntegratedUma,
            umaMode: true,
            memoryKind,
            umaIntentionalShared: true,
            explicitDiscrete: false,
            explicitDiscreteSpilled,
        };
    }
    if (umaParsed.enabled === true) {
        return {
            gpuClass: isIntegratedUma === false ? "discrete" : "integrated-uma",
            memoryMode: isIntegratedUma === false ? "hybrid-uma" : "integrated-uma",
            isIntegratedUma,
            umaMode: true,
            memoryKind,
            umaIntentionalShared: true,
            explicitDiscrete: false,
            explicitDiscreteSpilled,
        };
    }
    if (kindMode === "integrated-uma" && isIntegratedUma !== false && umaParsed.enabled !== false) {
        return {
            gpuClass: "integrated-uma",
            memoryMode: "integrated-uma",
            isIntegratedUma: true,
            umaMode: umaParsed.enabled ?? true,
            memoryKind,
            umaIntentionalShared: true,
            explicitDiscrete: false,
            explicitDiscreteSpilled,
        };
    }
    if (isIntegratedUma === false || kindMode === "discrete-gddr" || umaParsed.enabled === false) {
        return {
            gpuClass: "discrete",
            memoryMode: "discrete-gddr",
            isIntegratedUma: isIntegratedUma ?? false,
            umaMode: umaParsed.enabled ?? false,
            memoryKind,
            umaIntentionalShared: false,
            explicitDiscrete: true,
            explicitDiscreteSpilled,
        };
    }
    return {
        gpuClass: "unknown",
        memoryMode: "unknown",
        isIntegratedUma: null,
        umaMode: null,
        memoryKind,
        umaIntentionalShared: false,
        explicitDiscrete: false,
        explicitDiscreteSpilled,
    };
}

export function isGpuEvent(event: ObservatoryEvent): boolean {
    return event.event_type === "backend.gpu_memory.sample" || event.event_type === "backend.warning";
}

/** True for any event that can affect `deriveGpuMemory` (backend samples/warnings plus GPU device/pool context). */
export function isGpuBackendIndexEvent(event: ObservatoryEvent): boolean {
    return isGpuEvent(event) || isNodeGpuDeviceEvent(event);
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
    const semantics = parseSampleMemorySemantics(a);
    let spilled: boolean | null;
    if (!usable) {
        spilled = null;
    } else if (typeof a.discrete_spilled === "boolean") {
        spilled = a.discrete_spilled;
    } else if (semantics.umaIntentionalShared) {
        // Intentional UMA / hybrid UMA shared allocations are primary unified memory, not discrete GDDR spill.
        spilled = false;
    } else if (typeof a.spilled === "boolean") {
        spilled = a.spilled;
    } else if (sharedBytes !== null && spillLimitBytes !== null) {
        spilled = sharedBytes > spillLimitBytes;
    } else {
        spilled = null;
    }
    const ctx = nonnegative(a.fitted_ctx);
    const dedicatedTotalBytes = nonnegative(a.dedicated_total_bytes);
    const sharedTotalBytes = nonnegative(a.shared_total_bytes);
    const effectiveTotalBytes =
        mibToBytes(a.effective_vram_mib) ??
        nonnegative(a.effective_total_bytes) ??
        (semantics.memoryMode === "integrated-uma"
            ? (safeAdd(dedicatedTotalBytes, sharedTotalBytes) ?? sharedTotalBytes ?? dedicatedTotalBytes)
            : dedicatedTotalBytes);
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
        deviceId: backendDeviceId(event),
        gpuClass: semantics.gpuClass,
        memoryMode: semantics.memoryMode,
        isIntegratedUma: semantics.isIntegratedUma,
        umaMode: semantics.umaMode,
        memoryKind: semantics.memoryKind,
        umaIntentionalShared: semantics.umaIntentionalShared,
        dedicatedTotalBytes,
        sharedTotalBytes,
        effectiveTotalBytes,
    };
}

interface SampleFlags {
    usable: boolean;
    explicitDiscrete: boolean;
    explicitDiscreteSpilled: boolean;
}

interface BackendWork {
    nodeScopeKey: string;
    metrics: GpuBackendMetrics;
    sampleFlags: SampleFlags[];
    warnings: Map<string, GpuWarning>;
    warningCounts: Map<string, number>;
    sampleCount: number | null;
    epoch: number;
    activeDevices: string[];
}

function matchSingleDeviceToken(token: string, devices: readonly NodeGpuDeviceMetrics[]): NodeGpuDeviceMetrics | null {
    const norm = token.trim().toLowerCase();
    if (norm.length === 0) {
        return null;
    }
    const exact = devices.find((d) => d.deviceId.toLowerCase() === norm || d.name.toLowerCase() === norm);
    if (exact) {
        return exact;
    }
    const gpuIdx = /^gpu:(\d+)$/.exec(norm);
    if (gpuIdx) {
        const idx = Number(gpuIdx[1]);
        return idx >= 0 && idx < devices.length ? (devices[idx] ?? null) : null;
    }
    const apiIdx = /^(vulkan|rocm|cuda|metal|hip)(\d+)$/.exec(norm);
    if (apiIdx) {
        const api = apiIdx[1]!;
        const idx = Number(apiIdx[2]);
        const filtered = devices.filter((d) => {
            const hint = d.backendHint?.toLowerCase() ?? null;
            const vendor = d.vendor?.toLowerCase() ?? null;
            if (api === "cuda") {
                return hint === "cuda" || vendor === "nvidia";
            }
            if (api === "rocm" || api === "hip") {
                return hint === "rocm" || hint === "hip" || vendor === "amd";
            }
            if (api === "metal") {
                return hint === "metal" || vendor === "apple";
            }
            // Vulkan enumerates every Vulkan-capable GPU on the host.
            return hint === null || hint === "vulkan" || hint === "rocm" || hint === "cuda";
        });
        return idx >= 0 && idx < filtered.length ? (filtered[idx] ?? null) : null;
    }
    return null;
}

function resolveMatchingDevices(deviceRef: string, devices: readonly NodeGpuDeviceMetrics[]): NodeGpuDeviceMetrics[] {
    if (devices.length === 0) {
        return [];
    }
    const exact = matchSingleDeviceToken(deviceRef, devices);
    if (exact) {
        return [exact];
    }
    if (!deviceRef.includes(",")) {
        return [];
    }
    const matched: NodeGpuDeviceMetrics[] = [];
    const seen = new Set<string>();
    for (const part of deviceRef.split(",")) {
        const dev = matchSingleDeviceToken(part, devices);
        if (dev && !seen.has(dev.deviceId)) {
            seen.add(dev.deviceId);
            matched.push(dev);
        }
    }
    return matched;
}

function enrichBackendFromNode(work: BackendWork, node: NodeGpuMetrics | undefined): void {
    const b = work.metrics;
    const devices = node?.devices ?? [];
    const deviceId = b.deviceId ?? null;

    let matchedDevices: NodeGpuDeviceMetrics[] = [];
    if (deviceId !== null && devices.length > 0) {
        matchedDevices = resolveMatchingDevices(deviceId, devices);
    }

    let inferredMode: GpuMemoryMode = "unknown";
    let inferredClass: GpuDeviceClass = "unknown";
    let inferredIsUma: boolean | null = null;
    let inferredName: string | null = null;
    let inferredDedicatedTotal: number | null = null;
    let inferredSharedTotal: number | null = null;
    let inferredEffectiveTotal: number | null = null;

    if (matchedDevices.length === 1) {
        const dev = matchedDevices[0]!;
        inferredName = dev.name;
        inferredClass = dev.gpuClass;
        inferredIsUma = dev.isIntegratedUma;
        inferredMode = dev.gpuClass === "integrated-uma" ? "integrated-uma" : dev.gpuClass === "discrete" ? "discrete-gddr" : "unknown";
        inferredDedicatedTotal = dev.latest?.dedicatedTotalBytes ?? null;
        inferredSharedTotal = dev.latest?.sharedTotalBytes ?? null;
        inferredEffectiveTotal = dev.latest?.effectiveTotalBytes ?? null;
    } else if (matchedDevices.length >= 2) {
        const hasDiscrete = matchedDevices.some((d) => d.gpuClass === "discrete");
        const hasUma = matchedDevices.some((d) => d.gpuClass === "integrated-uma");
        if (hasDiscrete && hasUma) {
            inferredMode = "hybrid-uma";
            inferredEffectiveTotal = node?.combinedPool?.combinedTotalBytes ?? null;
        } else if (hasUma && !hasDiscrete) {
            inferredMode = "integrated-uma";
            inferredClass = "integrated-uma";
            inferredIsUma = true;
            inferredEffectiveTotal = node?.combinedPool?.umaTotalBytes ?? null;
        } else if (hasDiscrete && !hasUma) {
            inferredMode = "discrete-gddr";
            inferredClass = "discrete";
            inferredIsUma = false;
            inferredEffectiveTotal = node?.combinedPool?.discreteTotalBytes ?? null;
        }
    } else if (deviceId === null && devices.length > 0) {
        const discreteDevices = devices.filter((d) => d.gpuClass === "discrete");
        const umaDevices = devices.filter((d) => d.gpuClass === "integrated-uma");
        if (umaDevices.length > 0 && discreteDevices.length === 0) {
            // Pure integrated UMA host (no discrete GPU present).
            inferredMode = "integrated-uma";
            inferredClass = "integrated-uma";
            inferredIsUma = true;
            if (devices.length === 1) {
                const only = devices[0]!;
                inferredName = only.name;
                inferredDedicatedTotal = only.latest?.dedicatedTotalBytes ?? null;
                inferredSharedTotal = only.latest?.sharedTotalBytes ?? null;
                inferredEffectiveTotal = only.latest?.effectiveTotalBytes ?? null;
            } else {
                inferredEffectiveTotal = node?.combinedPool?.umaTotalBytes ?? null;
            }
        } else if (discreteDevices.length > 0 && umaDevices.length > 0) {
            // Hybrid discrete + UMA host: treat process-wide samples as hybrid-UMA ONLY when
            // the UMA device is actively participating in the pool (never mask pure-discrete spills).
            const explicitActive = work.activeDevices.flatMap((token) => resolveMatchingDevices(token, devices));
            const activeIncludesUma = explicitActive.some((d) => d.gpuClass === "integrated-uma");
            const activePool = node?.combinedPool;
            const umaCarrying = umaDevices.some((d) => d.carryingModelWeights);
            if (activeIncludesUma || activePool?.bothCarryingWeights === true || umaCarrying) {
                inferredMode = "hybrid-uma";
                inferredEffectiveTotal = activePool?.combinedTotalBytes ?? null;
            }
        } else if (discreteDevices.length > 0 && umaDevices.length === 0) {
            inferredMode = "discrete-gddr";
            inferredClass = "discrete";
            inferredIsUma = false;
            if (devices.length === 1) {
                const only = devices[0]!;
                inferredName = only.name;
                inferredDedicatedTotal = only.latest?.dedicatedTotalBytes ?? null;
                inferredSharedTotal = only.latest?.sharedTotalBytes ?? null;
                inferredEffectiveTotal = only.latest?.effectiveTotalBytes ?? null;
            }
        }
    }

    if (b.deviceName == null && inferredName !== null) {
        b.deviceName = inferredName;
    }

    const inferredUmaIntentional = inferredMode === "integrated-uma" || inferredMode === "hybrid-uma";
    for (let i = 0; i < b.samples.length; i += 1) {
        const sample = b.samples[i]!;
        const flags = work.sampleFlags[i]!;
        if ((sample.memoryMode ?? "unknown") === "unknown" && inferredMode !== "unknown" && !flags.explicitDiscrete) {
            sample.memoryMode = inferredMode;
            if ((sample.gpuClass ?? "unknown") === "unknown" && inferredClass !== "unknown") {
                sample.gpuClass = inferredClass;
            }
            if (sample.isIntegratedUma == null && inferredIsUma !== null) {
                sample.isIntegratedUma = inferredIsUma;
            }
            if (inferredUmaIntentional) {
                sample.umaMode = sample.umaMode ?? true;
                sample.umaIntentionalShared = true;
                if (flags.usable && !flags.explicitDiscreteSpilled) {
                    sample.spilled = false;
                }
            }
        }
        if (sample.dedicatedTotalBytes == null && inferredDedicatedTotal !== null) {
            sample.dedicatedTotalBytes = inferredDedicatedTotal;
        }
        if (sample.sharedTotalBytes == null && inferredSharedTotal !== null) {
            sample.sharedTotalBytes = inferredSharedTotal;
        }
        if (sample.effectiveTotalBytes == null && inferredEffectiveTotal !== null) {
            sample.effectiveTotalBytes = inferredEffectiveTotal;
        }
    }

    const latest = b.latest ?? b.samples.at(-1) ?? null;
    b.memoryMode = latest?.memoryMode ?? (inferredMode !== "unknown" ? inferredMode : "unknown");
    b.gpuClass = latest?.gpuClass ?? (inferredClass !== "unknown" ? inferredClass : "unknown");
    b.isIntegratedUma = latest?.isIntegratedUma ?? inferredIsUma;
    b.umaMode = latest?.umaMode ?? (b.memoryMode === "integrated-uma" || b.memoryMode === "hybrid-uma" ? true : b.memoryMode === "discrete-gddr" ? false : null);
    b.dedicatedTotalBytes = latest?.dedicatedTotalBytes ?? inferredDedicatedTotal;
    b.sharedTotalBytes = latest?.sharedTotalBytes ?? inferredSharedTotal;
    b.effectiveTotalBytes = latest?.effectiveTotalBytes ?? inferredEffectiveTotal;
}

/**
 * First/last seen and warning counts describe retained telemetry, not wall-clock
 * polling. Backend process IDs are not in this contract: scope by producer
 * instance, node, backend and device_id (when present), falling back to session
 * when instance is unknown.
 */
export function deriveGpuMemory(events: Iterable<ObservatoryEvent>): GpuMetrics {
    const backends = new Map<string, BackendWork>();
    const nodeEvents: ObservatoryEvent[] = [];
    for (const event of events) {
        if (isNodeGpuDeviceEvent(event)) {
            nodeEvents.push(event);
        }
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
        const deviceId = backendDeviceId(event);
        const sessionFallback = instanceId === null ? event.session_id : null;
        const nodeScopeKey = JSON.stringify([event.producer.name, event.producer.node_id, instanceId, sessionFallback]);
        const key = JSON.stringify([event.producer.name, event.producer.node_id, instanceId, sessionFallback, backend, deviceId]);
        let work = backends.get(key);
        if (!work) {
            work = {
                nodeScopeKey,
                metrics: {
                    key,
                    backend,
                    producer: event.producer.name,
                    nodeId: event.producer.node_id,
                    instanceId,
                    synthetic: event.producer.synthetic === true,
                    samples: [],
                    latest: null,
                    fittedCtx: null,
                    contextChanges: [],
                    warnings: [],
                    deviceId,
                    deviceName: null,
                    gpuClass: "unknown",
                    memoryMode: "unknown",
                    isIntegratedUma: null,
                    umaMode: null,
                    dedicatedTotalBytes: null,
                    sharedTotalBytes: null,
                    effectiveTotalBytes: null,
                },
                sampleFlags: [],
                warnings: new Map(),
                warningCounts: new Map(),
                sampleCount: null,
                epoch: 0,
                activeDevices: [],
            };
            backends.set(key, work);
        }
        const b = work.metrics;
        b.synthetic ||= event.producer.synthetic === true;
        const sampleName = trimmedText(a.device_name) ?? trimmedText(a.gpu_name) ?? trimmedText(a.name);
        if (sampleName !== null) {
            b.deviceName = sampleName;
        }
        const activeDevs = stringList(a.active_devices);
        const eventDevs = stringList(a.devices);
        if (activeDevs.length > 0) {
            work.activeDevices = activeDevs;
        } else if (eventDevs.length > 0) {
            work.activeDevices = eventDevs;
        }
        const sample = gpuMemorySample(event);
        if (sample) {
            const semantics = parseSampleMemorySemantics(a);
            if (sample.sampleCount !== null) {
                if (work.sampleCount !== null && sample.sampleCount < work.sampleCount) {
                    work.epoch += 1;
                }
                work.sampleCount = sample.sampleCount;
            }
            sample.epoch = work.epoch;
            b.samples.push(sample);
            const sampleStatus = text(a.status);
            const sampleUsable = (sampleStatus === null || sampleStatus === "ok") && sample.sampleCount !== 0;
            work.sampleFlags.push({
                usable: sampleUsable,
                explicitDiscrete: semantics.explicitDiscrete,
                explicitDiscreteSpilled: semantics.explicitDiscreteSpilled,
            });
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
    if (backends.size > 0) {
        const nodeMap = new Map<string, NodeGpuMetrics>();
        if (nodeEvents.length > 0) {
            for (const node of deriveNodeGpuMemory(nodeEvents).nodes) {
                nodeMap.set(node.key, node);
            }
        }
        for (const work of backends.values()) {
            enrichBackendFromNode(work, nodeMap.get(work.nodeScopeKey));
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
        } else if (effectiveTotalBytes !== null && effectiveFreeBytes !== null && effectiveTotalBytes >= effectiveFreeBytes) {
            effectiveUsedBytes = effectiveTotalBytes - effectiveFreeBytes;
        } else if (genericUsedBytes !== null && (effectiveTotalBytes === null || genericUsedBytes <= effectiveTotalBytes)) {
            effectiveUsedBytes = genericUsedBytes;
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
