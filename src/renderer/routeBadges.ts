/**
 * Execution-route, ensemble, and fanout telemetry badges and Overview card.
 *
 * Renders only when the stream emits explicit `execution_route` / `execution_mode`
 * / `ensemble.*` / `fanout.*` telemetry, so streams without those events render
 * identically to before.
 */
import type { DifficultyBand, ExecutionMode, ExecutionRouteMetrics, ExecutionRouteRecord } from "../query/executionRoute";
import { h } from "./dom";
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

export interface RouteCardModel {
    title: string;
    value: string;
    sub: string;
    evidence: string;
    synthetic: boolean;
    modeCounts: RouteModeCount[];
    latestBadge: RouteBadgeModel;
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

function plural(n: number, one: string, many = `${one}s`): string {
    return `${n} ${n === 1 ? one : many}`;
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
export function stripRouteSummary(routes: ExecutionRouteMetrics): string | null {
    if (routes.total === 0 || !routes.latest) {
        return null;
    }
    const latest = executionRouteBadgeModel(routes.latest);
    const highlights: string[] = [latest.label];
    if (routes.byMode.ensemble > 0) {
        highlights.push(`${routes.byMode.ensemble} ensemble`);
    }
    if (routes.byMode.fanout > 0) {
        highlights.push(`${routes.byMode.fanout} fanout`);
    }
    return highlights.join(" · ");
}

/** Pure model for the Overview "Execution routing" card; null when no execution-route telemetry exists. */
export function routeCardModel(routes: ExecutionRouteMetrics): RouteCardModel | null {
    if (routes.total === 0 || !routes.latest) {
        return null;
    }
    const orderedModes: ExecutionMode[] = ["ensemble", "fanout", "agent", "single"];
    const modeCounts: RouteModeCount[] = orderedModes
        .filter((mode) => routes.byMode[mode] > 0)
        .map((mode) => ({ mode, label: MODE_LABELS[mode], count: routes.byMode[mode] }));

    const value = modeCounts.map((m) => `${m.label} ×${m.count}`).join(" · ");
    const subParts: string[] = [plural(routes.total, "routed turn")];
    if (routes.autoCount > 0) {
        subParts.push(`${routes.autoCount} auto`);
    }
    if (routes.manualCount > 0) {
        subParts.push(`${routes.manualCount} manual`);
    }
    const latestBadge = executionRouteBadgeModel(routes.latest);

    return {
        title: "Execution routing",
        value,
        sub: subParts.join(" · "),
        evidence: `producer-reported · execution_route / ensemble / fanout (${plural(routes.total, "turn")})`,
        synthetic: routes.synthetic,
        modeCounts,
        latestBadge,
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

/** Renders the Execution routing Overview card (empty array when no execution-route telemetry is present). */
export function renderRouteCards(routes: ExecutionRouteMetrics): HTMLElement[] {
    const model = routeCardModel(routes);
    if (!model) {
        return [];
    }
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
            h(
                "div",
                { class: "route-mode-pills", "aria-label": "Execution mode totals" },
                ...model.modeCounts.map((m) =>
                    h("span", { class: `route-badge route-mode-${m.mode}`, "data-route-count": m.mode, text: `${m.label} ×${m.count}` }),
                ),
            ),
            h(
                "div",
                { class: "route-latest" },
                h("span", { class: "route-latest-label", text: "Latest:" }),
                badgePill(model.latestBadge),
            ),
            h(
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
            ),
            h("div", { class: "evidence", text: model.evidence }),
        ),
    ];
}
