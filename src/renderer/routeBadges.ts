/**
 * Execution-route, ensemble, and fanout telemetry badges, Wave 2 per-mode/band
 * latency breakdown, and orchestration lifecycle summary for the Overview card
 * and metric strip.
 *
 * Renders only when the stream emits explicit `execution_route` / `execution_mode`
 * / `ensemble.*` / `fanout.*` telemetry, so streams without those events render
 * identically to before.
 */
import type { DifficultyBand, ExecutionMode, ExecutionRouteMetrics, ExecutionRouteRecord } from "../query/executionRoute";
import type { ExecutionRouteBreakdown, OrchestrationKind, OrchestrationKindSummary, OrchestrationMetrics, OrchestrationSpan } from "../query/metrics";
import { h } from "./dom";
import { fmtMs } from "./format";
import "./routeBadges.css";

export interface RouteBadgeModel {
    mode: ExecutionMode;
    label: string;
    scoreText: string | null;
    tooltip: string;
}

export interface RouteModeCount {
    mode: ExecutionMode;
    label: string;
    count: number;
}

export interface RouteBandStat {
    band: DifficultyBand;
    label: string;
    count: number;
    p50Ms: number | null;
    p95Ms: number | null;
    latencyCount: number;
}

export interface RouteModeLatency {
    mode: ExecutionMode;
    label: string;
    count: number;
    p50Ms: number | null;
    p95Ms: number | null;
    maxMs: number | null;
}

export interface OrchestrationKindRow {
    kind: OrchestrationKind;
    label: string;
    total: number;
    open: number;
    completed: number;
    failed: number;
    cancelled: number;
    summaryText: string;
    latencyText: string | null;
}

export interface OrchestrationSpanRow {
    kind: OrchestrationKind;
    label: string;
    spanId: string;
    producer: string;
    outcome: OrchestrationSpan["outcome"];
    durationText: string;
    participantsText: string | null;
    scopeOrMode: string | null;
    tiersText: string | null;
}

export interface RouteCardExtras {
    breakdown?: ExecutionRouteBreakdown;
    orchestration?: OrchestrationMetrics;
}

export interface RouteCardModel {
    title: string;
    value: string;
    sub: string;
    evidence: string;
    synthetic: boolean;
    modeCounts: RouteModeCount[];
    bandStats: RouteBandStat[];
    modeLatencies: RouteModeLatency[];
    orchestrationKinds: OrchestrationKindRow[];
    orchestrationSpans: OrchestrationSpanRow[];
    latestBadge: RouteBadgeModel | null;
    recent: {
        requestId: string;
        nodeId: string;
        badge: RouteBadgeModel;
        reason: string | null;
    }[];
}

const MODE_LABELS: Record<ExecutionMode, string> = {
    single: "Single",
    ensemble: "Ensemble",
    fanout: "Fanout",
    agent: "Agent",
};

const BAND_LABELS: Record<DifficultyBand, string> = {
    quick: "Quick",
    standard: "Standard",
    hard: "Hard",
    multi_scope: "Multi-Scope",
};

const ORCH_LABELS: Record<OrchestrationKind, string> = {
    fanout: "Fanout",
    ensemble: "Ensemble",
};

const ORDERED_MODES: readonly ExecutionMode[] = ["ensemble", "fanout", "agent", "single"];
const ORDERED_BANDS: readonly DifficultyBand[] = ["multi_scope", "hard", "standard", "quick"];

function plural(n: number, one: string, many = `${one}s`): string {
    return `${n} ${n === 1 ? one : many}`;
}

function orchestrationTag(orchestration?: OrchestrationMetrics): string | null {
    if (!orchestration) {
        return null;
    }
    const total = orchestration.fanout.total + orchestration.ensemble.total;
    if (total === 0) {
        return null;
    }
    const open = orchestration.fanout.open + orchestration.ensemble.open;
    const completed = orchestration.fanout.completed + orchestration.ensemble.completed;
    const failed = orchestration.fanout.failed + orchestration.ensemble.failed;
    const cancelled = orchestration.fanout.cancelled + orchestration.ensemble.cancelled;
    const parts: string[] = [];
    if (open > 0) {
        parts.push(`${open} active`);
    }
    if (completed > 0) {
        parts.push(`${completed} done`);
    }
    if (failed > 0) {
        parts.push(`${failed} failed`);
    }
    if (cancelled > 0) {
        parts.push(`${cancelled} cancelled`);
    }
    return `orch ${parts.join(", ")}`;
}

