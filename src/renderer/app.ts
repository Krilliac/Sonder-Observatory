import fixtureText from "../../fixtures/synthetic-session.ndjson?raw";
import type { ComparePanel } from "../compare/panel";
import type { Inference3DPanel } from "../inference3d/inference3dPanel";
import { FindingsController, renderFindingsPanel, runDiagnostics } from "../diagnostics";
import { renderInspector } from "../inspector/inspector";
import { LiveConnectionManager, type ProducerConnection, type ProducerEndpointInput } from "../ingest/live/manager";
import type { TransportPreference } from "../ingest/live/endpoint";
import type { HealthBackend } from "../ingest/live/health";
import type { ObservatoryEvent } from "../protocol/events";
import { describeRange, isFullRange, type ExportRange } from "../export/filter";
import { EXPORT_FORMATS } from "../export/save";
import { EVENT_CLASSES, isErrorEvent, type EventClass } from "../query/classify";
import type { Metrics } from "../query/metrics";
import { metricsAt } from "../query/metricsIndex";
import { stripSeries } from "../query/series";
import { loadRecording, RECORDING_EXTENSION } from "../recording/sobs";
import { ReplayCursor } from "../replay/controller";
import { streamKey } from "../replay/order";
import { SessionStore } from "../replay/session";
import { TopologyPanel } from "../topology";
import { brandMark } from "./brand";
import { CHUNKED_LOAD_THRESHOLD_CHARS, loadRecordingChunked, loadRecordingStream, type ChunkedLoadOptions } from "./chunkedLoad";
import { ConnectionPanel } from "./connectionPanel";
import { byId, h } from "./dom";
import { mountDropZone, RECORDING_FILE_EXTENSIONS } from "./dropZone";
import { EventTable } from "./eventTable";
import { ExportDialog, type ExportChoice } from "./exportDialog";
import { fmtBytes, fmtMs, fmtPct, fmtRelNs } from "./format";
import { renderMetricStrip, stripItems } from "./metricStrip";
import { errorSearchStart, findMatching, producersInSession, syntheticBannerText, timelineSummaryText } from "./navigation";
import { Onboarding } from "./onboarding";
import type { ObservatoryPanel, PanelContext } from "./panels";
import { parseLaunchParams, redactUrlSecrets, secretParamWarning, urlWithoutSecrets } from "./params";
import { producerCardModel, ProducersPanel } from "./producersPanel";
import { promptCacheCardModel, speculationCardModel, type ReuseCardModel } from "./reuseCards";
import { readShortcutsEnabled, ShortcutsDialog, shortcutAction, writeShortcutsEnabled, type ShortcutAction } from "./shortcuts";
import { mountSplitter } from "./splitter";
import { safeStorage, type ThemeController } from "./theme";
import { getEventIndex, TRACKS } from "./timelineModel";
import { TimelineView } from "./timelineView";
import { tokenCardModel } from "./tokenCard";

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
/** Main views, shown as tabs; the inspector is docked beside every view. */
const VIEWS = [
    { id: "overview", title: "Overview" },
    { id: "events", title: "Events" },
    { id: "3d", title: "3D Inference" },
    { id: "diagnostics", title: "Diagnostics" },
    { id: "agents", title: "Agents" },
    { id: "compare", title: "Compare" },
] as const;
type ViewId = (typeof VIEWS)[number]["id"];

const SIDEBAR_STORAGE_KEY = "sonder-observatory.sidebar";
/** Below this width the layout stacks and the sidebar starts collapsed. */
const NARROW_QUERY = "(max-width: 900px)";
const FIXTURE_LABEL = "synthetic fixture (fixtures/synthetic-session.ndjson)";

type LoadedRecording = ReturnType<typeof loadRecording>;

interface RememberedInput {
    url: string;
    transport: TransportPreference;
    label?: string;
}

export interface AppOptions {
    theme?: ThemeController;
    /** Per-viewer conveniences (recent endpoints, sidebar, splitter); null disables them. */
    storage?: Storage | null;
}

const classCountCache = new WeakMap<readonly ObservatoryEvent[], number[]>();

function classCounts(events: readonly ObservatoryEvent[]): number[] {
    const cached = classCountCache.get(events);
    if (cached) {
        return cached;
    }
    const counts = new Array<number>(TRACKS.length).fill(0);
    for (const c of getEventIndex(events).cls) {
        counts[c] = (counts[c] ?? 0) + 1;
    }
    classCountCache.set(events, counts);
    return counts;
}

export class ObservatoryApp {
    private readonly root: HTMLElement;
    private readonly store = new SessionStore();
    private cursor = new ReplayCursor([]);
    private cursorSource: readonly ObservatoryEvent[] = this.cursor.events;
    private readonly storage: Storage | null;
    private readonly theme: ThemeController | null;
    /** Live producers (src/ingest/live/manager.ts). */
    private readonly manager: LiveConnectionManager;
    private connections: ProducerConnection[] = [];
    /** Producers the user disconnected: kept as cards with their final counters. */
    private readonly closed = new Map<string, ProducerConnection>();
    /** URL/transport/label per connection id (never the token), for Reconnect and Edit. */
    private readonly inputs = new Map<string, RememberedInput>();
    /** Messages shown in #warnings until the next load or connect. */
    private notices: string[] = [];
    /**
     * Launch-time warnings (ignored token URL parameters, contract 8.2). They
     * stay for the life of the page: the ?connect= producers added right after
     * launch clear `notices`, and the warning must still be seen.
     */
    private readonly launchNotices: string[] = [];
    /** Result of the last error jump ("no later error"), cleared by the next selection. */
    private navNotice: string | null = null;
    private follow = true;
    private playing = false;
    private speed = 1;
    private lastFrame = 0;
    private selectedId: string | null = null;
    private filterText = "";
    private filterClass: EventClass | "all" = "all";
    private renderQueued = false;
    private readonly panels: ObservatoryPanel[];
    private view: ViewId = "overview";
    /** Event ids highlighted in timeline/table (diagnostics or topology evidence). */
    private highlighted = new Set<string>();
    private readonly diag: FindingsController;
    private findingsDirty = true;
    private findingsVersion = 0;
    private diagStamp = "";
    private inspectorStamp = "";
    private warningsText = "";
    private summaryText = "";
    private readonly topology: TopologyPanel;
    private topologyDirty = true;
    private timelineView: TimelineView | null = null;
    private eventTable: EventTable | null = null;
    private connectionPanel: ConnectionPanel | null = null;
    private producersPanel: ProducersPanel | null = null;
    private onboarding: Onboarding | null = null;
    private shortcuts: ShortcutsDialog | null = null;
    private exportDialog: ExportDialog | null = null;
    /**
     * Session comparison tab (src/compare); the current session feeds it,
     * throttled while live. Loaded on first use (it and src/export are split
     * out of the main bundle).
     */
    private compare: ComparePanel | null = null;
    private compareLoading = false;
    /** 3D Inference tab (src/inference3d, with three.js): its own lazy chunk, loaded on first use. */
    private inference3d: Inference3DPanel | null = null;
    private inference3dLoading = false;
    private stripStamp = "";
    /** Last export result or failure, shown in #warnings until the next load. */
    private exportNotice: string | null = null;
    /** Bumped per load so a superseded chunked load is discarded. */
    private loadToken = 0;
    /** Aborts the running chunked/streamed parse when a newer load or connect wins. */
    private loadAbort: AbortController | null = null;
    private loading: string | null = null;

