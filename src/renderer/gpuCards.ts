import type {
    CombinedGpuPool,
    GpuBackendMetrics,
    GpuDeviceClass,
    GpuMemoryMode,
    GpuMemorySample,
    GpuMetrics,
    GpuWarning,
    GpuWeightsEvidence,
    MultiGpuMetrics,
    NodeGpuDeviceMetrics,
    NodeGpuMetrics,
} from "../query/gpuMemory";
import { h, svg } from "./dom";
import { fmtBytes, fmtPct } from "./format";
import "./gpuCards.css";

export interface GpuChartPoint {
    monoNs: number;
    dedicatedBytes: number | null;
    sharedBytes: number | null;
    spillLimitBytes: number | null;
    spilled: boolean | null;
    epoch: number;
}

export interface GpuCardModel {
    key: string;
    title: string;
    identity: string;
    synthetic: boolean;
    hasTelemetry: boolean;
    latestDedicatedBytes: number | null;
    latestSharedBytes: number | null;
    latestSpillLimitBytes: number | null;
    latestWallTime: string | null;
    spilled: boolean | null;
    fittedCtx: number | null;
    totalSamples: number;
    points: GpuChartPoint[];
    warnings: GpuWarning[];
    contextChangeCount: number;
    contextChanges: { fittedCtx: number | null; fitOutcome: string | null }[];
    deviceId?: string | null;
    deviceName?: string | null;
    gpuClass?: GpuDeviceClass;
    memoryMode?: GpuMemoryMode;
    modeLabel?: string | null;
    umaIntentionalShared?: boolean;
    dedicatedTotalBytes?: number | null;
    sharedTotalBytes?: number | null;
    effectiveTotalBytes?: number | null;
}

export function gpuMemoryModeLabel(mode: GpuMemoryMode): string | null {
    switch (mode) {
        case "discrete-gddr":
            return "Discrete GDDR";
        case "integrated-uma":
            return "Integrated UMA";
        case "hybrid-uma":
            return "Hybrid Discrete + UMA";
        default:
            return null;
    }
}

export const GPU_WARNING_EXPLANATIONS: Record<string, string> = {
    vram_spill: "GPU memory overflow is using shared system RAM; decode may be much slower.",
    kv_type_mismatch: "K/V cache types are mismatched; a conversion or slower kernel may be required.",
    kv_type_no_vector_kernel: "The selected K/V cache type has no vectorized kernel; use a supported matched type.",
    kv_type_kernel_unknown: "No optimized K/V cache kernel is known for the selected types.",
    kv_kernel_f16_fallback: "K/V cache types have no fast FlashAttention kernel; use matched q4_0/q4_0 or q8_0/q8_0.",
    mtp_tensors_ignored: "MTP tensors were ignored by the backend; speculative decoding may be unavailable.",
    partial_gpu_offload: "Only part of the model is resident on the GPU; remaining layers run elsewhere.",
    cpu_buffer_fallback: "The backend fell back to CPU buffers for one or more allocations.",
    no_gpu_device: "No GPU device was reported by the backend.",
    gpu_init_failed: "GPU initialization failed; the backend may be running on the CPU.",
};

export function gpuWarningExplanation(warning: Pick<GpuWarning, "code" | "message">): string {
    return Object.prototype.hasOwnProperty.call(GPU_WARNING_EXPLANATIONS, warning.code)
        ? GPU_WARNING_EXPLANATIONS[warning.code]!
        : warning.message ?? "Backend reported a GPU warning.";
}

function identity(backend: GpuBackendMetrics, deviceId: string | null): string {
    return [backend.backend, deviceId, backend.producer, backend.nodeId, backend.instanceId].filter(Boolean).join(" · ");
}

function chartPoint(sample: GpuMemorySample): GpuChartPoint {
    return {
        monoNs: sample.monoNs,
        dedicatedBytes: sample.dedicatedBytes,
        sharedBytes: sample.sharedBytes,
        spillLimitBytes: sample.spillLimitBytes,
        spilled: sample.spilled,
        epoch: sample.epoch,
    };
}

