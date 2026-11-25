/**
 * Overview metric cards (#cards): latency, TTFT (with steady-prefill vs reload
 * separation), token rate (with prefill vs decode separation), prompt-cache &
 * speculation reuse, embeddings accounting, execution routing + orchestration
 * lifecycle, live `/v1/sonder/node` hardware/hybrid-GPU topology & residency,
 * multi-GPU per-node VRAM & spill-guard GPU cards, errors, agents/tools,
 * resources, and telemetry.
 */
import type { HealthGpuDevice } from "../ingest/live/health";
import type { ObservatoryEvent } from "../protocol/events";
import { executionRouteAt } from "../query/executionRouteIndex";
import { gpuMemoryAt, nodeGpuMemoryAt } from "../query/gpuMemoryIndex";
import { percentile, type Metrics, type RequestStartSource } from "../query/metrics";
import { prefillDecodeAt } from "../query/prefillDecodeIndex";
import type { SessionStore } from "../replay/session";
import { byId, h } from "./dom";
import { fmtBytes, fmtMs, fmtPct } from "./format";
import { renderGpuCards, renderNodeGpuCards } from "./gpuCards";
import { liveNodesForStore, type LiveNodeSnapshot } from "./liveController";
import { renderPrefillDecodeSplit, renderTtftBreakdown } from "./prefillDecodeCard";
import { promptCacheCardModel, speculationCardModel, type ReuseCardModel } from "./reuseCards";
import { renderRouteCards } from "./routeBadges";
import { tokenCardModel } from "./tokenCard";

const MAX_OVERVIEW_GPUS = 16;
const MAX_OVERVIEW_MODELS = 12;
const MAX_OVERVIEW_CAPS = 12;

export interface EmbedCardModel {
    title: string;
    value: string;
    sub: string;
    evidence: string;
    tone: string;
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
    open: number;
    measurableCount: number;
    p50Ms: number | null;
    p95Ms: number | null;
    maxMs: number | null;
    sourceBreakdown: Partial<Record<RequestStartSource, number>>;
    models: [string, number][];
}

export interface LiveNodeGpuRowModel {
    id: string;
    name: string;
    vendor: string | null;
    gpuClass: "discrete" | "integrated-uma" | "unknown";
    classLabel: string;
    backendHint: string | null;
    source: string | null;
    usageText: string;
    detailText: string | null;
    usedPercent: number | null;
}

export interface LiveNodePoolModel {
    badge: string;
    tone: "hybrid" | "pool";
    hybridVulkanAvailable: boolean;
    summaryText: string;
    splitText: string | null;
    discretePercent: number;
    umaPercent: number;
    usedPercent: number | null;
    recommendedDevices: string[];
    llamaArgDevice: string | null;
}

export interface LiveNodeCardModel {
    connectionId: string;
    nodeId: string;
    identity: string;
    state: LiveNodeSnapshot["state"];
    synthetic: boolean;
    source: "node" | "health";
    gpuMixLabel: string;
    pool: LiveNodePoolModel | null;
    gpus: LiveNodeGpuRowModel[];
    totalGpuCount: number;
    modelCount: number;
    models: { id: string; backend: string | null }[];
    availableBackends: number;
    totalBackends: number;
    backends: { name: string; available: boolean | null; capabilities: string[] }[];
    capabilities: string[];
    evidence: string;
}

function validMib(value: number | null | undefined): number | null {
    return typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        Number.isSafeInteger(value * 1024 * 1024)
        ? value
        : null;
}

function fmtMib(mib: number): string {
    return fmtBytes(mib * 1024 * 1024);
}