    constructor(root: HTMLElement, panels: readonly ObservatoryPanel[] = [], options: AppOptions = {}) {
        this.root = root;
        this.panels = [...panels];
        this.theme = options.theme ?? null;
        this.storage = options.storage !== undefined ? options.storage : safeStorage();
        this.manager = new LiveConnectionManager(this.store, {
            onAppend: () => {
                this.rebuildCursor();
                this.queueRender();
            },
        });
        this.diag = new FindingsController({
            highlightEvents: (ids) => {
                this.highlighted = new Set(ids);
            },
            selectEvent: (id) => {
                const event = this.store.events.find((e) => e.event_id === id);
                if (event) {
                    this.setFollow(false);
                    this.cursor.seek(this.cursor.relativeTime(event));
                    this.selectedId = event.event_id;
                }
            },
        });
        this.topology = new TopologyPanel({
            onSelectEvent: (event) => this.seekTo(event),
            onSelectionChange: (_selection, evidenceEventIds) => {
                this.highlighted = new Set(evidenceEventIds);
                this.render();
            },
            relativeTime: (event) => fmtRelNs(this.cursor.relativeTime(event)),
        });
    }

    start(search: URLSearchParams): void {
        const params = parseLaunchParams(search);
        const secretWarning = secretParamWarning(params.ignoredSecrets, params.ignoredConnectSecrets);
        if (secretWarning) {
            this.launchNotices.push(secretWarning);
            const clean = urlWithoutSecrets(window.location.href);
            if (clean) {
                window.history.replaceState(window.history.state, "", clean);
            }
        }
        this.connectionPanel = new ConnectionPanel(this.storage, { onConnect: (input) => this.addProducer(input) }, params.connect[0] ?? "");
        this.producersPanel = new ProducersPanel({
            onDisconnect: (id) => void this.disconnectProducer(id),
            onReconnect: (id) => this.reconnectProducer(id),
            onEdit: (id) => this.editProducer(id),
            onRemove: (id) => void this.removeProducer(id),
        });
        this.onboarding = new Onboarding({
            onConnect: (url) => this.addProducer({ url }),
            onOpenRecording: () => byId("file-open").click(),
            onLoadDemo: () => this.loadFixture(),
            onShowSources: () => this.showSources(),
        });
        this.root.replaceChildren(this.layout());
        this.shortcuts = new ShortcutsDialog(document, {
            enabled: readShortcutsEnabled(this.storage),
            onToggle: (enabled) => writeShortcutsEnabled(this.storage, enabled),
        });
        this.exportDialog = new ExportDialog(document, { onExport: (choice) => void this.exportAs(choice) });
        byId("view-agents").append(this.topology.element);
        this.timelineView = new TimelineView(byId("timeline"), ({ rel, event }) => {
            this.setFollow(false);
            this.cursor.seek(event ? this.cursor.relativeTime(event) : rel);
            this.selectedId = event ? event.event_id : this.selectedId;
            this.render();
        });
        this.eventTable = new EventTable(byId("table-wrap"), (e) => this.select(e));
        const view = VIEWS.find((v) => v.id === params.view);
        if (view) {
            this.view = view.id;
        }
        mountSplitter(byId("split"), byId("split-handle"), this.storage);
        this.bindControls();
        this.theme?.bindToggle(byId<HTMLButtonElement>("theme-toggle"));
        this.theme?.onChange(() => {
            this.timelineView?.invalidatePalette();
            this.inference3d?.invalidatePalette();
            this.render();
        });
        this.manager.subscribe((connections) => {
            this.connections = [...connections];
            this.queueRender();
        });
        mountDropZone(window, document, {
            onFile: (file) => this.openFile(file),
            onReject: (message) => {
                this.notices = [message];
                this.render();
            },
        });
        window.addEventListener("resize", () => this.queueRender());
        if (params.connect.length > 0) {
            this.connectProducers(params.connect.map((url) => ({ url })));
        } else if (params.fixture) {
            this.loadText(fixtureText, "fixture", FIXTURE_LABEL);
        }
        this.render();
    }

    /** Loads recording text as a file source (desktop native open and recent menu). */
    openRecordingText(text: string, label: string): void {
        this.afterLiveStopped(() => this.loadText(text, "file", label));
    }

    /** Streams a large recording (desktop native open): no whole-file string. */
    openRecordingStream(stream: ReadableStream<Uint8Array>, label: string): void {
        this.afterLiveStopped(() => this.loadChunked((opts) => loadRecordingStream(stream, opts), "file", label));
    }

    /** Connects to one live endpoint (older desktop shells: `--connect` without tokens). */
    connectLive(url: string): void {
        this.addProducer({ url });
    }

    /** Connects every producer (desktop `--connect` list with per-URL tokens, `?connect=`). */
    connectProducers(inputs: readonly ProducerEndpointInput[]): void {
        for (const input of inputs) {
            this.addProducer(input);
        }
    }

    // ---------------------------------------------------------------- layout