/** Pure renderer model. The retained sample list is already bounded by the query layer. */
export function gpuCardModels(metrics: GpuMetrics): GpuCardModel[] {
    return metrics.backends
        .filter((backend) => backend.samples.length > 0 || backend.warnings.length > 0 || backend.contextChanges.length > 0)
        .map((backend) => {
            const latest = backend.latest ?? backend.samples.at(-1) ?? null;
            const hasTelemetry = (latest?.dedicatedBytes ?? null) !== null || (latest?.sharedBytes ?? null) !== null;
            const deviceId = backend.deviceId ?? latest?.deviceId ?? null;
            const deviceName = backend.deviceName ?? null;
            const memoryMode: GpuMemoryMode = latest?.memoryMode ?? backend.memoryMode ?? "unknown";
            const gpuClass: GpuDeviceClass = latest?.gpuClass ?? backend.gpuClass ?? "unknown";
            const umaIntentionalShared = latest?.umaIntentionalShared ?? (memoryMode === "integrated-uma" || memoryMode === "hybrid-uma");
            const title = deviceName ?? (deviceId ? `GPU ${deviceId}` : "GPU");
            return {
                key: backend.key,
                title,
                identity: identity(backend, deviceId),
                synthetic: backend.synthetic,
                hasTelemetry,
                latestDedicatedBytes: latest?.dedicatedBytes ?? null,
                latestSharedBytes: latest?.sharedBytes ?? null,
                latestSpillLimitBytes: latest?.spillLimitBytes ?? null,
                latestWallTime: latest?.wallTime ?? null,
                spilled: latest?.spilled ?? null,
                fittedCtx: backend.fittedCtx,
                totalSamples: backend.samples.length,
                points: backend.samples.slice(-240).map(chartPoint),
                warnings: backend.warnings,
                contextChangeCount: Math.max(0, backend.contextChanges.length - 1),
                contextChanges: backend.contextChanges.slice(-8).map((change) => ({ fittedCtx: change.fittedCtx, fitOutcome: change.fitOutcome })),
                deviceId,
                deviceName,
                gpuClass,
                memoryMode,
                modeLabel: gpuMemoryModeLabel(memoryMode),
                umaIntentionalShared,
                dedicatedTotalBytes: latest?.dedicatedTotalBytes ?? backend.dedicatedTotalBytes ?? null,
                sharedTotalBytes: latest?.sharedTotalBytes ?? backend.sharedTotalBytes ?? null,
                effectiveTotalBytes: latest?.effectiveTotalBytes ?? backend.effectiveTotalBytes ?? null,
            };
        });
}

const CHART_WIDTH = 520;
const CHART_HEIGHT = 160;
const PAD_X = 45;
const PAD_Y = 20;

function valueMax(points: readonly GpuChartPoint[], includeThreshold = true): number {
    return Math.max(
        1,
        ...points.flatMap((point) =>
            [point.dedicatedBytes, point.sharedBytes, includeThreshold ? point.spillLimitBytes : null].filter((v): v is number => v !== null),
        ),
    );
}

function pathFor(points: readonly GpuChartPoint[], field: "dedicatedBytes" | "sharedBytes" | "spillLimitBytes", max: number): string {
    if (points.length === 0) return "";
    const first = points[0]!.monoNs;
    const last = points.at(-1)!.monoNs;
    const span = Math.max(1, last - first);
    const x = (point: GpuChartPoint) => PAD_X + ((point.monoNs - first) / span) * (CHART_WIDTH - PAD_X * 2);
    const y = (value: number) => CHART_HEIGHT - PAD_Y - (value / max) * (CHART_HEIGHT - PAD_Y * 2);
    const parts: string[] = [];
    let previousEpoch: number | null = null;
    let open = false;
    points.forEach((point) => {
        const value = point[field];
        if (value === null || (previousEpoch !== null && point.epoch !== previousEpoch)) {
            open = false;
        }
        if (value !== null) {
            parts.push(`${open ? "L" : "M"}${x(point).toFixed(2)},${y(value).toFixed(2)}`);
            open = true;
        }
        previousEpoch = point.epoch;
    });
    return parts.join(" ");
}

function svgText(text: string, attrs: Record<string, string | number>): SVGElement {
    const el = svg("text", attrs);
    el.textContent = text;
    return el;
}

/** The actual SVG paths, separated from DOM creation for renderer tests. */
export function gpuChartPaths(
    points: readonly GpuChartPoint[],
    options: { includeThreshold?: boolean } = {},
): { dedicated: string; shared: string; threshold: string; maxBytes: number } {
    const includeThreshold = options.includeThreshold ?? true;
    const maxBytes = valueMax(points, includeThreshold);
    return {
        dedicated: pathFor(points, "dedicatedBytes", maxBytes),
        shared: pathFor(points, "sharedBytes", maxBytes),
        threshold: includeThreshold ? pathFor(points, "spillLimitBytes", maxBytes) : "",
        maxBytes,
    };
}

function showSpillThresholdFor(model: GpuCardModel): boolean {
    const mode = model.memoryMode ?? "unknown";
    return model.spilled === true || (mode !== "integrated-uma" && mode !== "hybrid-uma");
}

