import fixtureText from "../../fixtures/synthetic-session.ndjson?raw";
import { renderInspector } from "../inspector/inspector";
import type { ProducerEndpointInput } from "../ingest/live/manager";
import type { ObservatoryEvent } from "../protocol/events";
import { isErrorEvent, type EventClass } from "../query/classify";
import { executionRouteAt } from "../query/executionRouteIndex";
import type { Metrics } from "../query/metrics";
import { metricsAt } from "../query/metricsIndex";
import { prefillDecodeAt } from "../query/prefillDecodeIndex";
import { stripSeries } from "../query/series";
import { ReplayCursor } from "../replay/controller";
import { streamKey } from "../replay/order";
import { SessionStore } from "../replay/session";
import { bindAppControls, buildViewRange, executeConfirmedExport, formatViewRangeText } from "./appControls";
import { buildAppLayout, FIXTURE_LABEL, persistSidebarOpen, readInitialSidebarOpen, VIEWS, type ViewId } from "./appLayout";
import { ConnectionPanel } from "./connectionPanel";
import { byId } from "./dom";
import { EventTable } from "./eventTable";
import { ExportDialog, type ExportChoice } from "./exportDialog";
import { fmtRelNs } from "./format";
import { LiveController } from "./liveController";
import { renderMetricStrip, stripItems } from "./metricStrip";
import { errorSearchStart, findMatching, timelineSummaryText } from "./navigation";
import { Onboarding } from "./onboarding";
import { renderOverviewCards } from "./overviewCards";
import type { ObservatoryPanel } from "./panels";
import { parseLaunchParams, secretParamWarning, urlWithoutSecrets } from "./params";
import { ProducersPanel } from "./producersPanel";
import { RecordingLoader, type LoadedRecording } from "./recordingLoader";
import { readShortcutsEnabled, ShortcutsDialog, writeShortcutsEnabled } from "./shortcuts";
import { mountSplitter } from "./splitter";
import { renderHeaderStatus, renderWarningsRegion } from "./statusChrome";
import { safeStorage, type ThemeController } from "./theme";
import { getEventIndex, TRACKS } from "./timelineModel";
import { TimelineView } from "./timelineView";
import { ViewTabsController } from "./viewTabs";

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
    /** Live producers (src/ingest/live/manager.ts) and query-connect confirmation. */
    private readonly live: LiveController;
    /** Recording/fixture loading, chunked progress, cancel, and drop-zone wiring. */
    private readonly loader: RecordingLoader;
    /** Secondary view tabs (Diagnostics, Agents, Compare, 3D Inference) and extra panels. */
    private readonly viewTabs: ViewTabsController;
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
    private inspectorStamp = "";
    private warningsText = "";
    private summaryText = "";
    private timelineView: TimelineView | null = null;
    private eventTable: EventTable | null = null;
    private connectionPanel: ConnectionPanel | null = null;
    private producersPanel: ProducersPanel | null = null;
    private onboarding: Onboarding | null = null;
    private shortcuts: ShortcutsDialog | null = null;
    private exportDialog: ExportDialog | null = null;
    private stripStamp = "";
    /** Last export result or failure, shown in #warnings until the next load. */
    private exportNotice: string | null = null;

    constructor(root: HTMLElement, panels: readonly ObservatoryPanel[] = [], options: AppOptions = {}) {
        this.root = root;
        this.panels = [...panels];
        this.theme = options.theme ?? null;
        this.storage = options.storage !== undefined ? options.storage : safeStorage();
        this.live = new LiveController(this.store, {
            onAppend: () => {
                this.rebuildCursor();
                this.queueRender();
            },
            onBeforeAddProducer: () => {
                this.loader.supersede();
                this.notices = [];
                if (this.store.source !== "live") {
                    this.selectedId = null;
                    this.setFollow(true);
                }
            },
            onEditFill: (input, focus) => {
                this.setSidebar(true);
                this.connectionPanel?.fill(input, focus);
            },
            onRender: () => this.render(),
            onQueueRender: () => this.queueRender(),
        });
        this.loader = new RecordingLoader({
            afterLiveStopped: (load) => this.live.afterLiveStopped(load),
            onLoaded: (loaded, source, label) => this.applyLoaded(loaded, source, label),
            onNotice: (message) => {
                this.notices = [message];
                this.render();
            },
            onRender: () => this.render(),
        });
        this.viewTabs = new ViewTabsController(this.panels, {
            getStore: () => this.store,
            getCursor: () => this.cursor,
            getSelectedId: () => this.selectedId,
            isFollow: () => this.follow,
            describeSource: () => this.describeSource(),
            healthByInstance: () => this.live.healthByInstance(),
            setHighlighted: (ids) => {
                this.highlighted = new Set(ids);
            },
            selectEventById: (id) => {
                const event = this.store.events.find((e) => e.event_id === id);
                if (event) {
                    this.setFollow(false);
                    this.cursor.seek(this.cursor.relativeTime(event));
                    this.selectedId = event.event_id;
                }
            },
            selectEvent: (event) => this.select(event),
            seekTo: (event) => this.seekTo(event),
            onRender: () => this.render(),
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
        this.connectionPanel = new ConnectionPanel(this.storage, { onConnect: (input) => this.live.addProducer(input) }, params.connect[0] ?? "");
        this.producersPanel = new ProducersPanel({
            onDisconnect: (id) => void this.live.disconnectProducer(id),
            onReconnect: (id) => this.live.reconnectProducer(id),
            onEdit: (id) => this.live.editProducer(id),
            onRemove: (id) => void this.live.removeProducer(id),
        });
        this.onboarding = new Onboarding({
            onConnect: (url) => this.live.addProducer({ url }),
            onOpenRecording: () => byId("file-open").click(),
            onLoadDemo: () => this.loadFixture(),
            onShowSources: () => this.showSources(),
        });
        this.root.replaceChildren(
            buildAppLayout({
                sidebarOpen: readInitialSidebarOpen(this.storage),
                producersElement: this.producersPanel.element,
                connectionElement: this.connectionPanel.element,
                onboardingElement: this.onboarding.element,
                panels: this.panels,
            }),
        );
        this.shortcuts = new ShortcutsDialog(document, {
            enabled: readShortcutsEnabled(this.storage),
            onToggle: (enabled) => writeShortcutsEnabled(this.storage, enabled),
        });
        this.exportDialog = new ExportDialog(document, { onExport: (choice) => void this.exportAs(choice) });
        this.viewTabs.mountTopology();
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
            this.viewTabs.invalidatePalette();
            this.render();
        });
        this.live.subscribe();
        this.loader.mountDropTarget(window, document);
        window.addEventListener("resize", () => this.queueRender());
        if (params.autoConnect.length > 0) {
            this.connectProducers(params.autoConnect.map((url) => ({ url })));
        }
        if (params.pendingConnect.length > 0) {
            this.live.setPendingQueryConnects(params.pendingConnect);
        }
        if (params.connect.length === 0 && params.fixture) {
            this.loader.loadText(fixtureText, "fixture", FIXTURE_LABEL);
        }
        this.render();
    }

    /** Loads recording text as a file source (desktop native open and recent menu). */
    openRecordingText(text: string, label: string): void {
        this.loader.openTextAfterLive(text, "file", label);
    }

    /** Streams a large recording (desktop native open): no whole-file string. */
    openRecordingStream(stream: ReadableStream<Uint8Array>, label: string): void {
        this.loader.openStreamAfterLive(stream, label);
    }

    /** Connects to one live endpoint (older desktop shells: `--connect` without tokens). */
    connectLive(url: string): void {
        this.live.addProducer({ url });
    }

    /** Connects every producer (desktop `--connect` list with per-URL tokens, confirmed `?connect=`). */
    connectProducers(inputs: readonly ProducerEndpointInput[]): void {
        this.live.connectProducers(inputs);
    }

    // -------------------------------------------------------------- controls

    private bindControls(): void {
        bindAppControls({
            toggleSidebar: () => this.setSidebar(byId("shell").classList.contains("sidebar-collapsed")),
            openFile: (file) => this.loader.openFile(file),
            loadFixture: () => this.loadFixture(),
            saveRecording: () => this.saveRecording(),
            openExport: () => this.exportDialog?.open(formatViewRangeText(this.cursor, this.filterClass, this.filterText)),
            openShortcuts: () => this.shortcuts?.open(),
            cancelLoad: () => this.loader.cancel(),
            togglePlay: () => this.togglePlay(),
            setSpeed: (speed) => {
                this.speed = speed;
            },
            jumpToError: (dir) => this.jumpToError(dir),
            setFollowFromCheck: (checked) => {
                this.setFollow(checked);
                if (this.follow) {
                    this.cursor.seek(this.cursor.durationNs);
                }
                this.render();
            },
            scrubTo: (v) => {
                this.setFollow(v >= 1000);
                this.cursor.seek((v / 1000) * this.cursor.durationNs);
                this.render();
            },
            setFilterText: (text) => {
                this.filterText = text;
                this.render();
            },
            setFilterClass: (cls) => {
                this.filterClass = cls;
                this.render();
            },
            onTableKey: (ev) => this.onTableKey(ev),
            onTimelineKey: (ev) => this.onTimelineKey(ev),
            setView: (view) => this.setView(view),
            getView: () => this.view,
            isShortcutsEnabled: () => Boolean(this.shortcuts?.enabled),
            stepEvent: (delta) => this.stepEvent(delta),
            followLatest: () => {
                this.setFollow(true);
                this.cursor.seek(this.cursor.durationNs);
                this.render();
            },
            toggleTheme: () => this.theme?.toggle(),
        });
    }

    // --------------------------------------------------------------- actions

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
        persistSidebarOpen(this.storage, open);
        this.queueRender();
    }

    private showSources(): void {
        this.setSidebar(true);
        this.connectionPanel?.focusUrl();
    }

    private loadFixture(): void {
        this.loader.openTextAfterLive(fixtureText, "fixture", FIXTURE_LABEL);
    }

    private applyLoaded(loaded: LoadedRecording, source: "fixture" | "file", label: string): void {
        this.notices = [];
        this.exportNotice = null;
        this.store.reset(source, label, loaded.manifest, loaded.truncated ?? null);
        // One append = one ordering pass; SessionStore no longer spreads into push().
        this.store.append(loaded.events);
        this.store.addRejected(loaded.rejected);
        this.rebuildCursor();
        this.cursor.seek(this.cursor.durationNs);
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

    /** Runs an export through exportWithConfirmation (never exportSession directly). */
    private async exportAs(choice: ExportChoice): Promise<void> {
        const notice = await executeConfirmedExport(choice, this.store.events, () => buildViewRange(this.cursor, this.filterClass, this.filterText));
        if (notice !== null) {
            this.exportNotice = notice;
            this.render();
        }
    }

    /** Label of the current source for the Compare tab ("live: …", a file name or the fixture). */
    private describeSource(): string {
        const s = this.store;
        if (s.source === "live") {
            return this.live.describeLiveSource();
        }
        return s.source === "none" ? "current session" : s.sourceLabel;
    }

    private rebuildCursor(): void {
        const previous = this.cursor.position;
        this.cursor = new ReplayCursor(this.store.events);
        this.cursorSource = this.store.events;
        this.cursor.seek(this.follow ? this.cursor.durationNs : previous);
        this.viewTabs.markDataChanged();
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
        renderHeaderStatus({
            store: this.store,
            connections: this.live.connections,
            closedCount: this.live.closedCount,
            follow: this.follow,
            playing: this.playing,
            speed: this.speed,
        });
        this.renderSources();
        this.live.renderConnectConfirm();
        this.warningsText = renderWarningsRegion(
            {
                store: this.store,
                connections: this.live.connections,
                launchNotices: this.launchNotices,
                notices: this.notices,
                navNotice: this.navNotice,
                exportNotice: this.exportNotice,
            },
            this.warningsText,
        );
        this.renderStrip(visible, metrics);
        this.viewTabs.render(this.view, visible);
        if (this.view === "overview") {
            renderOverviewCards(metrics, this.cursor.events, this.cursor.visibleCount(), this.store);
            this.renderTimeline(metrics);
        }
        this.renderReplay();
        this.renderTable();
        this.renderInspectorPanel();
        this.viewTabs.renderExtraPanels(this.view, visible);
    }

    private hasSource(): boolean {
        return this.store.source !== "none" || this.live.hasAny() || this.loader.loading !== null;
    }

    private renderSources(): void {
        this.producersPanel?.update(this.live.producerCardModels());
        const empty = !this.hasSource();
        this.onboarding?.setVisible(empty);
        byId("analysis").hidden = empty;
    }

    /** Metric strip: redrawn only when the cursor or the session changes. */
    private renderStrip(visible: readonly ObservatoryEvent[], metrics: Metrics): void {
        const stamp = `${this.store.events.length}|${visible.length}|${this.cursor.originNs}`;
        if (stamp === this.stripStamp) {
            return;
        }
        this.stripStamp = stamp;
        const visibleCount = this.cursor.visibleCount();
        renderMetricStrip(
            byId("metric-strip"),
            stripItems(metrics, stripSeries(visible, metrics), {
                prefillDecode: prefillDecodeAt(this.cursor.events, visibleCount),
                routes: executionRouteAt(this.cursor.events, visibleCount),
            }),
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
                // Whole session, like the related events above (renderInspector gets
                // store.events): the panel is not rebuilt as the cursor moves, so a
                // cursor-prefix span would go stale. The index memoizes this count
                // next to the cursor's, so the two lookups do not evict each other.
                requestSpan: (e) => {
                    const key = streamKey(e);
                    return metricsAt(this.cursor.events).requests.find((r) => r.requestId === e.request_id && r.streamKey === key);
                },
            }),
        );
    }
}
