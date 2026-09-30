import type { GpuBackendMetrics, GpuMetrics, GpuMemorySample, GpuWarning } from "../query/gpuMemory";
import { h, svg } from "./dom";
import { fmtBytes } from "./format";
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

function identity(backend: GpuBackendMetrics): string {
    return [backend.backend, backend.producer, backend.nodeId, backend.instanceId].filter(Boolean).join(" · ");
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
            return {
                key: backend.key,
                title: "GPU",
                identity: identity(backend),
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
            };
        });
}

const CHART_WIDTH = 520;
const CHART_HEIGHT = 160;
const PAD_X = 45;
const PAD_Y = 20;

function valueMax(points: readonly GpuChartPoint[]): number {
    return Math.max(
        1,
        ...points.flatMap((point) => [point.dedicatedBytes, point.sharedBytes, point.spillLimitBytes].filter((v): v is number => v !== null)),
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
export function gpuChartPaths(points: readonly GpuChartPoint[]): { dedicated: string; shared: string; threshold: string; maxBytes: number } {
    const maxBytes = valueMax(points);
    return {
        dedicated: pathFor(points, "dedicatedBytes", maxBytes),
        shared: pathFor(points, "sharedBytes", maxBytes),
        threshold: pathFor(points, "spillLimitBytes", maxBytes),
        maxBytes,
    };
}

function chart(model: GpuCardModel): SVGElement | null {
    if (model.points.length === 0 || !model.points.some((p) => p.dedicatedBytes !== null || p.sharedBytes !== null)) return null;
    const paths = gpuChartPaths(model.points);
    const max = paths.maxBytes;
    const first = model.points[0]!.monoNs;
    const last = model.points.at(-1)!.monoNs;
    const span = Math.max(1, last - first);
    const pointX = (point: GpuChartPoint) => PAD_X + ((point.monoNs - first) / span) * (CHART_WIDTH - PAD_X * 2);
    const pointY = (value: number) => CHART_HEIGHT - PAD_Y - (value / max) * (CHART_HEIGHT - PAD_Y * 2);
    const el = svg("svg", {
        class: "gpu-chart",
        viewBox: `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`,
        role: "img",
        "aria-label": `GPU dedicated and shared memory, 0 to ${fmtBytes(max)}, over ${((last - first) / 1e9).toFixed(3)} seconds; dashed line is the shared spill limit`,
    });
    el.append(
        svg("path", { class: "gpu-chart-dedicated", d: paths.dedicated, "aria-hidden": "true" }),
        svg("path", { class: "gpu-chart-shared", d: paths.shared, "aria-hidden": "true" }),
        svg("path", { class: "gpu-chart-threshold", d: paths.threshold, "aria-hidden": "true" }),
        svgText(fmtBytes(max), { class: "gpu-chart-axis-label", x: 2, y: PAD_Y - 5 }),
        svgText("0 B", { class: "gpu-chart-axis-label", x: 2, y: CHART_HEIGHT - PAD_Y + 4 }),
        svgText("0 s", { class: "gpu-chart-axis-label", x: PAD_X, y: CHART_HEIGHT - 2 }),
        svgText(`${((last - first) / 1e9).toFixed(3)} s`, { class: "gpu-chart-axis-label", x: CHART_WIDTH - PAD_X, y: CHART_HEIGHT - 2, "text-anchor": "end" }),
        ...model.points.flatMap((point) => [
            point.dedicatedBytes === null ? null : svg("circle", { class: "gpu-chart-dot-dedicated", cx: pointX(point), cy: pointY(point.dedicatedBytes), r: 2.5 }),
            point.sharedBytes === null ? null : svg("circle", { class: "gpu-chart-dot-shared", cx: pointX(point), cy: pointY(point.sharedBytes), r: 2.5 }),
            point.spillLimitBytes === null ? null : svg("circle", { class: "gpu-chart-dot-threshold", cx: pointX(point), cy: pointY(point.spillLimitBytes), r: 2 }),
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

/** Text rendered on the card; absent data never reads as a zero measurement. */
export function gpuCardText(model: GpuCardModel): { status: string; memory: string; spillDetail: string | null } {
    const status = model.spilled === true ? "SPILL" : model.spilled === false ? "No spill reported" : "Spill state unavailable";
    const memory = model.hasTelemetry
        ? `${model.latestDedicatedBytes === null ? "unknown" : fmtBytes(model.latestDedicatedBytes)} dedicated · ${model.latestSharedBytes === null ? "unknown" : fmtBytes(model.latestSharedBytes)} shared`
        : "no GPU telemetry";
    const spillDetail = model.spilled === true ? "overflow in shared system RAM; decode 2-15x slower" : null;
    return { status, memory, spillDetail };
}

function card(model: GpuCardModel): HTMLElement {
    const { status, memory, spillDetail } = gpuCardText(model);
    const statusClass = model.spilled === true ? "gpu-status-spill" : "gpu-status-ok";
    const plot = chart(model);
    return h(
        "article",
        { class: "gpu-card card", "data-gpu-key": model.key },
        h("header", { class: "gpu-card-header" }, h("div", {}, h("h3", { text: model.title }), h("p", { class: "gpu-identity", text: model.identity || "backend identity unavailable" })), model.synthetic ? h("span", { class: "tag tag-synthetic", text: "synthetic" }) : null),
        h("div", { class: "gpu-summary" },
            h("div", { class: "gpu-memory-value", text: memory }),
            h("div", { class: `gpu-status ${statusClass}`, text: status, role: "status" }),
            spillDetail ? h("div", { class: "gpu-spill-detail", text: spillDetail }) : null,
            h("div", { class: "gpu-context", text: `Fitted context: ${model.fittedCtx === null ? "not reported" : model.fittedCtx.toLocaleString()}` }),
            model.latestSpillLimitBytes !== null ? h("div", { class: "gpu-context", text: `Spill limit: ${fmtBytes(model.latestSpillLimitBytes)} (reported baseline + threshold)` }) : null,
        ),
        plot,
        model.points.length > 0 ? h("div", { class: "gpu-chart-meta", text: `last ${model.points.length} of ${model.totalSamples} retained samples · backend-reported${model.latestWallTime ? ` · last sample ${model.latestWallTime}` : ""}` }) : null,
        plot ? h("div", { class: "gpu-chart-legend", "aria-label": "Chart legend" },
            h("span", { class: "gpu-legend-dedicated", text: "Dedicated" }),
            h("span", { class: "gpu-legend-shared", text: "Shared" }),
            h("span", { class: "gpu-legend-threshold", text: "Spill limit" }),
        ) : null,
        model.contextChangeCount > 0 ? h("div", { class: "gpu-context-changes", text: `${model.contextChangeCount} fitted context change${model.contextChangeCount === 1 ? "" : "s"}` }) : null,
        model.warnings.length > 0 ? h("p", { class: "evidence", text: "Warnings: reported occurrences and first/last observations in retained telemetry; absence of repeats does not mean resolved." }) : null,
        model.warnings.length > 0 ? warningTable(model.warnings) : null,
    );
}

export function renderGpuCards(metrics: GpuMetrics): HTMLElement[] {
    return gpuCardModels(metrics).map(card);
}