function chart(model: GpuCardModel): SVGElement | null {
    if (model.points.length === 0 || !model.points.some((p) => p.dedicatedBytes !== null || p.sharedBytes !== null)) return null;
    const mode = model.memoryMode ?? "unknown";
    const showThreshold = showSpillThresholdFor(model);
    const isUmaLike = mode === "integrated-uma" || mode === "hybrid-uma";
    const paths = gpuChartPaths(model.points, { includeThreshold: showThreshold });
    const max = paths.maxBytes;
    const first = model.points[0]!.monoNs;
    const last = model.points.at(-1)!.monoNs;
    const span = Math.max(1, last - first);
    const pointX = (point: GpuChartPoint) => PAD_X + ((point.monoNs - first) / span) * (CHART_WIDTH - PAD_X * 2);
    const pointY = (value: number) => CHART_HEIGHT - PAD_Y - (value / max) * (CHART_HEIGHT - PAD_Y * 2);
    const sharedSeriesClass = isUmaLike && model.spilled !== true ? "gpu-chart-uma-shared" : "gpu-chart-shared";
    const sharedDotClass = isUmaLike && model.spilled !== true ? "gpu-chart-dot-uma-shared" : "gpu-chart-dot-shared";
    const ariaLabel =
        mode === "integrated-uma"
            ? `Integrated UMA GPU carveout and shared GTT memory, 0 to ${fmtBytes(max)}, over ${((last - first) / 1e9).toFixed(3)} seconds`
            : mode === "hybrid-uma" && !showThreshold
              ? `Hybrid discrete GDDR and iGPU UMA shared memory, 0 to ${fmtBytes(max)}, over ${((last - first) / 1e9).toFixed(3)} seconds`
              : `GPU dedicated and shared memory, 0 to ${fmtBytes(max)}, over ${((last - first) / 1e9).toFixed(3)} seconds; dashed line is the shared spill limit`;
    const el = svg("svg", {
        class: "gpu-chart",
        viewBox: `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`,
        role: "img",
        "aria-label": ariaLabel,
    });
    el.append(
        svg("path", { class: "gpu-chart-dedicated", d: paths.dedicated, "aria-hidden": "true" }),
        svg("path", { class: sharedSeriesClass, d: paths.shared, "aria-hidden": "true" }),
        ...(showThreshold ? [svg("path", { class: "gpu-chart-threshold", d: paths.threshold, "aria-hidden": "true" })] : []),
        svgText(fmtBytes(max), { class: "gpu-chart-axis-label", x: 2, y: PAD_Y - 5 }),
        svgText("0 B", { class: "gpu-chart-axis-label", x: 2, y: CHART_HEIGHT - PAD_Y + 4 }),
        svgText("0 s", { class: "gpu-chart-axis-label", x: PAD_X, y: CHART_HEIGHT - 2 }),
        svgText(`${((last - first) / 1e9).toFixed(3)} s`, { class: "gpu-chart-axis-label", x: CHART_WIDTH - PAD_X, y: CHART_HEIGHT - 2, "text-anchor": "end" }),
        ...model.points.flatMap((point) => [
            point.dedicatedBytes === null ? null : svg("circle", { class: "gpu-chart-dot-dedicated", cx: pointX(point), cy: pointY(point.dedicatedBytes), r: 2.5 }),
            point.sharedBytes === null ? null : svg("circle", { class: sharedDotClass, cx: pointX(point), cy: pointY(point.sharedBytes), r: 2.5 }),
            !showThreshold || point.spillLimitBytes === null ? null : svg("circle", { class: "gpu-chart-dot-threshold", cx: pointX(point), cy: pointY(point.spillLimitBytes), r: 2 }),
        ].filter((item): item is SVGElement => item !== null)),
    );
    return el;
}

function seen(wallTime: string): string {
    return wallTime || "unknown";
}

function warningTable(warnings: readonly GpuWarning[]): HTMLElement {
    const table = h("table", { class: "gpu-warnings" });
    table.append(
        h("caption", { class: "sr-only", text: "GPU backend warnings" }),
        h("thead", {}, h("tr", {}, ...["Code", "Explanation", "First seen", "Last seen", "Count"].map((text) => h("th", { scope: "col", text })))),
        h("tbody", {}, ...warnings.map((warning) => h("tr", {},
            h("td", { class: "gpu-warning-code", text: warning.code }),
            h("td", { text: gpuWarningExplanation(warning) }),
            h("td", { text: seen(warning.firstSeenWallTime) }),
            h("td", { text: seen(warning.lastSeenWallTime) }),
            h("td", { text: String(warning.count) }),
        ))),
    );
    return h("div", { class: "gpu-warning-scroll", role: "region", "aria-label": "Backend warnings in retained telemetry", tabindex: "0" }, table);
}

