/**
 * Pure models and DOM helpers for Prefill tok/s vs Decode tok/s separation and
 * TTFT reload-vs-steady-prefill breakdown inside Overview cards.
 *
 * Never invents missing measurements; absent rates read "—". Uses dedicated
 * classes (never `.per-producer`) so existing Overview card contracts stay intact.
 */
import type { PrefillDecodeMetrics, RequestPhaseMetrics, TtftClassification } from "../query/prefillDecode";
import { h } from "./dom";
import { fmtMs, fmtRate } from "./format";
import "./prefillDecodeCard.css";

export interface PhaseRateModel {
    label: string;
    value: string;
    detail: string;
    provenance: string;
    available: boolean;
}

export interface RecentPhaseRow {
    requestId: string;
    nodeId: string;
    model: string | null;
    prefillText: string;
    decodeText: string;
    ttftText: string;
    ttftClass: TtftClassification;
    badgeLabel: string;
    reloadReason: string | null;
}

export interface PrefillDecodeSplitModel {
    hasData: boolean;
    prefill: PhaseRateModel;
    decode: PhaseRateModel;
    recent: RecentPhaseRow[];
}

export interface TtftClassRow {
    kind: "steady-prefill" | "reload" | "overhead-spike";
    label: string;
    tone: "ok" | "warn" | "info";
    count: number;
    summary: string;
}

export interface TtftBreakdownModel {
    hasData: boolean;
    latestBadge: string | null;
    latestTone: "ok" | "warn" | "info" | "neutral";
    latestDetail: string | null;
    rows: TtftClassRow[];
}

function plural(n: number, one: string, many = `${one}s`): string {
    return `${n} ${n === 1 ? one : many}`;
}

export function ttftClassLabel(kind: TtftClassification): string {
    switch (kind) {
        case "steady-prefill":
            return "Steady prefill";
        case "reload":
            return "Model reload";
        case "overhead-spike":
            return "TTFT overhead";
        default:
            return "Unclassified";
    }
}

function ttftClassTone(kind: TtftClassification | null): "ok" | "warn" | "info" | "neutral" {
    switch (kind) {
        case "steady-prefill":
            return "ok";
        case "reload":
            return "warn";
        case "overhead-spike":
            return "info";
        default:
            return "neutral";
    }
}

function recentRow(r: RequestPhaseMetrics): RecentPhaseRow {
    const prefillText = r.fullPromptCacheHit
        ? "100% cached"
        : r.prefillTokPerSec !== null
          ? `${fmtRate(r.prefillTokPerSec)} tok/s`
          : "—";
    const decodeText = r.decodeTokPerSec !== null ? `${fmtRate(r.decodeTokPerSec)} tok/s` : "—";
    const ttftText = fmtMs(r.ttftMs);
    const badgeLabel =
        r.ttftClass === "reload" && r.loadMs !== null
            ? `Reload (${fmtMs(r.loadMs)})`
            : ttftClassLabel(r.ttftClass);
    return {
        requestId: r.requestId,
        nodeId: r.nodeId,
        model: r.model,
        prefillText,
        decodeText,
        ttftText,
        ttftClass: r.ttftClass,
        badgeLabel,
        reloadReason: r.reloadReason,
    };
}