function buildOrchKindRow(kind: OrchestrationKind, summary: OrchestrationKindSummary): OrchestrationKindRow | null {
    if (summary.total === 0) {
        return null;
    }
    const parts: string[] = [`×${summary.total}`];
    if (summary.open > 0) {
        parts.push(`${summary.open} open`);
    }
    if (summary.completed > 0) {
        parts.push(`${summary.completed} ok`);
    }
    if (summary.failed > 0) {
        parts.push(`${summary.failed} failed`);
    }
    if (summary.cancelled > 0) {
        parts.push(`${summary.cancelled} cancelled`);
    }
    const latencyText =
        summary.latency.count > 0
            ? `p50 ${fmtMs(summary.latency.p50Ms)} · p95 ${fmtMs(summary.latency.p95Ms)}`
            : null;
    return {
        kind,
        label: ORCH_LABELS[kind],
        total: summary.total,
        open: summary.open,
        completed: summary.completed,
        failed: summary.failed,
        cancelled: summary.cancelled,
        summaryText: parts.join(" · "),
        latencyText,
    };
}

function formatParticipants(span: OrchestrationSpan): string | null {
    const unit = span.kind === "fanout" ? "workers" : "candidates";
    const tracked = span.participantsStarted + span.participantsCompleted + span.participantsFailed + span.participantsCancelled;
    if (tracked === 0) {
        return span.participantCount !== null ? `${span.participantCount} ${unit}` : null;
    }
    const total = span.participantCount ?? span.participantsStarted;
    const parts: string[] = [];
    if (total > 0) {
        parts.push(`${span.participantsCompleted}/${total} ok`);
    } else if (span.participantsCompleted > 0) {
        parts.push(`${span.participantsCompleted} ok`);
    }
    if (span.participantsFailed > 0) {
        parts.push(`${span.participantsFailed} failed`);
    }
    if (span.participantsCancelled > 0) {
        parts.push(`${span.participantsCancelled} cancelled`);
    }
    return `${parts.join(", ")} ${unit}`;
}

/** Compact human-readable route badge text (e.g. `Auto · Hard · Ensemble (code+reasoning)`). */
export function executionRouteBadgeModel(record: ExecutionRouteRecord): RouteBadgeModel {
    const parts: string[] = [];
    if (record.autoSelected === true) {
        parts.push("Auto");
    } else if (record.autoSelected === false) {
        parts.push("Manual");
    }
    if (record.band) {
        parts.push(BAND_LABELS[record.band]);
    }
    const modeTitle = MODE_LABELS[record.mode];
    let qualifier = "";
    if (record.recommendedTiers.length > 0) {
        qualifier = ` (${record.recommendedTiers.join("+")})`;
    } else if (record.mode === "fanout" && record.fanoutScope) {
        qualifier = ` (${record.fanoutScope})`;
    } else if (record.mode === "ensemble" && record.ensembleMode) {
        qualifier = ` (${record.ensembleMode})`;
    } else if (record.participantCount !== null) {
        qualifier = ` (×${record.participantCount})`;
    }
    parts.push(`${modeTitle}${qualifier}`);

    const scoreText = record.difficultyScore !== null ? `score ${record.difficultyScore.toFixed(2)}` : null;
    const tipParts: string[] = [];
    if (record.summaryLine) {
        tipParts.push(record.summaryLine);
    } else {
        tipParts.push(parts.join(" · "));
    }
    if (scoreText) {
        tipParts.push(scoreText);
    }
    if (record.reason) {
        tipParts.push(record.reason);
    }
    if (record.signals.length > 0) {
        tipParts.push(`signals: ${record.signals.join(", ")}`);
    }

    return {
        mode: record.mode,
        label: parts.join(" · "),
        scoreText,
        tooltip: tipParts.join(" — "),
    };
}