/** Calm informational pool note for integrated UMA / hybrid UMA cards (never an error banner). */
export function gpuPoolDetail(model: GpuCardModel): string | null {
    if (!model.hasTelemetry || model.spilled === true) {
        return null;
    }
    if (model.memoryMode === "integrated-uma") {
        return "Intentional unified memory pool (GTT) — shared system RAM is primary GPU memory, not VRAM spill.";
    }
    if (model.memoryMode === "hybrid-uma") {
        return "Hybrid discrete GDDR + iGPU UMA pool — shared system RAM hosts intentional iGPU allocations.";
    }
    return null;
}

/** Text rendered on the card; absent data never reads as a zero measurement. */
export function gpuCardText(model: GpuCardModel): { status: string; memory: string; spillDetail: string | null } {
    const mode = model.memoryMode ?? "unknown";
    const isUma = mode === "integrated-uma";
    const isHybrid = mode === "hybrid-uma";
    const isDiscrete = mode === "discrete-gddr";

    let status: string;
    if (model.spilled === true) {
        status = "SPILL";
    } else if (isUma) {
        status = model.hasTelemetry ? "UMA Unified Pool" : "UMA state unavailable";
    } else if (isHybrid) {
        status = model.hasTelemetry ? "Hybrid UMA Pool" : "Hybrid pool state unavailable";
    } else if (model.spilled === false) {
        status = "No spill reported";
    } else {
        status = "Spill state unavailable";
    }

    let memory: string;
    if (!model.hasTelemetry) {
        memory = "no GPU telemetry";
    } else {
        const d = model.latestDedicatedBytes;
        const s = model.latestSharedBytes;
        const dText = d === null ? "unknown" : fmtBytes(d);
        const sText = s === null ? "unknown" : fmtBytes(s);
        if (isUma) {
            const sumUsed = d !== null && s !== null ? d + s : null;
            const effectiveUsed = sumUsed !== null ? (Number.isSafeInteger(sumUsed) ? sumUsed : null) : (s ?? d);
            const effectiveTotal = model.effectiveTotalBytes ?? null;
            if (effectiveUsed !== null && effectiveTotal !== null) {
                memory = `${fmtBytes(effectiveUsed)} / ${fmtBytes(effectiveTotal)} UMA pool · ${dText} carveout · ${sText} shared GTT`;
            } else if (effectiveUsed !== null && d !== null && s !== null) {
                memory = `${fmtBytes(effectiveUsed)} effective UMA · ${dText} carveout · ${sText} shared GTT`;
            } else {
                memory = `${dText} carveout · ${sText} shared GTT`;
            }
        } else if (isHybrid) {
            const combinedTotal = model.effectiveTotalBytes ?? null;
            memory =
                combinedTotal !== null
                    ? `${dText} dedicated GDDR · ${sText} UMA shared · ${fmtBytes(combinedTotal)} combined pool`
                    : `${dText} dedicated GDDR · ${sText} UMA shared`;
        } else if (isDiscrete) {
            const dedicatedTotal = model.dedicatedTotalBytes ?? null;
            memory =
                d !== null && dedicatedTotal !== null
                    ? `${dText} / ${fmtBytes(dedicatedTotal)} dedicated GDDR · ${sText} shared`
                    : `${dText} dedicated GDDR · ${sText} shared`;
        } else {
            memory = `${dText} dedicated · ${sText} shared`;
        }
    }

    const spillDetail = model.spilled === true ? "overflow in shared system RAM; decode 2-15x slower" : null;
    return { status, memory, spillDetail };
}