/** Pure model for the Prefill tok/s vs Decode tok/s breakdown inside the Token rate card. */
export function prefillDecodeSplitModel(pd: PrefillDecodeMetrics): PrefillDecodeSplitModel {
    const p = pd.prefill;
    const d = pd.decode;
    const hasPrefill = p.rateTokPerSec !== null || p.fullCacheHitRequests > 0;
    const hasDecode = d.rateTokPerSec !== null;
    const hasData = hasPrefill || hasDecode;

    const prefillDetails: string[] = [];
    if (p.latestRateTokPerSec !== null && p.requests > 1) {
        prefillDetails.push(`latest ${fmtRate(p.latestRateTokPerSec)} tok/s`);
    }
    if (p.latency.p50Ms !== null) {
        prefillDetails.push(`p50 ${fmtMs(p.latency.p50Ms)}`);
    }
    if (p.totalEvaluatedTokens > 0) {
        prefillDetails.push(`${p.totalEvaluatedTokens} eval tok`);
    }
    if (p.fullCacheHitRequests > 0) {
        prefillDetails.push(`${plural(p.fullCacheHitRequests, "full cache hit")}`);
    }
    if (p.rateTokPerSec === null && p.fullCacheHitRequests === 0) {
        prefillDetails.push("no prefill timing yet");
    } else if (p.requests === 0 && p.gaugeRateTokPerSec !== null) {
        prefillDetails.push("backend /metrics gauge");
    }

    const decodeDetails: string[] = [];
    if (d.latestRateTokPerSec !== null && d.requests > 1) {
        decodeDetails.push(`latest ${fmtRate(d.latestRateTokPerSec)} tok/s`);
    }
    if (d.latency.p50Ms !== null) {
        decodeDetails.push(`p50 ${fmtMs(d.latency.p50Ms)}`);
    }
    if (d.totalTokens > 0) {
        decodeDetails.push(`${plural(d.totalTokens, "tok")}`);
    }
    if (d.rateTokPerSec === null) {
        decodeDetails.push("no decode timing yet");
    } else if (d.requests === 0 && d.gaugeRateTokPerSec !== null) {
        decodeDetails.push("backend /metrics gauge");
    }

    const recent = pd.requests
        .filter((r) => r.prefillTokPerSec !== null || r.decodeTokPerSec !== null || r.fullPromptCacheHit || r.ttftClass === "reload")
        .slice(-4)
        .reverse()
        .map(recentRow);

    return {
        hasData,
        prefill: {
            label: "Prefill",
            value:
                p.rateTokPerSec !== null
                    ? `${fmtRate(p.rateTokPerSec)} tok/s`
                    : p.fullCacheHitRequests > 0
                      ? "100% cached"
                      : "—",
            detail: prefillDetails.join(" · "),
            provenance: p.provenance,
            available: hasPrefill,
        },
        decode: {
            label: "Decode",
            value: d.rateTokPerSec !== null ? `${fmtRate(d.rateTokPerSec)} tok/s` : "—",
            detail: decodeDetails.join(" · "),
            provenance: d.provenance,
            available: hasDecode,
        },
        recent,
    };
}

/** Pure model for the Steady Prefill vs Model Reload TTFT breakdown inside the TTFT card. */
export function ttftBreakdownModel(pd: PrefillDecodeMetrics): TtftBreakdownModel {
    const t = pd.ttft;
    if (t.classifiedCount === 0) {
        return {
            hasData: false,
            latestBadge: null,
            latestTone: "neutral",
            latestDetail: null,
            rows: [],
        };
    }

    const rows: TtftClassRow[] = [];
    if (t.steadyPrefill.count > 0) {
        rows.push({
            kind: "steady-prefill",
            label: "Steady prefill",
            tone: "ok",
            count: t.steadyPrefill.count,
            summary: `${plural(t.steadyPrefill.count, "req")} · p50 ${fmtMs(t.steadyPrefill.p50Ms)}${t.steadyPrefill.count > 1 ? ` · p95 ${fmtMs(t.steadyPrefill.p95Ms)}` : ""}`,
        });
    }
    if (t.reload.count > 0) {
        rows.push({
            kind: "reload",
            label: "Model reload",
            tone: "warn",
            count: t.reload.count,
            summary: `${plural(t.reload.count, "req")} · p50 ${fmtMs(t.reload.p50Ms)}${t.reload.maxMs !== null && t.reload.count > 1 ? ` · max ${fmtMs(t.reload.maxMs)}` : ""}`,
        });
    }
    if (t.overheadSpike.count > 0) {
        rows.push({
            kind: "overhead-spike",
            label: "TTFT overhead",
            tone: "info",
            count: t.overheadSpike.count,
            summary: `${plural(t.overheadSpike.count, "req")} · p50 ${fmtMs(t.overheadSpike.p50Ms)} (TTFT exceeds prefill)`,
        });
    }

    let latestBadge: string | null = null;
    let latestDetail: string | null = null;
    if (t.latestClassification && t.latestClassification !== "unknown") {
        latestBadge = `Latest: ${ttftClassLabel(t.latestClassification)}`;
        if (t.latestClassification === "reload" && t.latestLoadMs !== null) {
            latestDetail = `${fmtMs(t.latestTtftMs)} TTFT (${fmtMs(t.latestLoadMs)} load)`;
        } else if (t.latestTtftMs !== null) {
            latestDetail = `${fmtMs(t.latestTtftMs)} TTFT`;
        }
    }

    return {
        hasData: true,
        latestBadge,
        latestTone: ttftClassTone(t.latestClassification),
        latestDetail,
        rows,
    };
}