/** Short one-line summary for the metric strip's Agent activity sub-line, or null when absent. */
export function stripRouteSummary(routes: ExecutionRouteMetrics, orchestration?: OrchestrationMetrics): string | null {
    const orch = orchestrationTag(orchestration);
    if (routes.total === 0 || !routes.latest) {
        return orch;
    }
    const latest = executionRouteBadgeModel(routes.latest);
    const highlights: string[] = [latest.label];
    if (routes.byMode.ensemble > 0) {
        highlights.push(`${routes.byMode.ensemble} ensemble`);
    }
    if (routes.byMode.fanout > 0) {
        highlights.push(`${routes.byMode.fanout} fanout`);
    }
    if (orch) {
        highlights.push(orch);
    }
    return highlights.join(" · ");
}

/** Fallback summary from Metrics.executionRoutes + Metrics.orchestration when ExecutionRouteMetrics isn't passed. */
export function stripBreakdownSummary(
    breakdown: ExecutionRouteBreakdown,
    orchestration?: OrchestrationMetrics,
): string | null {
    const highlights: string[] = [];
    if (breakdown.total > 0) {
        for (const mode of ORDERED_MODES) {
            if (breakdown.byMode[mode] > 0) {
                highlights.push(`${breakdown.byMode[mode]} ${mode}`);
            }
        }
    }
    const orch = orchestrationTag(orchestration);
    if (orch) {
        highlights.push(orch);
    }
    return highlights.length > 0 ? highlights.join(" · ") : null;
}

/** Pure model for the Overview "Execution routing" card; null when no execution-route or orchestration telemetry exists. */
export function routeCardModel(routes: ExecutionRouteMetrics, extras?: RouteCardExtras): RouteCardModel | null {
    const orchestration = extras?.orchestration;
    const breakdown = extras?.breakdown;
    const orchTotal = orchestration ? orchestration.fanout.total + orchestration.ensemble.total : 0;
    if (routes.total === 0 && orchTotal === 0) {
        return null;
    }

    const modeCounts: RouteModeCount[] = ORDERED_MODES
        .filter((mode) => routes.byMode[mode] > 0)
        .map((mode) => ({ mode, label: MODE_LABELS[mode], count: routes.byMode[mode] }));

    const bandSource = breakdown && breakdown.total > 0 ? breakdown.byBand : routes.byBand;
    const bandStats: RouteBandStat[] = ORDERED_BANDS
        .filter((band) => bandSource[band] > 0)
        .map((band) => {
            const lat = breakdown?.latencyByBand[band];
            return {
                band,
                label: BAND_LABELS[band],
                count: bandSource[band],
                p50Ms: lat?.p50Ms ?? null,
                p95Ms: lat?.p95Ms ?? null,
                latencyCount: lat?.count ?? 0,
            };
        });

    const modeLatencies: RouteModeLatency[] = breakdown
        ? ORDERED_MODES.flatMap((mode) => {
              const lat = breakdown.latencyByMode[mode];
              return lat && lat.count > 0
                  ? [{ mode, label: MODE_LABELS[mode], count: lat.count, p50Ms: lat.p50Ms, p95Ms: lat.p95Ms, maxMs: lat.maxMs }]
                  : [];
          })
        : [];

    const orchestrationKinds: OrchestrationKindRow[] = orchestration
        ? [buildOrchKindRow("fanout", orchestration.fanout), buildOrchKindRow("ensemble", orchestration.ensemble)].filter(
              (row): row is OrchestrationKindRow => row !== null,
          )
        : [];

    const orchestrationSpans: OrchestrationSpanRow[] = orchestration
        ? orchestration.spans
              .slice(-6)
              .reverse()
              .map((span) => ({
                  kind: span.kind,
                  label: ORCH_LABELS[span.kind],
                  spanId: span.spanId,
                  producer: span.producer,
                  outcome: span.outcome,
                  durationText: span.outcome === "open" ? "in flight" : fmtMs(span.durationMs),
                  participantsText: formatParticipants(span),
                  scopeOrMode: span.scopeOrMode,
                  tiersText: span.tiers.length > 0 ? span.tiers.join("+") : null,
              }))
        : [];

    const hasRoutes = routes.total > 0 && routes.latest !== null;
    const value = hasRoutes
        ? modeCounts.map((m) => `${m.label} ×${m.count}`).join(" · ")
        : orchestrationKinds.map((k) => `${k.label} ×${k.total}`).join(" · ");

    const subParts: string[] = [];
    if (hasRoutes) {
        subParts.push(plural(routes.total, "routed turn"));
        if (routes.autoCount > 0) {
            subParts.push(`${routes.autoCount} auto`);
        }
        if (routes.manualCount > 0) {
            subParts.push(`${routes.manualCount} manual`);
        }
    } else {
        subParts.push(plural(orchTotal, "orchestration run"));
        const orchStatus = orchestrationTag(orchestration);
        if (orchStatus) {
            subParts.push(orchStatus);
        }
    }

    const evidenceParts: string[] = [];
    if (routes.total > 0) {
        evidenceParts.push(plural(routes.total, "turn"));
    }
    if (orchTotal > 0) {
        evidenceParts.push(plural(orchTotal, "orchestration span"));
    }

    return {
        title: "Execution routing",
        value,
        sub: subParts.join(" · "),
        evidence: `producer-reported · execution_route / ensemble / fanout (${evidenceParts.join(", ")})`,
        synthetic: routes.synthetic,
        modeCounts,
        bandStats,
        modeLatencies,
        orchestrationKinds,
        orchestrationSpans,
        latestBadge: routes.latest ? executionRouteBadgeModel(routes.latest) : null,
        recent: routes.records
            .slice(-6)
            .reverse()
            .map((r) => ({
                requestId: r.requestId ?? r.eventId,
                nodeId: r.nodeId,
                badge: executionRouteBadgeModel(r),
                reason: r.reason,
            })),
    };
}