function card(model: GpuCardModel): HTMLElement {
    const mode = model.memoryMode ?? "unknown";
    const { status, memory, spillDetail } = gpuCardText(model);
    const poolDetail = gpuPoolDetail(model);
    const showThreshold = showSpillThresholdFor(model);
    const isUmaLike = mode === "integrated-uma" || mode === "hybrid-uma";
    const statusClass =
        model.spilled === true
            ? "gpu-status-spill"
            : mode === "integrated-uma"
              ? "gpu-status-uma"
              : mode === "hybrid-uma"
                ? "gpu-status-hybrid"
                : "gpu-status-ok";
    const plot = chart(model);
    const dedicatedLegend = mode === "integrated-uma" ? "BIOS carveout" : mode === "discrete-gddr" || mode === "hybrid-uma" ? "Dedicated GDDR" : "Dedicated";
    const sharedLegend =
        mode === "integrated-uma"
            ? "Shared GTT (UMA)"
            : mode === "hybrid-uma"
              ? "UMA shared (GTT)"
              : mode === "discrete-gddr"
                ? "Shared (spill)"
                : "Shared";
    const sharedLegendClass = isUmaLike && model.spilled !== true ? "gpu-legend-uma-shared" : "gpu-legend-shared";
    const cardAttrs: Record<string, string> = {
        class: `gpu-card gpu-card-${mode} card`,
        "data-gpu-key": model.key,
        "data-gpu-mode": mode,
        "data-gpu-spilled": model.spilled === true ? "true" : "false",
    };
    if (model.deviceId) {
        cardAttrs["data-gpu-device"] = model.deviceId;
    }
    return h(
        "article",
        cardAttrs,
        h(
            "header",
            { class: "gpu-card-header" },
            h(
                "div",
                {},
                h(
                    "div",
                    { class: "gpu-node-title-row" },
                    h("h3", { text: model.title }),
                    model.deviceId ? h("span", { class: "gpu-device-pill mono", text: model.deviceId }) : null,
                    model.modeLabel ? h("span", { class: `gpu-mode-badge gpu-mode-${mode}`, text: model.modeLabel }) : null,
                ),
                h("p", { class: "gpu-identity", text: model.identity || "backend identity unavailable" }),
            ),
            model.synthetic ? h("span", { class: "tag tag-synthetic", text: "synthetic" }) : null,
        ),
        h("div", { class: "gpu-summary" },
            h("div", { class: "gpu-memory-value", text: memory }),
            h("div", { class: `gpu-status ${statusClass}`, text: status, role: "status" }),
            spillDetail ? h("div", { class: "gpu-spill-detail", text: spillDetail }) : null,
            poolDetail ? h("div", { class: "gpu-pool-note", text: poolDetail }) : null,
            h("div", { class: "gpu-context", text: `Fitted context: ${model.fittedCtx === null ? "not reported" : model.fittedCtx.toLocaleString()}` }),
            showThreshold && model.latestSpillLimitBytes !== null
                ? h("div", { class: "gpu-context", text: `Spill limit: ${fmtBytes(model.latestSpillLimitBytes)} (reported baseline + threshold)` })
                : null,
        ),
        plot,
        model.points.length > 0 ? h("div", { class: "gpu-chart-meta", text: `last ${model.points.length} of ${model.totalSamples} retained samples · backend-reported${model.latestWallTime ? ` · last sample ${model.latestWallTime}` : ""}` }) : null,
        plot ? h("div", { class: "gpu-chart-legend", "aria-label": "Chart legend" },
            h("span", { class: "gpu-legend-dedicated", text: dedicatedLegend }),
            h("span", { class: sharedLegendClass, text: sharedLegend }),
            showThreshold ? h("span", { class: "gpu-legend-threshold", text: "Spill limit" }) : null,
        ) : null,
        model.contextChangeCount > 0 ? h("div", { class: "gpu-context-changes", text: `${model.contextChangeCount} fitted context change${model.contextChangeCount === 1 ? "" : "s"}` }) : null,
        model.warnings.length > 0 ? h("p", { class: "evidence", text: "Warnings: reported occurrences and first/last observations in retained telemetry; absence of repeats does not mean resolved." }) : null,
        model.warnings.length > 0 ? warningTable(model.warnings) : null,
    );
}

export function renderGpuCards(metrics: GpuMetrics): HTMLElement[] {
    return gpuCardModels(metrics).map(card);
}

// ---------------------------------------------------------------------------
// Per-node multi-GPU VRAM cards (discrete vs integrated UMA + combined pool)
// ---------------------------------------------------------------------------

export interface NodeGpuDeviceCardRow {
    key: string;
    deviceId: string;
    name: string;
    vendor: string | null;
    gpuClass: GpuDeviceClass;
    classLabel: string;
    backendHint: string | null;
    source: string | null;
    effectiveTotalBytes: number | null;
    effectiveUsedBytes: number | null;
    effectiveFreeBytes: number | null;
    usedFraction: number | null;
    dedicatedTotalBytes: number | null;
    sharedTotalBytes: number | null;
    modelWeightsBytes: number | null;
    carryingModelWeights: boolean;
    weightsEvidence: GpuWeightsEvidence;
    usageText: string;
    detailText: string | null;
}

export interface NodeCombinedPoolModel {
    badge: string;
    tone: "active" | "hybrid" | "pool";
    isHybridDiscreteUma: boolean;
    bothCarryingWeights: boolean;
    multiGpuActive: boolean;
    weightsEvidence: GpuWeightsEvidence;
    summaryText: string;
    splitText: string | null;
    discretePercent: number;
    umaPercent: number;
    totalUsedPercent: number | null;
    activeDevices: string[];
}