    private layout(): HTMLElement {
        const narrow = window.matchMedia?.(NARROW_QUERY).matches ?? false;
        let sidebarOpen = !narrow;
        try {
            const stored = this.storage?.getItem(SIDEBAR_STORAGE_KEY);
            if (stored === "open" || stored === "closed") {
                sidebarOpen = stored === "open";
            }
        } catch {
            // Storage unavailable: use the width-based default.
        }
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
                    h("button", { id: "export-btn", type: "button", "aria-haspopup": "dialog", text: "Export…", title: "Export a report, summary, JSON or recording range" }),
                    h("button", { id: "theme-toggle", type: "button", class: "toggle", text: "Theme" }),
                    h("button", { id: "shortcuts-btn", type: "button", class: "toggle", "aria-haspopup": "dialog", text: "Shortcuts", title: "Keyboard shortcuts (?)" }),
                ),
            ),
            h(
                "div",
                { class: "notices" },
                h("div", { id: "synthetic-banner", class: "banner", hidden: true, role: "note" }),
                h("div", { id: "warnings", class: "warnings", role: "status", "aria-live": "polite" }),
                h(
                    "div",
                    { id: "load-status", class: "load-status", hidden: true },
                    h("span", { id: "load-label" }),
                    h("div", { id: "load-progress", class: "progress", role: "progressbar", "aria-label": "Loading recording", "aria-valuemin": 0, "aria-valuemax": 100 }, h("div", { class: "progress-bar" })),
                    h("button", { id: "load-cancel", type: "button", class: "small", text: "Cancel loading" }),
                ),
            ),
            h(
                "div",
                { class: "workspace" },
                h("aside", { id: "sidebar", class: "sidebar", "aria-label": "Producers and sources" }, this.producersPanel!.element, this.connectionPanel!.element),
                h(
                    "main",
                    { id: "main", class: "main" },
                    this.onboarding!.element,
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
                                        h("div", { class: "panel-head" }, h("h2", { id: "timeline-title", text: "Timeline" }), this.timelineLegend()),
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
                                    ...this.panels.map((p) =>
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

    private timelineLegend(): HTMLElement {
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

    private bindControls(): void {
        byId<HTMLButtonElement>("sidebar-toggle").addEventListener("click", () => this.setSidebar(byId("shell").classList.contains("sidebar-collapsed")));
        byId<HTMLInputElement>("file-input").addEventListener("change", (ev) => {
            const input = ev.target as HTMLInputElement;
            const file = input.files?.[0];
            if (file) {
                this.openFile(file);
            }
            input.value = "";
        });
        byId<HTMLButtonElement>("fixture-btn").addEventListener("click", () => this.loadFixture());
        byId<HTMLButtonElement>("save-btn").addEventListener("click", () => this.saveRecording());
        byId<HTMLButtonElement>("export-btn").addEventListener("click", () => this.exportDialog?.open(this.viewRangeText()));
        byId<HTMLButtonElement>("shortcuts-btn").addEventListener("click", () => this.shortcuts?.open());
        byId<HTMLButtonElement>("load-cancel").addEventListener("click", () => this.cancelLoad());
        byId<HTMLButtonElement>("play-btn").addEventListener("click", () => this.togglePlay());
        byId<HTMLSelectElement>("speed-select").addEventListener("change", (ev) => {
            this.speed = Number((ev.target as HTMLSelectElement).value);
        });
        byId<HTMLButtonElement>("next-error-btn").addEventListener("click", () => this.jumpToError(1));
        byId<HTMLButtonElement>("prev-error-btn").addEventListener("click", () => this.jumpToError(-1));
        byId<HTMLInputElement>("follow-check").addEventListener("change", (ev) => {
            this.setFollow((ev.target as HTMLInputElement).checked);
            if (this.follow) {
                this.cursor.seek(this.cursor.durationNs);
            }
            this.render();
        });
        byId<HTMLInputElement>("scrubber").addEventListener("input", (ev) => {
            const v = Number((ev.target as HTMLInputElement).value);
            this.setFollow(v >= 1000);
            this.cursor.seek((v / 1000) * this.cursor.durationNs);
            this.render();
        });
        byId<HTMLInputElement>("filter-text").addEventListener("input", (ev) => {
            this.filterText = (ev.target as HTMLInputElement).value.trim().toLowerCase();
            this.render();
        });
        byId<HTMLSelectElement>("filter-class").addEventListener("change", (ev) => {
            this.filterClass = (ev.target as HTMLSelectElement).value as EventClass | "all";
            this.render();
        });
        byId<HTMLDivElement>("table-wrap").addEventListener("keydown", (ev) => this.onTableKey(ev));
        byId<HTMLDivElement>("timeline").addEventListener("keydown", (ev) => this.onTimelineKey(ev));
        VIEWS.forEach((v, i) => {
            const tab = byId<HTMLButtonElement>(`tab-${v.id}`);
            tab.addEventListener("click", () => this.setView(v.id));
            // WAI-ARIA tabs pattern (automatic activation): Left/Right wrap, Home/End jump.
            tab.addEventListener("keydown", (ev) => {
                const n = VIEWS.length;
                const target =
                    ev.key === "ArrowRight" ? (i + 1) % n : ev.key === "ArrowLeft" ? (i - 1 + n) % n : ev.key === "Home" ? 0 : ev.key === "End" ? n - 1 : -1;
                if (target < 0) {
                    return;
                }
                ev.preventDefault();
                this.setView(VIEWS[target]!.id);
                byId(`tab-${this.view}`).focus();
            });
        });
        document.addEventListener("keydown", (ev) => {
            if (!this.shortcuts?.enabled || document.querySelector("dialog[open]") || ev.defaultPrevented) {
                return;
            }
            const action = shortcutAction(ev);
            if (action) {
                ev.preventDefault();
                this.runShortcut(action);
            }
        });
    }

    // --------------------------------------------------------------- actions

    private runShortcut(action: ShortcutAction): void {
        switch (action) {
            case "help":
                this.shortcuts?.open();
                break;
            case "play-pause":
                this.togglePlay();
                break;
            case "next-event":
                this.stepEvent(1);
                break;
            case "previous-event":
                this.stepEvent(-1);
                break;
            case "next-error":
                this.jumpToError(1);
                break;
            case "previous-error":
                this.jumpToError(-1);
                break;
            case "focus-filter":
                this.setView("events");
                byId<HTMLInputElement>("filter-text").focus();
                break;
            case "follow-latest":
                this.setFollow(true);
                this.cursor.seek(this.cursor.durationNs);
                this.render();
                break;
            case "toggle-theme":
                this.theme?.toggle();
                break;
        }
    }

    private setView(view: ViewId): void {
        const changed = view !== this.view;
        this.view = view;
        this.render();
        if (changed && view === "events") {
            this.eventTable?.revealSelection();
        }
    }

    private setSidebar(open: boolean): void {
        byId("shell").classList.toggle("sidebar-collapsed", !open);
        byId("sidebar-toggle").setAttribute("aria-expanded", open ? "true" : "false");
        try {
            this.storage?.setItem(SIDEBAR_STORAGE_KEY, open ? "open" : "closed");
        } catch {
            // Not persisted.
        }
        this.queueRender();
    }

    private showSources(): void {
        this.setSidebar(true);
        this.connectionPanel?.focusUrl();
    }

    /** Adds a live producer; its events merge into the current live session. */
    private addProducer(input: ProducerEndpointInput): void {
        this.supersedeLoad();
        this.notices = [];
        if (this.store.source !== "live") {
            this.selectedId = null;
            this.setFollow(true);
        }
        const remembered: RememberedInput = { url: input.url, transport: input.transport ?? "auto", ...(input.label ? { label: input.label } : {}) };
        void this.manager.add(input).then((connection) => {
            this.inputs.set(connection.id, remembered);
            this.queueRender();
        });
        this.render();
    }

    private async disconnectProducer(id: string): Promise<void> {
        const connection = this.connections.find((c) => c.id === id);
        if (connection) {
            this.closed.set(id, { ...connection, status: { ...connection.status, state: "closed", retryInMs: null } });
        }
        await this.manager.remove(id);
        this.render();
    }

    private reconnectProducer(id: string): void {
        const connection = this.closed.get(id);
        this.closed.delete(id);
        if (!connection) {
            return;
        }
        const input = this.inputs.get(id) ?? { url: connection.url, transport: "auto" as const };
        this.addProducer({ url: input.url, transport: input.transport, ...(connection.label ? { label: connection.label } : {}) });
    }

    private editProducer(id: string): void {
        const connection = this.closed.get(id) ?? this.connections.find((c) => c.id === id);
        if (!connection) {
            return;
        }
        const input = this.inputs.get(id) ?? { url: connection.url, transport: "auto" as const };
        const needsToken = connection.hasToken || /token/i.test(connection.status.lastError ?? "");
        this.setSidebar(true);
        this.connectionPanel?.fill({ url: redactUrlSecrets(input.url), transport: input.transport }, needsToken ? "token" : "url");
        void this.removeProducer(id);
    }

    private async removeProducer(id: string): Promise<void> {
        if (this.closed.delete(id)) {
            this.render();
            return;
        }
        await this.manager.remove(id);
        this.render();
    }

    /** Runs `load` once every live stream has stopped and flushed (so none appends into the new source). */
    private afterLiveStopped(load: () => void): void {
        this.closed.clear();
        if (this.manager.list().length === 0) {
            load();
            return;
        }
        void this.manager.disconnectAll().then(load);
    }

    private loadFixture(): void {
        this.afterLiveStopped(() => this.loadText(fixtureText, "fixture", FIXTURE_LABEL));
    }

    private openFile(file: File): void {
        this.afterLiveStopped(() => {
            if (file.size >= CHUNKED_LOAD_THRESHOLD_CHARS) {
                // Stream large files: no giant string, UI stays responsive.
                this.loadChunked((opts) => loadRecordingStream(file.stream(), { ...opts, totalBytes: file.size }), "file", file.name);
                return;
            }
            const token = this.supersedeLoad();
            void file.text().then(
                (text) => {
                    if (token === this.loadToken) {
                        this.loadText(text, "file", file.name);
                    }
                },
                (error: unknown) => {
                    this.notices = [`could not read ${file.name}: ${(error as Error)?.message ?? String(error)}`];
                    this.render();
                },
            );
        });
    }

    private loadText(text: string, source: "fixture" | "file", label: string): void {
        if (text.length < CHUNKED_LOAD_THRESHOLD_CHARS) {
            this.supersedeLoad();
            this.applyLoaded(loadRecording(text), source, label);
            return;
        }
        this.loadChunked((opts) => loadRecordingChunked(text, opts), source, label);
    }

    /** Invalidates the running load (discard its result, abort its parse) and returns the new token. */
    private supersedeLoad(): number {
        this.loadAbort?.abort();
        this.loadAbort = null;
        this.setLoading(null);
        return ++this.loadToken;
    }

    private cancelLoad(): void {
        const label = this.loading;
        this.supersedeLoad();
        if (label) {
            this.notices = [`Loading ${label} was cancelled; the previous source is still shown.`];
        }
        this.render();
    }

    private setLoading(label: string | null, progress?: { pct: number | null; events: number }): void {
        this.loading = label;
        const box = document.getElementById("load-status");
        if (!box) {
            return;
        }
        box.hidden = label === null;
        if (label === null) {
            return;
        }
        const bar = byId("load-progress");
        const pct = progress?.pct ?? null;
        byId("load-label").textContent = `Loading ${label}${progress ? ` · ${progress.events} events` : ""}`;
        if (pct === null) {
            bar.removeAttribute("aria-valuenow");
            bar.setAttribute("aria-valuetext", progress ? `${progress.events} events read` : "starting");
            bar.classList.add("indeterminate");
        } else {
            bar.setAttribute("aria-valuenow", String(pct));
            bar.setAttribute("aria-valuetext", `${pct}%, ${progress?.events ?? 0} events`);
            bar.classList.remove("indeterminate");
        }
        (bar.firstElementChild as HTMLElement).style.width = pct === null ? "" : `${pct}%`;
    }

    /** Large recordings parse in slices so the UI keeps painting; a newer load or connect wins. */
    private loadChunked(run: (options: ChunkedLoadOptions) => Promise<LoadedRecording>, source: "fixture" | "file", label: string): void {
        const token = this.supersedeLoad();
        const abort = new AbortController();
        this.loadAbort = abort;
        this.setLoading(label);
        run({
            signal: abort.signal,
            onProgress: (p) => {
                if (token === this.loadToken) {
                    this.setLoading(label, { pct: p.totalBytes > 0 ? Math.round((p.bytesDone / p.totalBytes) * 100) : null, events: p.events });
                }
            },
        }).then(
            (loaded) => {
                if (token === this.loadToken) {
                    this.loadAbort = null;
                    this.setLoading(null);
                    this.applyLoaded(loaded, source, label);
                }
            },
            (error: unknown) => {
                if (token === this.loadToken) {
                    this.loadAbort = null;
                    this.setLoading(null);
                    this.notices = [`failed to load ${label}: ${(error as Error)?.message ?? String(error)}`];
                    this.render();
                }
            },
        );
    }

    private applyLoaded(loaded: LoadedRecording, source: "fixture" | "file", label: string): void {
        this.notices = [];
        this.exportNotice = null;
        this.store.reset(source, label, loaded.manifest);
        // One append = one ordering pass; SessionStore no longer spreads into push().
        this.store.append(loaded.events);
        this.store.addRejected(loaded.rejected);
        this.rebuildCursor();
        this.selectedId = null;
        this.setFollow(true);
        this.render();
    }

    /**
     * Save writes the whole session as a recording through the same path as
     * Export (.sobs): sensitive sessions are confirmed first, and the desktop
     * shell shows its native save dialog.
     */
    private saveRecording(): void {
        void this.exportAs({ format: "sobs", scope: "session" });
    }

    /** The range "Current view" exports: the event-table filters up to the replay cursor. */
    private viewRange(): ExportRange {
        const last = this.cursor.visibleEvents().at(-1);
        return { cls: this.filterClass, text: this.filterText, toNs: last ? last.mono_ns : null };
    }

    private viewRangeText(): string {
        const shown = this.cursor.visibleCount();
        const all = this.cursor.events.length;
        const cursor = shown < all ? `events up to the replay cursor (${shown} of ${all})` : "all events (the cursor is at the end)";
        const filtered = this.filterClass !== "all" || this.filterText !== "";
        const filters = filtered ? `, filtered by ${describeRange({ cls: this.filterClass, text: this.filterText }, this.cursor.originNs)}` : "";
        return `As in the Events table: ${cursor}${filters}.`;
    }

    /** Runs an export through exportWithConfirmation (never exportSession directly). */
    private async exportAs(choice: ExportChoice): Promise<void> {
        const events = this.store.events;
        if (events.length === 0) {
            return;
        }
        const range: ExportRange = choice.scope === "view" ? this.viewRange() : {};
        const label = EXPORT_FORMATS[choice.format].label;
        try {
            const { confirmSensitiveExport, exportWithConfirmation } = await import("../export");
            const saved = await exportWithConfirmation(choice.format, { events, range: isFullRange(range) ? {} : range }, confirmSensitiveExport);
            this.exportNotice = saved ? `Exported ${label}: ${saved.name}` : `${label} export cancelled; nothing was written.`;
        } catch (error) {
            this.exportNotice = `${label} export failed: ${(error as Error)?.message ?? String(error)}`;
        }
        this.render();
    }

    /** Label of the current source for the Compare tab ("live: …", a file name or the fixture). */
    private describeSource(): string {
        const s = this.store;
        if (s.source === "live") {
            const urls = this.connections.map((c) => redactUrlSecrets(c.url));
            return `live: ${urls.join(", ") || "producers"}`;
        }
        return s.source === "none" ? "current session" : s.sourceLabel;
    }

    private rebuildCursor(): void {
        const previous = this.cursor.position;
        this.cursor = new ReplayCursor(this.store.events);
        this.cursorSource = this.store.events;
        this.cursor.seek(this.follow ? this.cursor.durationNs : previous);
        this.findingsDirty = true;
        this.topologyDirty = true;
    }

    private setFollow(follow: boolean): void {
        this.follow = follow;
        const check = document.getElementById("follow-check") as HTMLInputElement | null;
        if (check) {
            check.checked = follow;
        }
        if (follow && this.playing) {
            this.togglePlay();
        }
    }

    private togglePlay(): void {
        this.playing = !this.playing;
        if (this.playing) {
            this.follow = false;
            byId<HTMLInputElement>("follow-check").checked = false;
            if (this.cursor.atEnd) {
                this.cursor.seek(0);
            }
            this.lastFrame = performance.now();
            requestAnimationFrame((t) => this.tick(t));
        }
        this.render();
    }

    private tick(now: number): void {
        if (!this.playing) {
            return;
        }
        this.cursor.advance(now - this.lastFrame, this.speed);
        this.lastFrame = now;
        if (this.cursor.atEnd) {
            this.playing = false;
        }
        this.render();
        if (this.playing) {
            requestAnimationFrame((t) => this.tick(t));
        }
    }

    private select(event: ObservatoryEvent | undefined): void {
        this.selectedId = event?.event_id ?? null;
        this.navNotice = null;
        this.render();
    }

    /** Selects `event` and moves the replay cursor to it. */
    private seekTo(event: ObservatoryEvent): void {
        this.setFollow(false);
        this.cursor.seek(this.cursor.relativeTime(event));
        this.select(event);
    }

    /** J/K and timeline arrows: next/previous event in the (filtered) table order. */
    private stepEvent(delta: 1 | -1): void {
        this.syncCursor();
        this.renderTable();
        const next = this.eventTable?.step(this.selectedId, delta);
        if (next) {
            this.seekTo(next);
        }
    }

    private jumpToError(dir: 1 | -1): void {
        this.syncCursor();
        const events = this.cursor.events;
        const selectedIndex = this.selectedId ? events.findIndex((e) => e.event_id === this.selectedId) : -1;
        const index = findMatching(events, errorSearchStart(selectedIndex, this.cursor.visibleCount(), dir), dir, isErrorEvent);
        if (index >= 0) {
            this.seekTo(events[index]!);
        } else {
            this.navNotice = dir === 1 ? "No later error event." : "No earlier error event.";
            this.render();
        }
    }

    private onTableKey(ev: KeyboardEvent): void {
        if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") {
            return;
        }
        ev.preventDefault();
        const next = this.eventTable?.neighbor(this.selectedId, ev.key === "ArrowDown" ? 1 : -1);
        if (next) {
            this.select(next);
        }
    }

    private onTimelineKey(ev: KeyboardEvent): void {
        const events = this.cursor.events;
        if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
            ev.preventDefault();
            this.stepEvent(ev.key === "ArrowRight" ? 1 : -1);
        } else if (ev.key === "Home" && events.length > 0) {
            ev.preventDefault();
            this.seekTo(events[0]!);
        } else if (ev.key === "End" && events.length > 0) {
            ev.preventDefault();
            this.selectedId = events[events.length - 1]!.event_id;
            this.setFollow(true);
            this.cursor.seek(this.cursor.durationNs);
            this.render();
        }
    }

    // ------------------------------------------------------------- rendering

    private queueRender(): void {
        if (this.renderQueued) {
            return;
        }
        this.renderQueued = true;
        requestAnimationFrame(() => {
            this.renderQueued = false;
            this.render();
        });
    }

    /** The manager may reset the store (first producer over a recording) before any event arrives. */
    private syncCursor(): void {
        if (this.cursorSource !== this.store.events) {
            this.rebuildCursor();
        }
    }

    private render(): void {
        this.syncCursor();
        const visible = this.cursor.visibleEvents();
        // Equal to deriveMetrics(visible), from the incremental index.
        const metrics = this.cursor.metrics();
        this.renderHeader();
        this.renderSources();
        this.renderWarnings();
        this.renderStrip(visible, metrics);
        this.renderViews();
        if (this.view === "overview") {
            this.renderCards(metrics);
            this.renderTimeline(metrics);
        }
        this.renderReplay();
        this.renderTable();
        this.renderInspectorPanel();
        this.renderExtraPanels(visible);
    }

    private hasSource(): boolean {
        return this.store.source !== "none" || this.connections.length > 0 || this.closed.size > 0 || this.loading !== null;
    }

    private renderSources(): void {
        const models = [...this.connections.map((c) => producerCardModel(c)), ...[...this.closed.values()].map((c) => producerCardModel(c, true))].sort(
            (a, b) => Number(a.id.replace(/\D+/g, "")) - Number(b.id.replace(/\D+/g, "")),
        );
        this.producersPanel?.update(models);
        const empty = !this.hasSource();
        this.onboarding?.setVisible(empty);
        byId("analysis").hidden = empty;
    }

    private renderViews(): void {
        for (const v of VIEWS) {
            const active = v.id === this.view;
            const tab = byId<HTMLButtonElement>(`tab-${v.id}`);
            tab.setAttribute("aria-selected", active ? "true" : "false");
            // Roving tabindex: only the active tab is in the Tab sequence.
            tab.tabIndex = active ? 0 : -1;
            tab.classList.toggle("active", active);
            byId(`view-${v.id}`).hidden = !active;
        }
        byId("extra-panels").hidden = this.view !== "overview";
        this.renderDiagnostics();
        this.renderTopology();
        this.renderCompare();
        this.render3d();
    }

    /** Hidden tabs are not rendered; the panel throttles re-analysis of a growing live session. */
    private renderCompare(): void {
        const container = byId("view-compare");
        if (container.hidden) {
            return;
        }
        if (!this.compare) {
            if (!this.compareLoading) {
                this.compareLoading = true;
                container.replaceChildren(h("p", { class: "muted", text: "Loading Compare…" }));
                import("../compare/panel").then(
                    ({ ComparePanel }) => {
                        this.compare = new ComparePanel({ describeCurrent: () => this.describeSource() });
                        this.render();
                    },
                    (error: unknown) => {
                        this.compareLoading = false;
                        container.replaceChildren(h("p", { class: "warning", text: `Compare failed to load: ${(error as Error)?.message ?? String(error)}` }));
                    },
                );
            }
            return;
        }
        try {
            this.compare.render(container, this.panelContext(this.cursor.visibleEvents()));
        } catch (error) {
            container.replaceChildren(h("p", { class: "warning", text: `Compare failed: ${(error as Error).message}` }));
        }
    }

    /** Metric strip: redrawn only when the cursor or the session changes. */
    private renderStrip(visible: readonly ObservatoryEvent[], metrics: Metrics): void {
        const stamp = `${this.store.events.length}|${visible.length}|${this.cursor.originNs}`;
        if (stamp === this.stripStamp) {
            return;
        }
        this.stripStamp = stamp;
        renderMetricStrip(byId("metric-strip"), stripItems(metrics, stripSeries(visible, metrics)));
    }

    /** Health backends per producer instance (live connections that fetched their health link). */
    private healthByInstance(): { map: Map<string, readonly HealthBackend[]>; stamp: string } {
        const map = new Map<string, readonly HealthBackend[]>();
        for (const c of this.connections) {
            const instance = c.identity?.instance_id;
            if (instance && c.health) {
                map.set(instance, c.health.backends);
            }
        }
        return { map, stamp: [...map.entries()].map(([k, v]) => `${k}:${v.map((b) => `${b.name}=${b.capabilities.join("+")}`).join(",")}`).join(";") };
    }

    /** 3D Inference tab: loads its chunk (and three.js) on first use; hidden tabs stop rendering. */
    private render3d(): void {
        const container = byId("view-3d");
        if (container.hidden) {
            this.inference3d?.setActive(false);
            return;
        }
        if (!this.inference3d) {
            if (!this.inference3dLoading) {
                this.inference3dLoading = true;
                container.replaceChildren(h("p", { class: "muted", text: "Loading the 3D view…" }));
                import("../inference3d/inference3dPanel").then(
                    ({ Inference3DPanel }) => {
                        this.inference3d = new Inference3DPanel({
                            onInspect: (event) => this.select(event),
                            onEvidence: (ids) => {
                                this.highlighted = new Set(ids);
                            },
                        });
                        container.replaceChildren(this.inference3d.element);
                        this.render();
                    },
                    (error: unknown) => {
                        this.inference3dLoading = false;
                        container.replaceChildren(h("p", { class: "warning", text: `The 3D view failed to load: ${(error as Error)?.message ?? String(error)}` }));
                    },
                );
            }
            return;
        }
        this.inference3d.setActive(true);
        const health = this.healthByInstance();
        try {
            this.inference3d.update({
                all: this.store.events,
                visible: this.cursor.visibleEvents(),
                nowNs: this.cursor.events.length > 0 ? this.cursor.originNs + this.cursor.position : null,
                health: health.map,
                healthStamp: health.stamp,
                relativeTime: (ns) => fmtRelNs(ns - this.cursor.originNs),
            });
        } catch (error) {
            container.append(h("p", { class: "warning", text: `3D view failed: ${(error as Error).message}` }));
        }
    }

    private panelContext(visible: readonly ObservatoryEvent[]): PanelContext {
        return {
            visible,
            all: this.store.events,
            selectedId: this.selectedId,
            select: (e) => this.seekTo(e),
            synthetic: this.store.synthetic,
        };
    }

    /** Topology layout uses the whole session; the graph itself is derived at the replay cursor. */
    private renderTopology(): void {
        if (byId("view-agents").hidden) {
            return;
        }
        if (this.topologyDirty) {
            this.topologyDirty = false;
            this.topology.setEvents(this.store.events);
        }
        this.topology.setTime(this.follow ? null : this.cursor.originNs + this.cursor.position);
    }

    /** Findings are recomputed over the whole session when it changes (fine for M1-sized sessions). */
    private renderDiagnostics(): void {
        const container = byId("view-diagnostics");
        if (container.hidden) {
            return;
        }
        if (this.findingsDirty) {
            this.findingsDirty = false;
            this.findingsVersion += 1;
            this.diag.setFindings(runDiagnostics(this.store.events));
        }
        const stamp = `${this.findingsVersion}|${this.diag.selected()?.id ?? ""}|${this.store.synthetic}|${this.cursor.originNs}`;
        if (stamp === this.diagStamp) {
            return;
        }
        this.diagStamp = stamp;
        const hadFocus = container.contains(document.activeElement);
        const origin = this.cursor.originNs;
        container.replaceChildren(
            ...renderFindingsPanel(this.diag, {
                relativeTime: (ns) => fmtRelNs(ns - origin),
                onChange: () => this.render(),
                synthetic: this.store.synthetic,
            }),
        );
        if (hadFocus) {
            (container.querySelector<HTMLElement>(".diag-finding.selected") ?? container.querySelector<HTMLElement>(".diag-finding"))?.focus();
        }
    }

    private renderExtraPanels(visible: readonly ObservatoryEvent[]): void {
        if (this.view !== "overview") {
            return;
        }
        for (const panel of this.panels) {
            const container = document.getElementById(`panel-${panel.id}`);
            if (!container) {
                continue;
            }
            try {
                panel.render(container, this.panelContext(visible));
            } catch (error) {
                // A failing panel must not take down the rest of the viewer.
                container.replaceChildren(h("p", { class: "warning", text: `Panel "${panel.title}" failed: ${(error as Error).message}` }));
            }
        }
    }

    private liveSummary(): { label: string; tone: string } {
        if (this.connections.length === 0) {
            return this.closed.size > 0 ? { label: "disconnected", tone: "idle" } : { label: "not connected", tone: "idle" };
        }
        const counts = new Map<string, number>();
        for (const c of this.connections) {
            const word = producerCardModel(c).state;
            counts.set(word, (counts.get(word) ?? 0) + 1);
        }
        const label = [...counts.entries()].map(([word, n]) => `${n} ${word}`).join(" · ");
        const tone = counts.has("failed") ? "error" : counts.has("connecting") || counts.has("reconnecting") ? "warn" : "ok";
        return { label, tone };
    }

    private renderHeader(): void {
        const s = this.store;
        const liveCount = this.connections.length + this.closed.size;
        const sourceText =
            s.source === "none"
                ? liveCount > 0
                    ? "connecting…"
                    : "no data"
                : s.source === "live"
                  ? `live · ${liveCount} producer${liveCount === 1 ? "" : "s"}`
                  : `${s.source === "file" ? "recording" : "fixture"} · ${s.sourceLabel}`;
        byId("source-badge").textContent = sourceText;
        const producers = producersInSession(s.events);
        const syntheticNames = producers.filter((p) => p.synthetic).map((p) => p.name);
        const synthetic = s.manifest?.synthetic === true || syntheticNames.length > 0;
        byId("synthetic-badge").hidden = !synthetic;
        const banner = byId("synthetic-banner");
        banner.hidden = !synthetic;
        const bannerText = syntheticBannerText(syntheticNames);
        if (banner.textContent !== bannerText) {
            banner.textContent = bannerText;
        }
        byId("capture-badge").textContent = `text capture: ${s.capturePolicy}`;
        const status = byId("live-status");
        const live = this.liveSummary();
        status.textContent = `live: ${live.label}`;
        status.dataset.tone = live.tone;
        this.renderChips(live.tone);
        const save = byId<HTMLButtonElement>("save-btn");
        save.disabled = s.events.length === 0;
        byId<HTMLButtonElement>("export-btn").disabled = s.events.length === 0;
        save.textContent =
            s.source === "live"
                ? `Save live session (${s.events.length} events${s.droppedByRetention > 0 ? `, ${s.droppedByRetention} older dropped` : ""})`
                : `Save (${RECORDING_EXTENSION})`;
        byId<HTMLButtonElement>("play-btn").textContent = this.playing ? "Pause" : "Play";
    }

    /**
     * Header status chips (design board "Status indicators"): the connection
     * and whether the view follows live data or replays. Words carry the
     * state; the dot colour only repeats it.
     */
    private renderChips(liveTone: string): void {
        const conn = byId("conn-chip");
        const mode = byId("mode-chip");
        const n = this.connections.length;
        let connText = "";
        let connTone = "idle";
        if (n > 0) {
            connTone = liveTone === "ok" ? "ok" : liveTone;
            connText = liveTone === "ok" ? `Connected · ${n} producer${n === 1 ? "" : "s"}` : liveTone === "error" ? "Connection failed" : "Connecting";
        } else if (this.closed.size > 0) {
            connText = "Disconnected";
        } else if (this.store.source === "file" || this.store.source === "fixture") {
            connText = "Offline · recording";
        }
        let modeText = "";
        let modeTone = "idle";
        if (this.store.events.length > 0) {
            if (this.store.source === "live" && this.follow) {
                modeText = "Live";
                modeTone = "live";
            } else if (this.playing) {
                modeText = `Replaying · ${this.speed}×`;
                modeTone = "live";
            } else {
                modeText = this.follow ? "Replay · at end" : "Replay · paused at cursor";
            }
        }
        if (conn.textContent !== connText || conn.dataset.tone !== connTone) {
            conn.textContent = connText;
            conn.dataset.tone = connTone;
        }
        if (mode.textContent !== modeText || mode.dataset.tone !== modeTone) {
            mode.textContent = modeText;
            mode.dataset.tone = modeTone;
        }
    }

    /** #warnings is a polite live region: it is rewritten only when its text changes. */
    private renderWarnings(): void {
        const s = this.store;
        const items: string[] = [...this.launchNotices, ...this.notices, ...(this.navNotice ? [this.navNotice] : []), ...(this.exportNotice ? [this.exportNotice] : [])];
        const retention = s.retentionNotice;
        if (retention !== null) {
            items.push(retention);
        }
        if (s.rejectedCount > 0) {
            const first = s.rejected[0]!;
            items.push(`${s.rejectedCount} line(s) rejected by the schema validator (first: line ${first.line}: ${first.reason})`);
        }
        if (s.gaps.length > 0) {
            const missing = s.gaps.reduce((n, g) => n + (g.to - g.from + 1), 0);
            items.push(`${missing} sequence number(s) missing across ${s.gaps.length} gap(s): possible dropped telemetry`);
        }
        if (s.duplicates > 0) {
            items.push(`${s.duplicates} duplicate event id(s) ignored`);
        }
        if (s.manifest && !s.manifest.complete) {
            items.push("recording manifest marks this session as incomplete");
        }
        for (const c of this.connections) {
            if (c.status.warning) {
                items.push(`${c.identity?.name ?? c.url}: ${c.status.warning}`);
            }
        }
        const text = items.join("\n");
        if (text === this.warningsText) {
            return;
        }
        this.warningsText = text;
        byId("warnings").replaceChildren(...items.map((t) => h("div", { class: "warning", text: `⚠ ${t}` })));
    }

    private renderCards(m: Metrics): void {
        const res = m.resources;
        const card = (title: string, value: string, sub: string, evidence: string, tone = "", extra: Node | null = null) =>
            h(
                "article",
                { class: `card ${tone}` },
                h("h3", { text: title }),
                h("div", { class: "value", text: value }),
                h("div", { class: "sub", text: sub }),
                extra,
                h("div", { class: "evidence", text: evidence }),
            );
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
                          h("li", { "data-producer": name }, h("span", { class: "producer-cell", text: name }), ` p50 ${fmtMs(stats.p50Ms)} · p95 ${fmtMs(stats.p95Ms)} · ${stats.count} req`),
                      ),
                  )
                : null;
        // Present only when a request reported them, so other streams render as before.
        const reuseCard = (model: ReuseCardModel | null) =>
            model
                ? card(
                      model.title,
                      model.value,
                      model.sub,
                      model.evidence,
                      "",
                      model.rows.length > 0
                          ? h(
                                "ul",
                                { class: "per-producer", "aria-label": `${model.title} per model` },
                                ...model.rows.map(([name, text]) => h("li", { "data-model": name }, h("span", { class: "producer-cell", text: name }), ` ${text}`)),
                            )
                          : null,
                  )
                : null;
        const reuseCards = [reuseCard(promptCacheCardModel(m)), reuseCard(speculationCardModel(m))].filter((c): c is HTMLElement => c !== null);
        byId("cards").replaceChildren(
            card(
                "Request latency",
                `p50 ${fmtMs(m.requestLatency.p50Ms)}`,
                `p95 ${fmtMs(m.requestLatency.p95Ms)} · max ${fmtMs(m.requestLatency.maxMs)} · open ${m.requests.filter((r) => r.outcome === "open").length}`,
                derived(m.requestLatency.count, "finished requests (request.started → end)"),
                "",
                producerRows,
            ),
            card(
                "Time to first token",
                `p50 ${fmtMs(m.timeToFirstToken.p50Ms)}`,
                `p95 ${fmtMs(m.timeToFirstToken.p95Ms)}`,
                derived(m.timeToFirstToken.count, "requests with a first token"),
            ),
            card("Token rate", tokenCard.value, tokenCard.sub, tokenCard.evidence),
            ...reuseCards,
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
                `dropped (producer-reported) ${m.droppedEvents} · rejected ${this.store.rejectedCount}${this.store.droppedByRetention > 0 ? ` · ${this.store.droppedByRetention} older not retained` : ""}`,
                "measured · events received at the cursor",
                m.droppedEvents > 0 ? "tone-warning" : "",
            ),
        );
    }

    private renderTimeline(m: Metrics): void {
        // Canvas + level-of-detail buckets (timelineView.ts); cost is bounded by
        // the plot width, not the event count, and scrubbing reuses the buckets.
        this.timelineView?.render({
            events: this.cursor.events,
            cursorRel: this.cursor.position,
            requests: m.requests,
            selectedId: this.selectedId,
            highlighted: this.highlighted,
        });
        const events = this.cursor.events;
        const counts = classCounts(events);
        const selected = this.selectedId ? events.find((e) => e.event_id === this.selectedId) : undefined;
        const text = timelineSummaryText({
            total: events.length,
            visible: this.cursor.visibleCount(),
            cursorSeconds: this.cursor.position / 1e9,
            durationSeconds: this.cursor.durationNs / 1e9,
            classCounts: TRACKS.map((c, i) => [c, counts[i] ?? 0] as const),
            errors: counts[TRACKS.indexOf("error")] ?? 0,
            requests: m.requests.length,
            selected: selected ? { eventType: selected.event_type, producer: selected.producer.name, seconds: this.cursor.relativeTime(selected) / 1e9 } : null,
        });
        if (text !== this.summaryText) {
            this.summaryText = text;
            byId("timeline-summary").textContent = text;
        }
    }

    private renderReplay(): void {
        const cursorRel = this.cursor.position;
        const scrubber = byId<HTMLInputElement>("scrubber");
        scrubber.value = String(this.cursor.durationNs > 0 ? Math.round((cursorRel / this.cursor.durationNs) * 1000) : 1000);
        byId("cursor-label").textContent = `${fmtRelNs(cursorRel)} / ${fmtRelNs(this.cursor.durationNs)} · ${this.cursor.visibleCount()}/${this.cursor.events.length} events`;
    }

    private renderTable(): void {
        // Virtualized: every filtered event at the cursor is reachable, only the
        // rows in the viewport are in the DOM (eventTable.ts).
        if (!this.eventTable) {
            return;
        }
        const counts = this.eventTable.update({
            events: this.cursor.events,
            visibleCount: this.cursor.visibleCount(),
            filterClass: this.filterClass,
            filterText: this.filterText,
            selectedId: this.selectedId,
            highlighted: this.highlighted,
            follow: this.follow,
            originNs: this.cursor.originNs,
        });
        byId("table-count").textContent = `${counts.shown} shown · ${counts.atCursor} at cursor`;
    }

    /** Rebuilt only when the selection or the session changes, so its buttons keep focus. */
    private renderInspectorPanel(): void {
        const stamp = `${this.selectedId ?? ""}|${this.store.events.length}|${this.cursor.originNs}|${this.store.source}`;
        if (stamp === this.inspectorStamp) {
            return;
        }
        this.inspectorStamp = stamp;
        const panel = byId("inspector");
        const selected = this.selectedId ? this.store.events.find((e) => e.event_id === this.selectedId) : undefined;
        panel.replaceChildren(
            ...renderInspector(selected, this.store.events, {
                relativeTime: (e) => fmtRelNs(this.cursor.relativeTime(e)),
                onSelect: (e) => this.seekTo(e),
                onClose: () => this.select(undefined),
                requestSpan: (e) => {
                    const key = streamKey(e);
                    return metricsAt(this.cursor.events).requests.find((r) => r.requestId === e.request_id && r.streamKey === key);
                },
            }),
        );
    }
}