function badgePill(badge: RouteBadgeModel): HTMLElement {
    return h(
        "span",
        {
            class: `route-badge route-mode-${badge.mode}`,
            title: badge.tooltip,
            "data-route-mode": badge.mode,
        },
        badge.label,
        badge.scoreText ? h("span", { class: "route-badge-score mono", text: badge.scoreText }) : null,
    );
}

/** Renders the Execution routing & orchestration Overview card (empty array when neither is present). */
export function renderRouteCards(routes: ExecutionRouteMetrics, extras?: RouteCardExtras): HTMLElement[] {
    const model = routeCardModel(routes, extras);
    if (!model) {
        return [];
    }
    const breakdownEl =
        model.bandStats.length > 0 || model.modeLatencies.length > 0
            ? h(
                  "div",
                  { class: "route-breakdown", "data-testid": "route-breakdown" },
                  model.bandStats.length > 0
                      ? h(
                            "div",
                            { class: "route-breakdown-row", "aria-label": "Difficulty band breakdown" },
                            h("span", { class: "route-latest-label", text: "Bands:" }),
                            ...model.bandStats.map((b) =>
                                h("span", {
                                    class: "route-stat-pill",
                                    "data-route-band": b.band,
                                    text:
                                        b.latencyCount > 0
                                            ? `${b.label} ×${b.count} · p50 ${fmtMs(b.p50Ms)}`
                                            : `${b.label} ×${b.count}`,
                                    title:
                                        b.latencyCount > 0
                                            ? `${b.label}: ${b.count} routed, ${b.latencyCount} finished (p50 ${fmtMs(b.p50Ms)}, p95 ${fmtMs(b.p95Ms)})`
                                            : `${b.label}: ${b.count} routed`,
                                }),
                            ),
                        )
                      : null,
                  model.modeLatencies.length > 0
                      ? h(
                            "div",
                            { class: "route-breakdown-row", "aria-label": "Finished request latency by execution mode" },
                            h("span", { class: "route-latest-label", text: "Mode latency:" }),
                            ...model.modeLatencies.map((ml) =>
                                h("span", {
                                    class: `route-stat-pill route-mode-${ml.mode}`,
                                    "data-route-latency": ml.mode,
                                    text: `${ml.label} p50 ${fmtMs(ml.p50Ms)} · p95 ${fmtMs(ml.p95Ms)} (${ml.count})`,
                                    title: `${ml.label}: ${ml.count} finished requests, max ${fmtMs(ml.maxMs)}`,
                                }),
                            ),
                        )
                      : null,
              )
            : null;

    const orchEl =
        model.orchestrationKinds.length > 0
            ? h(
                  "div",
                  { class: "orch-section", "data-testid": "orchestration-summary" },
                  h(
                      "div",
                      { class: "orch-kind-row", "aria-label": "Orchestration lifecycle totals" },
                      h("span", { class: "route-latest-label", text: "Orchestration:" }),
                      ...model.orchestrationKinds.map((k) =>
                          h(
                              "span",
                              { class: `route-stat-pill route-mode-${k.kind}`, "data-orch-kind": k.kind },
                              `${k.label} ${k.summaryText}${k.latencyText ? ` · ${k.latencyText}` : ""}`,
                          ),
                      ),
                  ),
                  model.orchestrationSpans.length > 0
                      ? h(
                            "ul",
                            { class: "orch-span-list", "data-testid": "orchestration-spans", "aria-label": "Recent orchestration spans" },
                            ...model.orchestrationSpans.map((span) =>
                                h(
                                    "li",
                                    { class: "orch-span-item", "data-orch-span": span.spanId, "data-orch-outcome": span.outcome },
                                    h("span", { class: `route-badge route-mode-${span.kind}`, text: `${span.label}${span.scopeOrMode ? ` (${span.scopeOrMode})` : ""}` }),
                                    h("span", { class: "route-recent-id mono", text: `${span.producer} · ${span.spanId}` }),
                                    h("span", { class: `orch-outcome orch-outcome-${span.outcome}`, text: span.outcome }),
                                    h("span", { class: "mono orch-duration", text: span.durationText }),
                                    span.participantsText ? h("span", { class: "orch-participants", text: span.participantsText }) : null,
                                    span.tiersText ? h("span", { class: "route-stat-pill mono", text: span.tiersText }) : null,
                                ),
                            ),
                        )
                      : null,
              )
            : null;

    return [
        h(
            "article",
            { class: "card route-card", "data-testid": "execution-route-card" },
            h(
                "header",
                { class: "route-card-header" },
                h("h3", { text: model.title }),
                model.synthetic ? h("span", { class: "tag tag-synthetic", text: "synthetic" }) : null,
            ),
            h("div", { class: "value route-card-value", text: model.value }),
            h("div", { class: "sub", text: model.sub }),
            model.modeCounts.length > 0
                ? h(
                      "div",
                      { class: "route-mode-pills", "aria-label": "Execution mode totals" },
                      ...model.modeCounts.map((m) =>
                          h("span", { class: `route-badge route-mode-${m.mode}`, "data-route-count": m.mode, text: `${m.label} ×${m.count}` }),
                      ),
                  )
                : null,
            model.latestBadge
                ? h(
                      "div",
                      { class: "route-latest" },
                      h("span", { class: "route-latest-label", text: "Latest:" }),
                      badgePill(model.latestBadge),
                  )
                : null,
            breakdownEl,
            orchEl,
            model.recent.length > 0
                ? h(
                      "ul",
                      { class: "route-recent-list", "aria-label": "Recent routed turns" },
                      ...model.recent.map((item) =>
                          h(
                              "li",
                              { class: "route-recent-item" },
                              h("span", { class: "route-recent-id mono", text: `${item.nodeId} · ${item.requestId}` }),
                              badgePill(item.badge),
                              item.reason ? h("span", { class: "route-recent-reason", text: item.reason }) : null,
                          ),
                      ),
                  )
                : null,
            h("div", { class: "evidence", text: model.evidence }),
        ),
    ];
}