export interface NodeGpuCardModel {
    key: string;
    nodeId: string;
    identity: string;
    gpuMixLabel: string;
    synthetic: boolean;
    latestWallTime: string | null;
    devices: NodeGpuDeviceCardRow[];
    combinedPool: NodeCombinedPoolModel | null;
}

export function gpuClassLabel(gpuClass: GpuDeviceClass): string {
    switch (gpuClass) {
        case "discrete":
            return "Discrete";
        case "integrated-uma":
            return "Integrated UMA";
        default:
            return "GPU";
    }
}

export function nodeGpuDeviceSummary(device: NodeGpuDeviceMetrics): { usageText: string; detailText: string | null } {
    const latest = device.latest;
    if (!latest || (latest.effectiveTotalBytes === null && latest.effectiveUsedBytes === null && latest.effectiveFreeBytes === null)) {
        return { usageText: "VRAM reading unavailable", detailText: null };
    }
    const isUma = device.gpuClass === "integrated-uma";
    const poolWord = isUma ? "UMA pool" : "VRAM";
    let usageText: string;
    if (latest.effectiveUsedBytes !== null && latest.effectiveTotalBytes !== null) {
        const pct = latest.usedFraction !== null ? ` (${fmtPct(latest.usedFraction)})` : "";
        usageText = `${fmtBytes(latest.effectiveUsedBytes)} / ${fmtBytes(latest.effectiveTotalBytes)} ${poolWord}${pct}`;
    } else if (latest.effectiveTotalBytes !== null) {
        usageText = `${fmtBytes(latest.effectiveTotalBytes)} ${poolWord} total · usage unknown`;
    } else if (latest.effectiveFreeBytes !== null) {
        usageText = `${fmtBytes(latest.effectiveFreeBytes)} ${poolWord} free`;
    } else {
        usageText = `${fmtBytes(latest.effectiveUsedBytes!)} ${poolWord} used`;
    }

    const details: string[] = [];
    if (latest.effectiveFreeBytes !== null && latest.effectiveUsedBytes !== null) {
        details.push(`${fmtBytes(latest.effectiveFreeBytes)} free`);
    }
    if (isUma) {
        if (latest.dedicatedTotalBytes !== null && latest.sharedTotalBytes !== null) {
            details.push(`${fmtBytes(latest.dedicatedTotalBytes)} carveout + ${fmtBytes(latest.sharedTotalBytes)} shared GTT`);
        } else if (latest.sharedTotalBytes !== null) {
            details.push(`${fmtBytes(latest.sharedTotalBytes)} shared GTT`);
        }
    } else if (latest.sharedTotalBytes !== null) {
        details.push(`${fmtBytes(latest.sharedTotalBytes)} shared`);
    }
    if (latest.modelWeightsBytes !== null && latest.modelWeightsBytes > 0) {
        details.push(`weights ${fmtBytes(latest.modelWeightsBytes)}`);
    }
    return { usageText, detailText: details.length > 0 ? details.join(" · ") : null };
}