/** Compact DOM block separating Prefill tok/s and Decode tok/s inside the Token rate card. */
export function renderPrefillDecodeSplit(pd: PrefillDecodeMetrics): HTMLElement | null {
    const model = prefillDecodeSplitModel(pd);
    if (!model.hasData) {
        return null;
    }
    const col = (cls: string, item: PhaseRateModel) =>
        h(
            "div",
            { class: `pd-col ${cls}`, "data-phase": item.label.toLowerCase() },
            h("div", { class: "pd-label", text: item.label }),
            h("div", { class: "pd-rate", text: item.value }),
            h("div", { class: "pd-detail", text: item.detail }),
        );

    const recentList =
        model.recent.length > 0 &&
        (model.recent.some((r) => r.ttftClass === "reload" || r.ttftClass === "overhead-spike") ||
            new Set(model.recent.map((r) => r.nodeId)).size > 1)
            ? h(
                  "ul",
                  { class: "pd-recent", "aria-label": "Recent prefill and decode requests" },
                  ...model.recent.map((r) =>
                      h(
                          "li",
                          { class: "pd-recent-row", "data-ttft-class": r.ttftClass },
                          h("span", { class: "pd-recent-id mono", text: r.nodeId }),
                          h("span", { class: "pd-recent-rates mono", text: `P ${r.prefillText} · D ${r.decodeText}` }),
                          r.ttftClass !== "unknown"
                              ? h("span", {
                                    class: `pd-pill pd-pill-${ttftClassTone(r.ttftClass)}`,
                                    title: r.reloadReason ?? undefined,
                                    text: r.badgeLabel,
                                })
                              : null,
                      ),
                  ),
              )
            : null;

    return h(
        "div",
        { class: "pd-split-wrap", "data-testid": "prefill-decode-split" },
        h("div", { class: "pd-split" }, col("pd-prefill", model.prefill), col("pd-decode", model.decode)),
        recentList,
    );
}

/** Compact DOM block separating Steady Prefill vs Model Reload inside the TTFT card. */
export function renderTtftBreakdown(pd: PrefillDecodeMetrics): HTMLElement | null {
    const model = ttftBreakdownModel(pd);
    if (!model.hasData) {
        return null;
    }
    return h(
        "div",
        { class: "ttft-breakdown", "data-testid": "ttft-breakdown" },
        model.latestBadge
            ? h(
                  "div",
                  { class: "ttft-latest" },
                  h("span", { class: `pd-pill pd-pill-${model.latestTone}`, text: model.latestBadge }),
                  model.latestDetail ? h("span", { class: "ttft-latest-detail mono", text: model.latestDetail }) : null,
              )
            : null,
        h(
            "ul",
            { class: "ttft-rows", "aria-label": "TTFT breakdown by steady prefill versus model reload" },
            ...model.rows.map((row) =>
                h(
                    "li",
                    { class: "ttft-row", "data-ttft-kind": row.kind },
                    h("span", { class: `pd-pill pd-pill-${row.tone}`, text: row.label }),
                    h("span", { class: "ttft-row-summary", text: row.summary }),
                ),
            ),
        ),
    );
}
