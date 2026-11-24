/**
 * Top-level DOM shell construction, view tab definitions, and sidebar
 * persistence for ObservatoryApp.
 */
import { EVENT_CLASSES } from "../query/classify";
import { RECORDING_EXTENSION } from "../recording/sobs";
import { brandMark } from "./brand";
import { h } from "./dom";
import { RECORDING_FILE_EXTENSIONS } from "./dropZone";
import type { ObservatoryPanel } from "./panels";
import { TRACKS } from "./timelineModel";

export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const;

/** Main views, shown as tabs; the inspector is docked beside every view. */
export const VIEWS = [
    { id: "overview", title: "Overview" },
    { id: "events", title: "Events" },
    { id: "3d", title: "3D Inference" },
    { id: "diagnostics", title: "Diagnostics" },
    { id: "agents", title: "Agents" },
    { id: "compare", title: "Compare" },
] as const;

export type ViewId = (typeof VIEWS)[number]["id"];

export const SIDEBAR_STORAGE_KEY = "sonder-observatory.sidebar";
/** Below this width the layout stacks and the sidebar starts collapsed. */
export const NARROW_QUERY = "(max-width: 900px)";
export const FIXTURE_LABEL = "synthetic fixture (fixtures/synthetic-session.ndjson)";

export function readInitialSidebarOpen(storage: Storage | null): boolean {
    const narrow = window.matchMedia?.(NARROW_QUERY).matches ?? false;
    let sidebarOpen = !narrow;
    try {
        const stored = storage?.getItem(SIDEBAR_STORAGE_KEY);
        if (stored === "open" || stored === "closed") {
            sidebarOpen = stored === "open";
        }
    } catch {
        // Storage unavailable: use the width-based default.
    }
    return sidebarOpen;
}

export function persistSidebarOpen(storage: Storage | null, open: boolean): void {
    try {
        storage?.setItem(SIDEBAR_STORAGE_KEY, open ? "open" : "closed");
    } catch {
        // Not persisted.
    }
}

function timelineLegend(): HTMLElement {
    const item = (cls: string, text: string) => h("li", {}, h("span", { class: `swatch ${cls}`, "aria-hidden": "true" }), text);
    return h(
        "ul",
        { id: "timeline-legend", class: "legend", "aria-label": "Timeline legend" },
        ...TRACKS.map((c) => item(`dot cls-${c}`, c)),
        item("span-swatch", "request span"),
        item("span-swatch failed", "failed request"),
        item("span-swatch open", "open request"),
        item("mark-swatch selected", "selected"),
        item("mark-swatch evidence", "evidence"),
        item("cursor-swatch", "cursor"),
    );
}

export interface AppLayoutDeps {
    sidebarOpen: boolean;
    producersElement: HTMLElement;
    connectionElement: HTMLElement;
    onboardingElement: HTMLElement;
    panels: readonly ObservatoryPanel[];
}