export function combinedPoolModel(pool: CombinedGpuPool): NodeCombinedPoolModel {
    const badge = pool.bothCarryingWeights
        ? "Combined VRAM Pool Active"
        : pool.multiGpuActive
          ? "Multi-GPU Pool Active"
          : pool.isHybridDiscreteUma
            ? "Hybrid Discrete + UMA Pool"
            : "Multi-GPU VRAM Pool";
    const tone: NodeCombinedPoolModel["tone"] = pool.bothCarryingWeights || pool.multiGpuActive ? "active" : pool.isHybridDiscreteUma ? "hybrid" : "pool";

    let summaryText: string;
    if (pool.combinedUsedBytes !== null && pool.combinedTotalBytes !== null) {
        const pct = pool.combinedUsedFraction !== null ? ` (${fmtPct(pool.combinedUsedFraction)})` : "";
        summaryText = `${fmtBytes(pool.combinedUsedBytes)} / ${fmtBytes(pool.combinedTotalBytes)} combined${pct}`;
    } else if (pool.combinedTotalBytes !== null) {
        summaryText = `${fmtBytes(pool.combinedTotalBytes)} combined capacity · usage partial`;
    } else {
        summaryText = "Combined VRAM total unavailable (partial device readings)";
    }

    const splitParts: string[] = [];
    if (pool.discreteCount > 0) {
        const dText =
            pool.discreteUsedBytes !== null && pool.discreteTotalBytes !== null
                ? `${fmtBytes(pool.discreteUsedBytes)} / ${fmtBytes(pool.discreteTotalBytes)}`
                : pool.discreteTotalBytes !== null
                  ? fmtBytes(pool.discreteTotalBytes)
                  : "unknown";
        splitParts.push(`Discrete ${dText}`);
    }
    if (pool.integratedUmaCount > 0) {
        const uText =
            pool.umaUsedBytes !== null && pool.umaTotalBytes !== null
                ? `${fmtBytes(pool.umaUsedBytes)} / ${fmtBytes(pool.umaTotalBytes)}`
                : pool.umaTotalBytes !== null
                  ? fmtBytes(pool.umaTotalBytes)
                  : "unknown";
        splitParts.push(`UMA ${uText}`);
    }
    if (pool.bothCarryingWeights) {
        splitParts.push(pool.weightsEvidence === "reported" ? "both GPUs carrying weights (reported)" : "both GPUs carrying weights (observed VRAM)");
    }

    const total = pool.combinedTotalBytes ?? 0;
    const discretePercent = total > 0 && pool.discreteUsedBytes !== null ? Math.min(100, Math.max(0, (pool.discreteUsedBytes / total) * 100)) : 0;
    const umaPercent = total > 0 && pool.umaUsedBytes !== null ? Math.min(100 - discretePercent, Math.max(0, (pool.umaUsedBytes / total) * 100)) : 0;
    const totalUsedPercent = pool.combinedUsedFraction !== null ? Math.round(pool.combinedUsedFraction * 100) : null;

    return {
        badge,
        tone,
        isHybridDiscreteUma: pool.isHybridDiscreteUma,
        bothCarryingWeights: pool.bothCarryingWeights,
        multiGpuActive: pool.multiGpuActive,
        weightsEvidence: pool.weightsEvidence,
        summaryText,
        splitText: splitParts.length > 0 ? splitParts.join(" · ") : null,
        discretePercent,
        umaPercent,
        totalUsedPercent,
        activeDevices: pool.activeDevices,
    };
}

function gpuMixLabel(node: NodeGpuMetrics): string {
    const discrete = node.devices.filter((d) => d.gpuClass === "discrete").length;
    const uma = node.devices.filter((d) => d.gpuClass === "integrated-uma").length;
    const total = node.devices.length;
    const prefix = `${total} GPU${total === 1 ? "" : "s"}`;
    if (discrete > 0 && uma > 0) {
        return `${prefix} · Discrete + UMA`;
    }
    if (discrete > 0) {
        return `${prefix} · Discrete`;
    }
    if (uma > 0) {
        return `${prefix} · Integrated UMA`;
    }
    return prefix;
}

/** Pure renderer model for per-node multi-GPU VRAM cards. */
export function nodeGpuCardModels(metrics: MultiGpuMetrics): NodeGpuCardModel[] {
    return metrics.nodes
        .filter((node) => node.devices.length > 0)
        .map((node) => ({
            key: node.key,
            nodeId: node.nodeId,
            identity: [node.producer, node.instanceId].filter(Boolean).join(" · "),
            gpuMixLabel: gpuMixLabel(node),
            synthetic: node.synthetic,
            latestWallTime: node.latestWallTime,
            devices: node.devices.map((device) => {
                const { usageText, detailText } = nodeGpuDeviceSummary(device);
                return {
                    key: device.key,
                    deviceId: device.deviceId,
                    name: device.name,
                    vendor: device.vendor,
                    gpuClass: device.gpuClass,
                    classLabel: gpuClassLabel(device.gpuClass),
                    backendHint: device.backendHint,
                    source: device.source,
                    effectiveTotalBytes: device.latest?.effectiveTotalBytes ?? null,
                    effectiveUsedBytes: device.latest?.effectiveUsedBytes ?? null,
                    effectiveFreeBytes: device.latest?.effectiveFreeBytes ?? null,
                    usedFraction: device.latest?.usedFraction ?? null,
                    dedicatedTotalBytes: device.latest?.dedicatedTotalBytes ?? null,
                    sharedTotalBytes: device.latest?.sharedTotalBytes ?? null,
                    modelWeightsBytes: device.latest?.modelWeightsBytes ?? null,
                    carryingModelWeights: device.carryingModelWeights,
                    weightsEvidence: device.weightsEvidence,
                    usageText,
                    detailText,
                };
            }),
            combinedPool: node.combinedPool ? combinedPoolModel(node.combinedPool) : null,
        }));
}