/** Pure model for the Overview Embeddings card; null when no `/v1/embeddings` spans exist. */
export function embedCardModel(m: Metrics): EmbedCardModel | null {
    const embeds = m.requests.filter((r) => r.requestKind === "embed");
    if (embeds.length === 0) {
        return null;
    }
    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    let open = 0;
    const durationsMs: number[] = [];
    const sourceBreakdown: Partial<Record<RequestStartSource, number>> = {};
    const modelCounts = new Map<string, number>();

    for (const r of embeds) {
        if (r.outcome === "completed") {
            completed += 1;
        } else if (r.outcome === "failed") {
            failed += 1;
        } else if (r.outcome === "cancelled") {
            cancelled += 1;
        } else {
            open += 1;
        }
        sourceBreakdown[r.startSource] = (sourceBreakdown[r.startSource] ?? 0) + 1;
        if (r.endNs !== null && r.startSource !== "outcome-only") {
            const ms = (r.endNs - r.startNs) / 1e6;
            if (Number.isFinite(ms) && ms >= 0) {
                durationsMs.push(ms);
            }
        }
        if (r.model) {
            modelCounts.set(r.model, (modelCounts.get(r.model) ?? 0) + 1);
        }
    }

    durationsMs.sort((a, b) => a - b);
    const p50Ms = percentile(durationsMs, 50);
    const p95Ms = percentile(durationsMs, 95);
    const maxMs = durationsMs.length > 0 ? durationsMs[durationsMs.length - 1]! : null;

    const subParts: string[] = [];
    if (durationsMs.length > 0) {
        subParts.push(`p50 ${fmtMs(p50Ms)} · p95 ${fmtMs(p95Ms)}`);
    } else {
        subParts.push("latency unavailable");
    }
    if (completed > 0) {
        subParts.push(`${completed} ok`);
    }
    if (failed > 0) {
        subParts.push(`${failed} failed`);
    }
    if (cancelled > 0) {
        subParts.push(`${cancelled} cancelled`);
    }
    if (open > 0) {
        subParts.push(`${open} open`);
    }

    const total = embeds.length;
    return {
        title: "Embeddings",
        value: `${total} embed req`,
        sub: subParts.join(" · "),
        evidence:
            durationsMs.length > 0
                ? `derived · ${total} /v1/embeddings span${total === 1 ? "" : "s"} (${durationsMs.length} with latency)`
                : `derived · ${total} /v1/embeddings span${total === 1 ? "" : "s"} (outcome-only / open)`,
        tone: failed > 0 ? "tone-error" : "",
        total,
        completed,
        failed,
        cancelled,
        open,
        measurableCount: durationsMs.length,
        p50Ms,
        p95Ms,
        maxMs,
        sourceBreakdown,
        models: [...modelCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    };
}

/** Renders the Overview Embeddings card when `/v1/embeddings` spans are present, else null. */
export function renderEmbedCard(m: Metrics): HTMLElement | null {
    const model = embedCardModel(m);
    if (!model) {
        return null;
    }
    const fallbackSources = (["queued", "reported-duration", "outcome-only"] as const)
        .filter((src) => (model.sourceBreakdown[src] ?? 0) > 0)
        .map((src) => `${src} ×${model.sourceBreakdown[src]}`);
    const extra =
        model.models.length > 0 || fallbackSources.length > 0
            ? h(
                  "div",
                  { class: "embed-meta" },
                  model.models.length > 0
                      ? h(
                            "ul",
                            { class: "embed-meta-list", "aria-label": "Embedding models" },
                            ...model.models.slice(0, 6).map(([name, count]) =>
                                h("li", {}, h("span", { class: "mono", text: name }), ` ×${count}`),
                            ),
                        )
                      : null,
                  fallbackSources.length > 0
                      ? h("div", { class: "embed-sources", text: `Span reconstruction: ${fallbackSources.join(" · ")}` })
                      : null,
              )
            : null;
    return h(
        "article",
        { class: `card embed-card ${model.tone}`.trim(), "data-testid": "embed-metrics-card" },
        h("h3", { text: model.title }),
        h("div", { class: "value", text: model.value }),
        h("div", { class: "sub", text: model.sub }),
        extra,
        h("div", { class: "evidence", text: model.evidence }),
    );
}

function liveGpuRowModel(gpu: HealthGpuDevice): LiveNodeGpuRowModel {
    const gpuClass: LiveNodeGpuRowModel["gpuClass"] =
        gpu.isIntegratedUma === true ? "integrated-uma" : gpu.isIntegratedUma === false ? "discrete" : "unknown";
    const classLabel = gpuClass === "integrated-uma" ? "Integrated UMA" : gpuClass === "discrete" ? "Discrete" : "GPU";
    const poolWord = gpuClass === "integrated-uma" ? "UMA pool" : "VRAM";
    const effTotal = validMib(gpu.effectiveVramMib) ?? (gpuClass === "discrete" ? validMib(gpu.dedicatedTotalMib) : null);
    const effFreeRaw = validMib(gpu.effectiveFreeVramMib) ?? (gpuClass === "discrete" ? validMib(gpu.dedicatedFreeMib) : null);
    const effFree = effFreeRaw !== null && (effTotal === null || effFreeRaw <= effTotal) ? effFreeRaw : null;
    const effUsed = effTotal !== null && effFree !== null ? effTotal - effFree : null;
    const usedPercent =
        effTotal !== null && effTotal > 0 && effUsed !== null
            ? Math.min(100, Math.max(0, Math.round((effUsed / effTotal) * 100)))
            : null;

    let usageText: string;
    if (effUsed !== null && effTotal !== null) {
        usageText = `${fmtMib(effUsed)} / ${fmtMib(effTotal)} ${poolWord} (${usedPercent}%)`;
    } else if (effTotal !== null) {
        usageText = `${fmtMib(effTotal)} ${poolWord} total`;
    } else if (effFree !== null) {
        usageText = `${fmtMib(effFree)} ${poolWord} free`;
    } else {
        usageText = "VRAM capacity unavailable";
    }

    const details: string[] = [];
    if (effFree !== null && effUsed !== null) {
        details.push(`${fmtMib(effFree)} free`);
    }
    const ded = validMib(gpu.dedicatedTotalMib);
    const shared = validMib(gpu.sharedTotalMib);
    if (gpuClass === "integrated-uma") {
        if (ded !== null && shared !== null) {
            details.push(`${fmtMib(ded)} carveout + ${fmtMib(shared)} shared GTT`);
        } else if (shared !== null) {
            details.push(`${fmtMib(shared)} shared GTT`);
        }
    } else if (shared !== null) {
        details.push(`${fmtMib(shared)} shared`);
    }
    if (gpu.source) {
        details.push(gpu.source);
    }

    return {
        id: gpu.id,
        name: gpu.name,
        vendor: gpu.vendor,
        gpuClass,
        classLabel,
        backendHint: gpu.backendHint,
        source: gpu.source,
        usageText,
        detailText: details.length > 0 ? details.join(" · ") : null,
        usedPercent,
    };
}

function liveNodePoolModel(snap: LiveNodeSnapshot, discreteCount: number, umaCount: number): LiveNodePoolModel | null {
    const pool = snap.gpuPool;
    const combinedTotal = validMib(snap.combinedGpuVramMib ?? pool?.combinedGpuVramMib);
    if (!pool && combinedTotal === null && snap.gpus.length < 2) {
        return null;
    }
    const isHybrid = (discreteCount > 0 && umaCount > 0) || pool?.hybridVulkanPoolAvailable === true;
    const hybridVulkanAvailable = pool?.hybridVulkanPoolAvailable === true;
    const badge = hybridVulkanAvailable
        ? "Hybrid Vulkan Pool Ready"
        : isHybrid
          ? "Hybrid Discrete + UMA Pool"
          : snap.gpus.length > 1
            ? "Multi-GPU Pool"
            : "GPU Pool";
    const tone: LiveNodePoolModel["tone"] = hybridVulkanAvailable || isHybrid ? "hybrid" : "pool";

    const combinedFreeRaw = validMib(pool?.combinedFreeGpuVramMib);
    const combinedFree = combinedFreeRaw !== null && (combinedTotal === null || combinedFreeRaw <= combinedTotal) ? combinedFreeRaw : null;
    const combinedUsed = combinedTotal !== null && combinedFree !== null ? combinedTotal - combinedFree : null;
    const usedPercent =
        combinedTotal !== null && combinedTotal > 0 && combinedUsed !== null
            ? Math.min(100, Math.max(0, Math.round((combinedUsed / combinedTotal) * 100)))
            : null;

    let summaryText: string;
    if (combinedUsed !== null && combinedTotal !== null) {
        summaryText = `${fmtMib(combinedUsed)} / ${fmtMib(combinedTotal)} combined (${usedPercent}%) · ${fmtMib(combinedFree!)} free`;
    } else if (combinedTotal !== null) {
        summaryText = `${fmtMib(combinedTotal)} combined capacity`;
    } else if (combinedFree !== null) {
        summaryText = `${fmtMib(combinedFree)} combined free`;
    } else {
        summaryText = "Combined pool capacity unavailable";
    }

    const dTotal = validMib(pool?.discreteVramMib);
    const dFree = validMib(pool?.discreteFreeVramMib);
    const uTotal = validMib(pool?.integratedUmaVramMib);
    const uFree = validMib(pool?.integratedUmaFreeVramMib);
    const splitParts: string[] = [];
    if (dTotal !== null) {
        splitParts.push(`Discrete ${fmtMib(dTotal)}${dFree !== null && dFree <= dTotal ? ` (${fmtMib(dFree)} free)` : ""}`);
    }
    if (uTotal !== null) {
        splitParts.push(`UMA ${fmtMib(uTotal)}${uFree !== null && uFree <= uTotal ? ` (${fmtMib(uFree)} free)` : ""}`);
    }

    const dUsed = dTotal !== null && dFree !== null && dFree <= dTotal ? dTotal - dFree : null;
    const uUsed = uTotal !== null && uFree !== null && uFree <= uTotal ? uTotal - uFree : null;
    let discretePercent = 0;
    let umaPercent = 0;
    if (combinedTotal !== null && combinedTotal > 0) {
        if (dUsed !== null || uUsed !== null) {
            discretePercent = dUsed !== null ? Math.min(100, Math.max(0, (dUsed / combinedTotal) * 100)) : 0;
            umaPercent = uUsed !== null ? Math.min(100 - discretePercent, Math.max(0, (uUsed / combinedTotal) * 100)) : 0;
        } else if (dTotal !== null || uTotal !== null) {
            discretePercent = dTotal !== null ? Math.min(100, Math.max(0, (dTotal / combinedTotal) * 100)) : 0;
            umaPercent = uTotal !== null ? Math.min(100 - discretePercent, Math.max(0, (uTotal / combinedTotal) * 100)) : 0;
        }
    }

    return {
        badge,
        tone,
        hybridVulkanAvailable,
        summaryText,
        splitText: splitParts.length > 0 ? splitParts.join(" · ") : null,
        discretePercent,
        umaPercent,
        usedPercent,
        recommendedDevices: pool ? [...pool.recommendedDevices] : [],
        llamaArgDevice: pool?.llamaArgDevice ?? null,
    };
}

/** Pure renderer models for live `/v1/sonder/node` (and GPU-enriched health) overview cards. */
export function liveNodeCardModels(nodes: readonly LiveNodeSnapshot[]): LiveNodeCardModel[] {
    return nodes.map((snap) => {
        const gpus = snap.gpus.slice(0, MAX_OVERVIEW_GPUS).map(liveGpuRowModel);
        const discreteCount = snap.gpuPool?.discreteGpuCount ?? snap.gpus.filter((g) => g.isIntegratedUma === false).length;
        const umaCount = snap.gpuPool?.integratedUmaGpuCount ?? snap.gpus.filter((g) => g.isIntegratedUma === true).length;
        const totalGpuCount = snap.gpus.length > 0 ? snap.gpus.length : discreteCount + umaCount;

        let gpuMixLabel: string;
        if (totalGpuCount === 0) {
            gpuMixLabel = "CPU-only (0 GPUs)";
        } else {
            const prefix = `${totalGpuCount} GPU${totalGpuCount === 1 ? "" : "s"}`;
            if (discreteCount > 0 && umaCount > 0) {
                gpuMixLabel = `${prefix} · Discrete + UMA`;
            } else if (discreteCount > 0) {
                gpuMixLabel = `${prefix} · Discrete`;
            } else if (umaCount > 0) {
                gpuMixLabel = `${prefix} · Integrated UMA`;
            } else {
                gpuMixLabel = prefix;
            }
        }

        const capabilities = Object.entries(snap.capabilities)
            .filter(([, enabled]) => enabled === true)
            .map(([k]) => k)
            .sort((a, b) => a.localeCompare(b));

        return {
            connectionId: snap.connectionId,
            nodeId: snap.nodeId,
            identity: [snap.producer, snap.instanceId, snap.platform, snap.version].filter(Boolean).join(" · "),
            state: snap.state,
            synthetic: snap.synthetic,
            source: snap.source,
            gpuMixLabel,
            pool: liveNodePoolModel(snap, discreteCount, umaCount),
            gpus,
            totalGpuCount,
            modelCount: snap.modelCount,
            models: snap.models.slice(0, MAX_OVERVIEW_MODELS),
            availableBackends: snap.availableBackends,
            totalBackends: snap.totalBackends,
            backends: snap.backends,
            capabilities,
            evidence:
                snap.source === "node"
                    ? "producer-reported · /v1/sonder/node (live snapshot)"
                    : "producer-reported · /v1/sonder/health (live snapshot)",
        };
    });
}

function renderLiveNodeCard(model: LiveNodeCardModel): HTMLElement {
    const pool = model.pool;
    const poolBar =
        pool && (pool.discretePercent > 0 || pool.umaPercent > 0)
            ? h(
                  "div",
                  {
                      class: "live-node-bar",
                      role: "progressbar",
                      "aria-label":
                          pool.usedPercent !== null
                              ? `Combined VRAM utilization: ${pool.usedPercent}%`
                              : `Combined VRAM pool split: ${Math.round(pool.discretePercent)}% discrete, ${Math.round(pool.umaPercent)}% UMA`,
                      "aria-valuemin": 0,
                      "aria-valuemax": 100,
                      "aria-valuenow": pool.usedPercent ?? Math.min(100, Math.round(pool.discretePercent + pool.umaPercent)),
                  },
                  pool.discretePercent > 0
                      ? h("span", { class: "live-node-seg live-node-seg-discrete", style: `width:${pool.discretePercent.toFixed(1)}%` })
                      : null,
                  pool.umaPercent > 0
                      ? h("span", { class: "live-node-seg live-node-seg-uma", style: `width:${pool.umaPercent.toFixed(1)}%` })
                      : null,
              )
            : null;

    const poolBanner = pool
        ? h(
              "div",
              {
                  class: `live-node-pool live-node-pool-${pool.tone}`,
                  "data-testid": "live-node-pool",
                  "data-hybrid-vulkan": pool.hybridVulkanAvailable ? "true" : "false",
              },
              h(
                  "div",
                  { class: "live-node-pool-head" },
                  h("span", { class: `live-node-pill live-node-pill-${pool.tone}`, text: pool.badge }),
                  ...pool.recommendedDevices.map((dev) => h("span", { class: "live-node-pill mono", text: dev })),
                  pool.llamaArgDevice ? h("span", { class: "live-node-pill mono", title: "Recommended llama.cpp --device argument", text: `--device ${pool.llamaArgDevice}` }) : null,
              ),
              h("div", { class: "live-node-pool-summary", text: pool.summaryText }),
              poolBar,
              pool.splitText ? h("div", { class: "live-node-detail", text: pool.splitText }) : null,
          )
        : null;

    const gpuList =
        model.gpus.length > 0
            ? h(
                  "ul",
                  { class: "live-node-gpus", "data-testid": "live-node-gpus", "aria-label": `Live GPUs on ${model.nodeId}` },
                  ...model.gpus.map((gpu) =>
                      h(
                          "li",
                          { class: "live-node-gpu-row", "data-live-gpu": gpu.id, "data-gpu-class": gpu.gpuClass },
                          h(
                              "div",
                              { class: "live-node-gpu-head" },
                              h("span", { class: "live-node-gpu-name", text: gpu.name }),
                              h("span", { class: "live-node-gpu-id mono", text: gpu.id }),
                              h("span", { class: `live-node-pill live-node-class-${gpu.gpuClass}`, text: gpu.classLabel }),
                              gpu.backendHint ? h("span", { class: "live-node-pill mono", text: gpu.backendHint }) : null,
                          ),
                          h("div", { class: "live-node-gpu-usage", text: gpu.usageText }),
                          gpu.usedPercent !== null
                              ? h(
                                    "div",
                                    {
                                        class: "live-node-bar",
                                        role: "progressbar",
                                        "aria-label": `${gpu.name} ${gpu.classLabel} memory: ${gpu.usedPercent}%`,
                                        "aria-valuemin": 0,
                                        "aria-valuemax": 100,
                                        "aria-valuenow": gpu.usedPercent,
                                    },
                                    h("span", {
                                        class: `live-node-seg live-node-fill-${gpu.gpuClass}`,
                                        style: `width:${gpu.usedPercent}%`,
                                    }),
                                )
                              : null,
                          gpu.detailText ? h("div", { class: "live-node-detail", text: gpu.detailText }) : null,
                      ),
                  ),
                  model.totalGpuCount > model.gpus.length
                      ? h("li", { class: "live-node-detail", text: `+${model.totalGpuCount - model.gpus.length} more GPUs` })
                      : null,
              )
            : null;

    const shownCaps = model.capabilities.slice(0, MAX_OVERVIEW_CAPS);
    const residency = h(
        "div",
        { class: "live-node-residency", "data-testid": "live-node-residency" },
        h(
            "div",
            { class: "live-node-residency-counts" },
            h("span", { class: "live-node-pill", "data-testid": "live-node-model-count", text: `Models: ${model.modelCount}` }),
            model.totalBackends > 0
                ? h("span", {
                      class: "live-node-pill",
                      "data-testid": "live-node-backend-count",
                      text: `Backends: ${model.availableBackends}/${model.totalBackends} available`,
                  })
                : null,
            ...model.models.map((m) =>
                h("span", {
                    class: "live-node-pill mono",
                    text: m.backend ? `${m.id} (${m.backend})` : m.id,
                }),
            ),
            model.modelCount > model.models.length
                ? h("span", { class: "live-node-pill", text: `+${model.modelCount - model.models.length} more models` })
                : null,
            ...model.backends.map((b) =>
                h("span", {
                    class: `live-node-pill mono ${b.available === false ? "live-node-backend-off" : "live-node-backend-on"}`,
                    title: b.capabilities.length > 0 ? `${b.name}: ${b.capabilities.join(", ")}` : b.name,
                    text: b.available === false ? `${b.name} (offline)` : b.name,
                }),
            ),
        ),
        shownCaps.length > 0
            ? h(
                  "div",
                  { class: "live-node-cap-list", "aria-label": "Node capabilities" },
                  h("span", { class: "route-latest-label", text: "Capabilities:" }),
                  ...shownCaps.map((cap) => h("span", { class: "live-node-pill mono", text: cap })),
                  model.capabilities.length > shownCaps.length
                      ? h("span", { class: "live-node-pill", text: `+${model.capabilities.length - shownCaps.length} more` })
                      : null,
              )
            : null,
    );

    return h(
        "article",
        {
            class: "card live-node-card",
            "data-testid": "live-node-card",
            "data-live-node": model.nodeId,
            "data-node-source": model.source,
        },
        h(
            "header",
            { class: "live-node-head" },
            h(
                "div",
                { class: "live-node-title-wrap" },
                h(
                    "div",
                    { class: "live-node-title-row" },
                    h("h3", { text: "Live Node" }),
                    h("span", { class: "producer-node mono", text: model.nodeId }),
                    h("span", { class: "live-node-pill", text: model.gpuMixLabel }),
                    h("span", { class: `live-node-pill live-node-state-${model.state}`, text: model.state }),
                ),
                h("p", { class: "live-node-identity", text: model.identity || "live producer" }),
            ),
            model.synthetic ? h("span", { class: "tag tag-synthetic", text: "synthetic" }) : null,
        ),
        poolBanner,
        gpuList,
        residency,
        h("div", { class: "evidence", text: model.evidence }),
    );
}

/** Renders Live Node Hardware & Residency Overview cards for active live connections. */
export function renderLiveNodeCards(nodes: readonly LiveNodeSnapshot[]): HTMLElement[] {
    return liveNodeCardModels(nodes).map(renderLiveNodeCard);
}

function card(title: string, value: string, sub: string, evidence: string, tone = "", extra: Node | null = null): HTMLElement {
    return h(
        "article",
        { class: `card ${tone}` },
        h("h3", { text: title }),
        h("div", { class: "value", text: value }),
        h("div", { class: "sub", text: sub }),
        extra,
        h("div", { class: "evidence", text: evidence }),
    );
}

function renderReuseCard(model: ReuseCardModel | null): HTMLElement | null {
    if (!model) {
        return null;
    }
    return card(
        model.title,
        model.value,
        model.sub,
        model.evidence,
        "",
        h(
            "div",
            { class: "reuse-breakdown" },
            model.rows.length > 0
                ? h(
                      "ul",
                      { class: "per-producer", "aria-label": `${model.title} per model` },
                      ...model.rows.map(([name, text]) => h("li", { "data-model": name }, h("span", { class: "producer-cell", text: name }), ` ${text}`)),
                  )
                : null,
            model.sessionRows.length > 0
                ? h(
                      "ul",
                      { class: "per-producer", "aria-label": `${model.title} per session` },
                      ...model.sessionRows.map(([name, text]) => h("li", { "data-session": name }, h("span", { class: "producer-cell", text: `session ${name}` }), ` ${text}`)),
                      ...(model.moreSessions > 0 ? [h("li", { text: `+${model.moreSessions} more sessions` })] : []),
                  )
                : null,
        ),
    );
}

export function renderOverviewCards(
    m: Metrics,
    events: readonly ObservatoryEvent[],
    visibleCount: number,
    store: Pick<SessionStore, "rejectedCount" | "droppedByRetention"> & { source?: SessionStore["source"] },
    liveNodes?: readonly LiveNodeSnapshot[],
): void {
    const res = m.resources;
    const tokenCard = tokenCardModel(m);
    const derived = (n: number, what: string) => (n > 0 ? `derived · ${n} ${what}` : "unavailable · no events yet");
    const errorTypes = Object.entries(m.errors.byType)
        .map(([t, n]) => `${t} ×${n}`)
        .join(", ");
    const perProducer = Object.entries(m.requestLatencyByProducer).sort(([a], [b]) => a.localeCompare(b));
    const producerRows =
        perProducer.length > 1
            ? h(
                  "ul",
                  { class: "per-producer", "aria-label": "Request latency per producer" },
                  ...perProducer.map(([name, stats]) =>
                      h(
                          "li",
                          { "data-producer": name },
                          h("span", { class: "producer-cell", text: name }),
                          ` p50 ${fmtMs(stats.p50Ms)} · p95 ${fmtMs(stats.p95Ms)} · ${stats.count} req`,
                      ),
                  ),
              )
            : null;
    // Present only when a request reported them, so other streams render as before.
    const reuseCards = [renderReuseCard(promptCacheCardModel(m)), renderReuseCard(speculationCardModel(m))].filter(
        (c): c is HTMLElement => c !== null,
    );
    const embedCard = renderEmbedCard(m);
    const embedCount = m.requests.filter((r) => r.requestKind === "embed").length;
    const prefillDecode = prefillDecodeAt(events, visibleCount);
    const routes = executionRouteAt(events, visibleCount);
    const nodeGpus = nodeGpuMemoryAt(events, visibleCount);
    const activeLiveNodes =
        liveNodes !== undefined
            ? liveNodes
            : store.source === "file" || store.source === "fixture"
              ? []
              : liveNodesForStore(store);
    const ttftTone = prefillDecode.ttft.latestClassification === "reload" ? "tone-warning" : "";
    byId("cards").replaceChildren(
        card(
            "Request latency",
            `p50 ${fmtMs(m.requestLatency.p50Ms)}`,
            `p95 ${fmtMs(m.requestLatency.p95Ms)} · max ${fmtMs(m.requestLatency.maxMs)} · open ${m.requests.filter((r) => r.outcome === "open").length}${embedCount > 0 ? ` · ${embedCount} embed` : ""}`,
            derived(m.requestLatency.count, "finished requests (request.started → end)"),
            "",
            producerRows,
        ),
        card(
            "Time to first token",
            `p50 ${fmtMs(m.timeToFirstToken.p50Ms)}`,
            `p95 ${fmtMs(m.timeToFirstToken.p95Ms)}`,
            derived(m.timeToFirstToken.count, "requests with a first token"),
            ttftTone,
            renderTtftBreakdown(prefillDecode),
        ),
        card("Token rate", tokenCard.value, tokenCard.sub, tokenCard.evidence, "", renderPrefillDecodeSplit(prefillDecode)),
        ...reuseCards,
        ...(embedCard ? [embedCard] : []),
        ...renderRouteCards(routes, { breakdown: m.executionRoutes, orchestration: m.orchestration }),
        ...renderLiveNodeCards(activeLiveNodes),
        ...renderNodeGpuCards(nodeGpus),
        ...renderGpuCards(gpuMemoryAt(events, visibleCount)),
        card(
            "Errors",
            `${m.errors.total}`,
            errorTypes || "none",
            m.errors.total > 0 ? `derived · failed/retry/guard events` : "derived · no error events",
            m.errors.total > 0 ? "tone-error" : "tone-ok",
        ),
        card(
            "Agents & tools",
            `${m.agents.active.length} active agent(s)`,
            `spawned ${m.agents.spawned} · done ${m.agents.completed} · tools ${m.tools.called} called, ${m.tools.failed} failed, ${m.tools.active.length} running`,
            derived(m.agents.transitions, "agent/route transitions"),
        ),
        card(
            "Resource pressure",
            res.latest ? `${fmtPct(res.latest.fraction)} memory` : "—",
            res.latest
                ? `${fmtBytes(res.latest.usedBytes)} / ${fmtBytes(res.latest.totalBytes)} · peak ${fmtPct(res.peak?.fraction ?? null)} · compute ${fmtPct(res.latestComputeUtilization)} · pressure events ${res.pressureEvents}`
                : `pressure events ${res.pressureEvents}`,
            res.latest ? `producer-reported · device.memory.sample ${res.latest.deviceId ?? ""}` : "unavailable · no device samples",
            res.latest && res.latest.fraction >= 0.9 ? "tone-warning" : "",
        ),
        card(
            "Telemetry",
            `${m.eventCount} events`,
            `dropped (producer-reported) ${m.droppedEvents} · rejected ${store.rejectedCount}${store.droppedByRetention > 0 ? ` · ${store.droppedByRetention} older not retained` : ""}`,
            "measured · events received at the cursor",
            m.droppedEvents > 0 ? "tone-warning" : "",
        ),
    );
}