export function buildAppLayout(deps: AppLayoutDeps): HTMLElement {
    const { sidebarOpen, producersElement, connectionElement, onboardingElement, panels } = deps;
    const timeline = h("div", {
        id: "timeline",
        class: "timeline",
        tabindex: 0,
        role: "group",
        "aria-label": "Timeline. Left and Right step to the previous or next event, Home and End jump to the first or last.",
        "aria-describedby": "timeline-summary",
    });
    return h(
        "div",
        { class: `shell${sidebarOpen ? "" : " sidebar-collapsed"}`, id: "shell" },
        h(
            "header",
            { class: "topbar" },
            h("div", { class: "brand" }, brandMark(document), h("h1", { text: "Sonder Observatory" })),
            h("button", {
                id: "sidebar-toggle",
                type: "button",
                class: "toggle",
                "aria-expanded": sidebarOpen ? "true" : "false",
                "aria-controls": "sidebar",
                text: "Sources",
            }),
            h(
                "div",
                { class: "badges" },
                h("span", { id: "conn-chip", class: "chip", "data-tone": "idle" }),
                h("span", { id: "mode-chip", class: "chip", "data-tone": "idle" }),
                h("span", { id: "source-badge", class: "badge" }),
                h("span", { id: "synthetic-badge", class: "badge badge-synthetic", hidden: true, text: "SYNTHETIC DATA" }),
                h("span", { id: "capture-badge", class: "badge" }),
                h("span", { id: "live-status", class: "badge conn", role: "status", "data-tone": "idle" }),
            ),
            h(
                "div",
                { class: "actions" },
                // The input comes first so CSS can show its keyboard focus on the visible label.
                h("input", { id: "file-input", type: "file", accept: RECORDING_FILE_EXTENSIONS.join(","), class: "sr-only" }),
                h("label", { id: "file-open", class: "button-like", for: "file-input", text: "Open recording…" }),
                h("button", { id: "fixture-btn", type: "button", text: "Synthetic demo" }),
                h("button", { id: "save-btn", type: "button", text: `Save (${RECORDING_EXTENSION})` }),
                h("button", {
                    id: "export-btn",
                    type: "button",
                    "aria-haspopup": "dialog",
                    text: "Export…",
                    title: "Export a report, summary, JSON or recording range",
                }),
                h("button", { id: "theme-toggle", type: "button", class: "toggle", text: "Theme" }),
                h("button", { id: "shortcuts-btn", type: "button", class: "toggle", "aria-haspopup": "dialog", text: "Shortcuts", title: "Keyboard shortcuts (?)" }),
            ),
        ),
        h(
            "div",
            { class: "notices" },
            h("div", { id: "connect-confirm", class: "banner connect-confirm", hidden: true, role: "region", "aria-label": "Confirm requested live connections" }),
            h("div", { id: "synthetic-banner", class: "banner", hidden: true, role: "note" }),
            h("div", { id: "warnings", class: "warnings", role: "status", "aria-live": "polite" }),
            h(
                "div",
                { id: "load-status", class: "load-status", hidden: true },
                h("span", { id: "load-label" }),
                h(
                    "div",
                    { id: "load-progress", class: "progress", role: "progressbar", "aria-label": "Loading recording", "aria-valuemin": 0, "aria-valuemax": 100 },
                    h("div", { class: "progress-bar" }),
                ),
                h("button", { id: "load-cancel", type: "button", class: "small", text: "Cancel loading" }),
            ),
        ),
        h(
            "div",
            { class: "workspace" },
            h("aside", { id: "sidebar", class: "sidebar", "aria-label": "Producers and sources" }, producersElement, connectionElement),
            h(
                "main",
                { id: "main", class: "main" },
                onboardingElement,
                h(
                    "div",
                    { id: "analysis", class: "analysis" },
                    h("section", { id: "metric-strip", class: "metric-strip", "aria-label": "Key metrics at the replay cursor" }),
                    h(
                        "div",
                        { class: "tabs", role: "tablist", "aria-label": "Views" },
                        ...VIEWS.map((v) =>
                            h("button", { id: `tab-${v.id}`, type: "button", role: "tab", class: "tab", "aria-controls": `view-${v.id}`, text: v.title }),
                        ),
                    ),
                    h(
                        "div",
                        { id: "replay-bar", class: "replay-bar", role: "group", "aria-label": "Replay controls" },
                        h(
                            "div",
                            { class: "replay-controls" },
                            h("button", { id: "play-btn", type: "button", text: "Play" }),
                            h("label", { for: "speed-select", text: "Speed" }),
                            h("select", { id: "speed-select" }, ...SPEEDS.map((s) => h("option", { value: s, selected: s === 1, text: `${s}×` }))),
                            h("button", { id: "prev-error-btn", type: "button", text: "Previous error" }),
                            h("button", { id: "next-error-btn", type: "button", text: "Next error" }),
                            h("label", { class: "check" }, h("input", { id: "follow-check", type: "checkbox", checked: true }), " Follow latest"),
                            h("span", { id: "cursor-label", class: "mono cursor-label" }),
                        ),
                        h("input", { id: "scrubber", type: "range", min: 0, max: 1000, value: 1000, step: 1, "aria-label": "Replay position" }),
                    ),
                    h(
                        "div",
                        { id: "split", class: "split" },
                        h(
                            "div",
                            { class: "split-main" },
                            h(
                                "div",
                                { id: "view-overview", class: "view view-overview", role: "tabpanel", "aria-labelledby": "tab-overview" },
                                h("section", { id: "cards", class: "cards", "aria-label": "Metrics" }),
                                h(
                                    "section",
                                    { class: "panel timeline-panel", "aria-labelledby": "timeline-title" },
                                    h("div", { class: "panel-head" }, h("h2", { id: "timeline-title", text: "Timeline" }), timelineLegend()),
                                    timeline,
                                    h("p", { id: "timeline-summary", class: "timeline-summary muted" }),
                                ),
                            ),
                            h(
                                "div",
                                { id: "view-events", class: "view view-events", role: "tabpanel", "aria-labelledby": "tab-events" },
                                h(
                                    "section",
                                    { class: "panel table-panel", "aria-labelledby": "events-title" },
                                    h(
                                        "div",
                                        { class: "panel-head" },
                                        h("h2", { id: "events-title", text: "Events" }),
                                        h(
                                            "div",
                                            { class: "filters" },
                                            h("input", {
                                                id: "filter-text",
                                                type: "search",
                                                placeholder: "type, id, request, run, agent, producer",
                                                "aria-label": "Filter events by type, id, request, run, agent or producer",
                                            }),
                                            h(
                                                "select",
                                                { id: "filter-class", "aria-label": "Event class" },
                                                h("option", { value: "all", text: "all classes" }),
                                                ...EVENT_CLASSES.map((c) => h("option", { value: c, text: c })),
                                            ),
                                            h("span", { id: "table-count", class: "muted" }),
                                        ),
                                    ),
                                    h("div", { id: "table-wrap", class: "table-wrap", tabindex: 0, role: "region", "aria-label": "Event table (Up and Down move the selection)" }),
                                ),
                            ),
                            h("div", { id: "view-3d", class: "view view-3d", role: "tabpanel", "aria-labelledby": "tab-3d" }),
                            h("div", { id: "view-diagnostics", class: "view", role: "tabpanel", "aria-labelledby": "tab-diagnostics" }),
                            h("div", { id: "view-agents", class: "view", role: "tabpanel", "aria-labelledby": "tab-agents" }),
                            h("div", { id: "view-compare", class: "view view-compare", role: "tabpanel", "aria-labelledby": "tab-compare" }),
                            h(
                                "div",
                                { id: "extra-panels", class: "extra-panels" },
                                ...panels.map((p) =>
                                    h(
                                        "section",
                                        { class: "panel", "aria-label": p.title },
                                        h("div", { class: "panel-head" }, h("h2", { text: p.title })),
                                        h("div", { id: `panel-${p.id}`, class: "panel-body" }),
                                    ),
                                ),
                            ),
                        ),
                        h("div", {
                            id: "split-handle",
                            class: "split-handle",
                            role: "separator",
                            tabindex: 0,
                            "aria-orientation": "vertical",
                            "aria-controls": "inspector",
                            "aria-label": "Resize the inspector",
                        }),
                        h("section", { id: "inspector", class: "panel inspector", "aria-label": "Inspector" }),
                    ),
                ),
            ),
        ),
    );
}