function renderCombinedPoolBanner(pool: NodeCombinedPoolModel): HTMLElement {
    const bar =
        pool.totalUsedPercent !== null
            ? h(
                  "div",
                  {
                      class: "gpu-pool-bar",
                      role: "progressbar",
                      "aria-label": `Combined VRAM utilization: ${pool.totalUsedPercent}%`,
                      "aria-valuemin": 0,
                      "aria-valuemax": 100,
                      "aria-valuenow": pool.totalUsedPercent,
                  },
                  pool.discretePercent > 0
                      ? h("span", { class: "gpu-pool-seg gpu-pool-seg-discrete", style: `width:${pool.discretePercent.toFixed(1)}%` })
                      : null,
                  pool.umaPercent > 0
                      ? h("span", { class: "gpu-pool-seg gpu-pool-seg-uma", style: `width:${pool.umaPercent.toFixed(1)}%` })
                      : null,
              )
            : null;

    return h(
        "div",
        {
            class: `gpu-pool-banner gpu-pool-${pool.tone}`,
            "data-testid": "combined-vram-pool",
            "data-both-carrying": pool.bothCarryingWeights ? "true" : "false",
        },
        h(
            "div",
            { class: "gpu-pool-head" },
            h("span", { class: `gpu-pool-badge gpu-pool-badge-${pool.tone}`, text: pool.badge }),
            ...pool.activeDevices.map((dev) => h("span", { class: "gpu-device-pill mono", text: dev })),
        ),
        h("div", { class: "gpu-pool-summary", text: pool.summaryText }),
        bar,
        pool.splitText ? h("div", { class: "gpu-pool-split", text: pool.splitText }) : null,
    );
}

function renderNodeGpuDeviceRow(device: NodeGpuDeviceCardRow): HTMLElement {
    const pct = device.usedFraction !== null ? Math.round(device.usedFraction * 100) : null;
    const bar =
        pct !== null
            ? h(
                  "div",
                  {
                      class: "gpu-vram-bar",
                      role: "progressbar",
                      "aria-label": `${device.name} ${device.classLabel} memory: ${pct}%`,
                      "aria-valuemin": 0,
                      "aria-valuemax": 100,
                      "aria-valuenow": pct,
                  },
                  h("span", {
                      class: `gpu-vram-fill gpu-vram-fill-${device.gpuClass}`,
                      style: `width:${Math.min(100, Math.max(0, pct))}%`,
                  }),
              )
            : null;

    return h(
        "li",
        { class: "gpu-device-row", "data-gpu-device": device.deviceId, "data-gpu-class": device.gpuClass },
        h(
            "div",
            { class: "gpu-device-head" },
            h("span", { class: "gpu-device-name", text: device.name }),
            h("span", { class: "gpu-device-id mono", text: device.deviceId }),
            h("span", { class: `gpu-class-badge gpu-class-${device.gpuClass}`, text: device.classLabel }),
            device.backendHint ? h("span", { class: "gpu-device-pill mono", text: device.backendHint }) : null,
            device.carryingModelWeights
                ? h("span", {
                      class: "gpu-weights-badge",
                      title: device.weightsEvidence === "reported" ? "Producer reported active model weights" : "Observed active VRAM allocation",
                      text: "Model weights",
                  })
                : null,
        ),
        h("div", { class: "gpu-device-usage", text: device.usageText }),
        bar,
        device.detailText ? h("div", { class: "gpu-device-detail", text: device.detailText }) : null,
    );
}

function renderNodeGpuCard(model: NodeGpuCardModel): HTMLElement {
    return h(
        "article",
        { class: "gpu-card gpu-node-card card", "data-gpu-node": model.nodeId, "data-testid": "gpu-node-card" },
        h(
            "header",
            { class: "gpu-card-header" },
            h(
                "div",
                {},
                h(
                    "div",
                    { class: "gpu-node-title-row" },
                    h("h3", { text: "GPU VRAM" }),
                    h("span", { class: "producer-node mono", text: model.nodeId }),
                    h("span", { class: "gpu-mix-pill", text: model.gpuMixLabel }),
                ),
                h("p", { class: "gpu-identity", text: model.identity || "producer identity unavailable" }),
            ),
            model.synthetic ? h("span", { class: "tag tag-synthetic", text: "synthetic" }) : null,
        ),
        model.combinedPool ? renderCombinedPoolBanner(model.combinedPool) : null,
        h("ul", { class: "gpu-device-list", "aria-label": `GPUs on ${model.nodeId}` }, ...model.devices.map(renderNodeGpuDeviceRow)),
        h("div", {
            class: "gpu-chart-meta",
            text: `producer-reported · device.memory.sample (kind=gpu)${model.latestWallTime ? ` · last sample ${model.latestWallTime}` : ""}`,
        }),
    );
}

export function renderNodeGpuCards(metrics: MultiGpuMetrics): HTMLElement[] {
    return nodeGpuCardModels(metrics).map(renderNodeGpuCard);
}
