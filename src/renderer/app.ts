import fixtureText from "../../fixtures/synthetic-session.ndjson?raw";
import { FindingsController, renderFindingsPanel, runDiagnostics } from "../diagnostics";
import { renderInspector } from "../inspector/inspector";
import type { ObservatoryEvent } from "../protocol/events";
import { classifyEvent, EVENT_CLASSES, isErrorEvent, type EventClass } from "../query/classify";
import { deriveMetrics, type Metrics } from "../query/metrics";
import { loadRecording, RECORDING_EXTENSION, serializeRecording } from "../recording/sobs";
import { ReplayCursor } from "../replay/controller";
import { SessionStore } from "../replay/session";
import { TopologyPanel } from "../topology";
import { checkEndpoint, DEFAULT_ENDPOINT, LiveConnection, type ConnectionState } from "../transport/live";
import { byId, h, svg } from "./dom";
import { fmtBytes, fmtMs, fmtPct, fmtRate, fmtRelNs, summarizeAttributes } from "./format";
import type { ObservatoryPanel } from "./panels";

const TABLE_LIMIT = 400;
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
/** Analysis views shown as tabs below the event table. */
const VIEWS = [
    { id: "diagnostics", title: "Diagnostics" },
    { id: "agents", title: "Agents" },
] as const;
type ViewId = (typeof VIEWS)[number]["id"];

export class ObservatoryApp {
    private readonly root: HTMLElement;
    private readonly store = new SessionStore();
    private cursor = new ReplayCursor([]);
    private readonly live: LiveConnection;
    private connState: ConnectionState = "disconnected";
    private connDetail = "";
    private follow = true;
    private playing = false;
    private speed = 1;
    private lastFrame = 0;
    private selectedId: string | null = null;
    private filterText = "";
    private filterClass: EventClass | "all" = "all";
    private renderQueued = false;
    private readonly panels: ObservatoryPanel[];
    private view: ViewId = "diagnostics";
    /** Event ids highlighted in timeline/table (diagnostics or topology evidence). */
    private highlighted = new Set<string>();
    private readonly diag: FindingsController;
    private findingsDirty = true;
    private findingsVersion = 0;
    private diagStamp = "";
    private readonly topology: TopologyPanel;
    private topologyDirty = true;

    constructor(root: HTMLElement, panels: readonly ObservatoryPanel[] = []) {
        this.root = root;
        this.panels = [...panels];
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
            onSelectEvent: (event) => {
                this.setFollow(false);
                this.cursor.seek(this.cursor.relativeTime(event));
                this.select(event);
            },
            onSelectionChange: (_selection, evidenceEventIds) => {
                this.highlighted = new Set(evidenceEventIds);
                this.render();
            },
            relativeTime: (event) => fmtRelNs(this.cursor.relativeTime(event)),
        });
        this.live = new LiveConnection({
            onEvents: (events) => {
                this.store.append(events);
                this.rebuildCursor();
                this.queueRender();
            },
            onRejected: (lines) => {
                this.store.addRejected(lines);
                this.queueRender();
            },
            onState: (state, detail) => {
                this.connState = state;
                this.connDetail = detail ?? "";
                this.queueRender();
            },
        });
    }

    start(params: URLSearchParams): void {
        this.root.replaceChildren(this.layout(params.get("ws") ?? DEFAULT_ENDPOINT));
        byId("view-agents").append(this.topology.element);
        const view = VIEWS.find((v) => v.id === params.get("view"));
        if (view) {
            this.view = view.id;
        }
        this.bindControls();
        window.addEventListener("resize", () => this.queueRender());
        const ws = params.get("ws");
        if (ws) {
            this.connect(ws);
        } else if (params.get("fixture") !== "0") {
            this.loadText(fixtureText, "fixture", "synthetic fixture (fixtures/synthetic-session.ndjson)");
        }
        this.render();
    }

    // ---------------------------------------------------------------- layout

    private layout(endpoint: string): HTMLElement {
        return h(
            "div",
            { class: "shell" },
            h(
                "header",
                { class: "topbar" },
                h("h1", { text: "Sonder Observatory" }),
                h("span", { id: "source-badge", class: "badge" }),
                h("span", { id: "synthetic-badge", class: "badge badge-synthetic", hidden: true, text: "SYNTHETIC DATA" }),
                h("span", { id: "capture-badge", class: "badge" }),
                h(
                    "div",
                    { class: "controls" },
                    h("label", { for: "ws-url", class: "sr-only", text: "WebSocket endpoint" }),
                    h("input", { id: "ws-url", type: "text", value: endpoint, spellcheck: "false", size: 26, "aria-label": "WebSocket endpoint" }),
                    h("button", { id: "connect-btn", type: "button", text: "Connect" }),
                    h("span", { id: "conn-state", class: "conn", role: "status" }),
                    h("label", { class: "button-like", for: "file-input", text: "Open recording…" }),
                    h("input", { id: "file-input", type: "file", accept: `${RECORDING_EXTENSION},.ndjson,.jsonl,.json`, class: "sr-only" }),
                    h("button", { id: "fixture-btn", type: "button", text: "Load synthetic fixture" }),
                    h("button", { id: "save-btn", type: "button", text: `Save recording (${RECORDING_EXTENSION})` }),
                ),
            ),
            h("div", { id: "synthetic-banner", class: "banner", hidden: true, role: "note" },
                "Synthetic data: these events were generated by a fixture script, not measured from Sonder Runtime or a model. Values illustrate the viewer only.",
            ),
            h("div", { id: "warnings", class: "warnings", role: "status" }),
            h("section", { id: "cards", class: "cards", "aria-label": "Metrics" }),
            h(
                "section",
                { class: "panel timeline-panel", "aria-label": "Timeline" },
                h(
                    "div",
                    { class: "panel-head" },
                    h("h2", { text: "Timeline" }),
                    h(
                        "div",
                        { class: "replay-controls" },
                        h("button", { id: "play-btn", type: "button", text: "Play" }),
                        h("label", { for: "speed-select", text: "Speed" }),
                        h(
                            "select",
                            { id: "speed-select" },
                            ...SPEEDS.map((s) => h("option", { value: s, selected: s === 1, text: `${s}×` })),
                        ),
                        h("button", { id: "next-error-btn", type: "button", text: "Next error" }),
                        h("label", { class: "check" }, h("input", { id: "follow-check", type: "checkbox", checked: true }), " Follow latest"),
                        h("span", { id: "cursor-label", class: "mono" }),
                    ),
                ),
                h("div", { id: "timeline", class: "timeline" }),
                h("input", { id: "scrubber", type: "range", min: 0, max: 1000, value: 1000, step: 1, "aria-label": "Replay position" }),
            ),
            h(
                "div",
                { class: "lower" },
                h(
                    "section",
                    { class: "panel table-panel", "aria-label": "Events" },
                    h(
                        "div",
                        { class: "panel-head" },
                        h("h2", { text: "Events" }),
                        h(
                            "div",
                            { class: "filters" },
                            h("input", { id: "filter-text", type: "search", placeholder: "filter event type / id", "aria-label": "Filter events" }),
                            h(
                                "select",
                                { id: "filter-class", "aria-label": "Event class" },
                                h("option", { value: "all", text: "all classes" }),
                                ...EVENT_CLASSES.map((c) => h("option", { value: c, text: c })),
                            ),
                            h("span", { id: "table-count", class: "muted" }),
                        ),
                    ),
                    h("div", { id: "table-wrap", class: "table-wrap", tabindex: 0 }),
                ),
                h("section", { id: "inspector", class: "panel inspector", "aria-label": "Inspector" }),
            ),
            h(
                "section",
                { class: "panel views", "aria-label": "Analysis views" },
                h(
                    "div",
                    { class: "tabs", role: "tablist", "aria-label": "Analysis views" },
                    ...VIEWS.map((v) =>
                        h("button", { id: `tab-${v.id}`, type: "button", role: "tab", class: "tab", "aria-controls": `view-${v.id}`, text: v.title }),
                    ),
                ),
                ...VIEWS.map((v) => h("div", { id: `view-${v.id}`, class: "view", role: "tabpanel", "aria-labelledby": `tab-${v.id}` })),
            ),
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
        );
    }

    private bindControls(): void {
        byId<HTMLButtonElement>("connect-btn").addEventListener("click", () => {
            if (this.connState === "connected" || this.connState === "connecting") {
                this.live.disconnect();
            } else {
                this.connect(byId<HTMLInputElement>("ws-url").value.trim());
            }
        });
        byId<HTMLInputElement>("file-input").addEventListener("change", (ev) => {
            const input = ev.target as HTMLInputElement;
            const file = input.files?.[0];
            if (!file) {
                return;
            }
            void file.text().then((text) => {
                this.live.disconnect();
                this.loadText(text, "file", file.name);
                input.value = "";
            });
        });
        byId<HTMLButtonElement>("fixture-btn").addEventListener("click", () => {
            this.live.disconnect();
            this.loadText(fixtureText, "fixture", "synthetic fixture (fixtures/synthetic-session.ndjson)");
        });
        byId<HTMLButtonElement>("save-btn").addEventListener("click", () => this.saveRecording());
        byId<HTMLButtonElement>("play-btn").addEventListener("click", () => this.togglePlay());
        byId<HTMLSelectElement>("speed-select").addEventListener("change", (ev) => {
            this.speed = Number((ev.target as HTMLSelectElement).value);
        });
        byId<HTMLButtonElement>("next-error-btn").addEventListener("click", () => {
            const next = this.cursor.nextMatching(isErrorEvent);
            if (next) {
                this.setFollow(false);
                this.cursor.seek(this.cursor.relativeTime(next));
                this.selectedId = next.event_id;
                this.render();
            }
        });
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
        VIEWS.forEach((v, i) => {
            const tab = byId<HTMLButtonElement>(`tab-${v.id}`);
            tab.addEventListener("click", () => {
                this.view = v.id;
                this.render();
            });
            // WAI-ARIA tabs pattern (automatic activation): Left/Right wrap, Home/End jump.
            tab.addEventListener("keydown", (ev) => {
                const n = VIEWS.length;
                const target =
                    ev.key === "ArrowRight" ? (i + 1) % n : ev.key === "ArrowLeft" ? (i - 1 + n) % n : ev.key === "Home" ? 0 : ev.key === "End" ? n - 1 : -1;
                if (target < 0) {
                    return;
                }
                ev.preventDefault();
                this.view = VIEWS[target]!.id;
                this.render();
                byId(`tab-${this.view}`).focus();
            });
        });
    }

    // --------------------------------------------------------------- actions

    private connect(url: string): void {
        byId<HTMLInputElement>("ws-url").value = url;
        this.store.reset("live", url);
        this.rebuildCursor();
        this.selectedId = null;
        this.setFollow(true);
        this.live.connect(url);
        this.render();
    }

    private loadText(text: string, source: "fixture" | "file", label: string): void {
        const loaded = loadRecording(text);
        this.store.reset(source, label, loaded.manifest);
        this.store.append(loaded.events);
        this.store.addRejected(loaded.rejected);
        this.rebuildCursor();
        this.selectedId = null;
        this.setFollow(true);
        this.render();
    }

    private saveRecording(): void {
        if (this.store.events.length === 0) {
            return;
        }
        const text = serializeRecording(this.store.events);
        const blob = new Blob([text], { type: "application/x-ndjson" });
        const url = URL.createObjectURL(blob);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const a = h("a", { href: url, download: `observatory-${stamp}${RECORDING_EXTENSION}` });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    private rebuildCursor(): void {
        const previous = this.cursor.position;
        this.cursor = new ReplayCursor(this.store.events);
        this.cursor.seek(this.follow ? this.cursor.durationNs : previous);
        this.findingsDirty = true;
        this.topologyDirty = true;
    }

    private setFollow(follow: boolean): void {
        this.follow = follow;
        byId<HTMLInputElement>("follow-check").checked = follow;
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
        this.render();
    }

    private onTableKey(ev: KeyboardEvent): void {
        if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") {
            return;
        }
        ev.preventDefault();
        const rows = this.tableRows();
        if (rows.length === 0) {
            return;
        }
        const idx = rows.findIndex((e) => e.event_id === this.selectedId);
        const next = idx < 0 ? rows.length - 1 : Math.min(Math.max(idx + (ev.key === "ArrowDown" ? 1 : -1), 0), rows.length - 1);
        this.select(rows[next]);
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

    private render(): void {
        const visible = this.cursor.visibleEvents();
        const metrics = deriveMetrics(visible);
        this.renderHeader();
        this.renderWarnings();
        this.renderCards(metrics);
        this.renderTimeline(metrics);
        this.renderTable();
        this.renderInspectorPanel();
        this.renderViews();
        this.renderExtraPanels(visible);
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
        this.renderDiagnostics();
        this.renderTopology();
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
        if (this.findingsDirty) {
            this.findingsDirty = false;
            this.findingsVersion += 1;
            this.diag.setFindings(runDiagnostics(this.store.events));
        }
        const container = byId("view-diagnostics");
        const stamp = `${this.findingsVersion}|${this.diag.selected()?.id ?? ""}|${this.store.synthetic}|${this.cursor.originNs}`;
        if (container.hidden || stamp === this.diagStamp) {
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
        for (const panel of this.panels) {
            const container = document.getElementById(`panel-${panel.id}`);
            if (!container) {
                continue;
            }
            try {
                panel.render(container, {
                    visible,
                    all: this.store.events,
                    selectedId: this.selectedId,
                    select: (e) => {
                        this.setFollow(false);
                        this.cursor.seek(this.cursor.relativeTime(e));
                        this.select(e);
                    },
                    synthetic: this.store.synthetic,
                });
            } catch (error) {
                // A failing panel must not take down the rest of the viewer.
                container.replaceChildren(h("p", { class: "warning", text: `Panel "${panel.title}" failed: ${(error as Error).message}` }));
            }
        }
    }

    private renderHeader(): void {
        const s = this.store;
        const sourceText =
            s.source === "none" ? "no data" : s.source === "live" ? `live · ${s.sourceLabel}` : `${s.source === "file" ? "recording" : "fixture"} · ${s.sourceLabel}`;
        byId("source-badge").textContent = sourceText;
        const synthetic = s.synthetic;
        byId("synthetic-badge").hidden = !synthetic;
        byId("synthetic-banner").hidden = !synthetic;
        byId("capture-badge").textContent = `text capture: ${s.capturePolicy}`;
        const connBtn = byId<HTMLButtonElement>("connect-btn");
        connBtn.textContent = this.connState === "connected" || this.connState === "connecting" ? "Disconnect" : "Connect";
        const stateEl = byId("conn-state");
        stateEl.textContent = `${this.connState}${this.connDetail && this.connState !== "connected" ? ` (${this.connDetail})` : ""}`;
        stateEl.dataset.state = this.connState;
        const save = byId<HTMLButtonElement>("save-btn");
        save.disabled = s.events.length === 0;
        save.textContent = s.source === "live" ? `Save live session (${s.events.length} events)` : `Save recording (${RECORDING_EXTENSION})`;
        byId<HTMLButtonElement>("play-btn").textContent = this.playing ? "Pause" : "Play";
        const endpoint = checkEndpoint(byId<HTMLInputElement>("ws-url").value.trim());
        byId("ws-url").title = endpoint.message ?? "loopback endpoint";
    }

    private renderWarnings(): void {
        const s = this.store;
        const items: string[] = [];
        if (s.rejected.length > 0) {
            const first = s.rejected[0]!;
            items.push(`${s.rejected.length} line(s) rejected by the schema validator (first: line ${first.line}: ${first.reason})`);
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
        const endpoint = checkEndpoint(byId<HTMLInputElement>("ws-url").value.trim());
        if (s.source === "live" && endpoint.ok && !endpoint.loopback) {
            items.push(endpoint.message ?? "remote endpoint");
        }
        const el = byId("warnings");
        el.replaceChildren(...items.map((t) => h("div", { class: "warning", text: `⚠ ${t}` })));
    }

    private renderCards(m: Metrics): void {
        const res = m.resources;
        const card = (title: string, value: string, sub: string, evidence: string, tone = "") =>
            h(
                "article",
                { class: `card ${tone}` },
                h("h3", { text: title }),
                h("div", { class: "value", text: value }),
                h("div", { class: "sub", text: sub }),
                h("div", { class: "evidence", text: evidence }),
            );
        const derived = (n: number, what: string) => (n > 0 ? `derived · ${n} ${what}` : "unavailable · no events yet");
        const errorTypes = Object.entries(m.errors.byType)
            .map(([t, n]) => `${t} ×${n}`)
            .join(", ");
        byId("cards").replaceChildren(
            card(
                "Request latency",
                `p50 ${fmtMs(m.requestLatency.p50Ms)}`,
                `p95 ${fmtMs(m.requestLatency.p95Ms)} · max ${fmtMs(m.requestLatency.maxMs)} · open ${m.requests.filter((r) => r.outcome === "open").length}`,
                derived(m.requestLatency.count, "finished requests (request.started → end)"),
            ),
            card(
                "Time to first token",
                `p50 ${fmtMs(m.timeToFirstToken.p50Ms)}`,
                `p95 ${fmtMs(m.timeToFirstToken.p95Ms)}`,
                derived(m.timeToFirstToken.count, "requests with a first token"),
            ),
            card(
                "Token rate",
                `${fmtRate(m.tokens.recentRate)} tok/s`,
                `last ${m.tokens.windowMs / 1000}s · overall ${fmtRate(m.tokens.overallRate)} tok/s · ${m.tokens.total} tokens`,
                derived(m.tokens.total, "inference.token.generated"),
            ),
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
                `dropped (producer-reported) ${m.droppedEvents} · rejected ${this.store.rejected.length}`,
                "measured · events received at the cursor",
                m.droppedEvents > 0 ? "tone-warning" : "",
            ),
        );
    }

    private renderTimeline(m: Metrics): void {
        const container = byId("timeline");
        const width = Math.max(container.clientWidth, 320);
        const labelW = 84;
        const rowH = 20;
        const tracks = EVENT_CLASSES;
        const height = tracks.length * rowH + 8;
        const plotW = width - labelW - 8;
        const duration = Math.max(this.cursor.durationNs, 1);
        const xOf = (relNs: number) => labelW + (relNs / duration) * plotW;
        const root = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Event timeline by class" });
        const cursorRel = this.cursor.position;

        tracks.forEach((cls, row) => {
            const y = 4 + row * rowH;
            const label = svg("text", { x: 4, y: y + rowH * 0.7, class: "track-label" });
            label.textContent = cls;
            root.append(svg("rect", { x: labelW, y: y + 1, width: plotW, height: rowH - 2, class: "track-bg" }), label);
        });

        // Request spans on the request track.
        const reqRow = tracks.indexOf("request");
        for (const r of m.requests) {
            const x1 = xOf(r.startNs - this.cursor.originNs);
            const x2 = xOf((r.endNs ?? this.cursor.originNs + cursorRel) - this.cursor.originNs);
            root.append(
                svg("rect", {
                    x: x1,
                    y: 4 + reqRow * rowH + 4,
                    width: Math.max(x2 - x1, 1),
                    height: rowH - 8,
                    class: `span span-${r.outcome}`,
                }),
            );
        }

        // Event ticks, bucketed per pixel column per track to bound DOM size.
        const seen = new Set<string>();
        for (const e of this.cursor.events) {
            const rel = this.cursor.relativeTime(e);
            const cls = classifyEvent(e);
            const x = Math.round(xOf(rel));
            const key = `${cls}:${x}`;
            const evidence = this.highlighted.has(e.event_id);
            if (seen.has(key) && e.event_id !== this.selectedId && !evidence) {
                continue;
            }
            seen.add(key);
            const row = tracks.indexOf(cls);
            root.append(
                svg("rect", {
                    x: x - 0.5,
                    y: 4 + row * rowH + 3,
                    width: e.event_id === this.selectedId ? 3 : 1.5,
                    height: rowH - 6,
                    class: `tick cls-${cls}${rel > cursorRel ? " future" : ""}${evidence ? " evidence" : ""}${e.event_id === this.selectedId ? " selected" : ""}`,
                }),
            );
        }

        const cx = xOf(cursorRel);
        root.append(svg("line", { x1: cx, x2: cx, y1: 0, y2: height, class: "cursor-line" }));

        root.addEventListener("click", (ev) => {
            const rect = (root as unknown as SVGSVGElement).getBoundingClientRect();
            const px = ev.clientX - rect.left;
            if (px < labelW) {
                return;
            }
            const rel = ((px - labelW) / plotW) * duration;
            const row = Math.floor((ev.clientY - rect.top - 4) / rowH);
            const cls = tracks[row];
            // Select the nearest event in the clicked track, if any.
            let best: ObservatoryEvent | undefined;
            let bestD = Infinity;
            for (const e of this.cursor.events) {
                if (cls && classifyEvent(e) !== cls) {
                    continue;
                }
                const d = Math.abs(this.cursor.relativeTime(e) - rel);
                if (d < bestD) {
                    bestD = d;
                    best = e;
                }
            }
            this.setFollow(false);
            this.cursor.seek(best && bestD < duration * 0.01 ? this.cursor.relativeTime(best) : rel);
            this.selectedId = best && bestD < duration * 0.01 ? best.event_id : this.selectedId;
            this.render();
        });
        container.replaceChildren(root);

        const scrubber = byId<HTMLInputElement>("scrubber");
        scrubber.value = String(this.cursor.durationNs > 0 ? Math.round((cursorRel / this.cursor.durationNs) * 1000) : 1000);
        byId("cursor-label").textContent = `${fmtRelNs(cursorRel)} / ${fmtRelNs(this.cursor.durationNs)} · ${this.cursor.visibleCount()}/${this.cursor.events.length} events`;
    }

    private tableRows(): ObservatoryEvent[] {
        const visible = this.cursor.visibleEvents();
        const rows = visible.filter((e) => {
            if (this.filterClass !== "all" && classifyEvent(e) !== this.filterClass) {
                return false;
            }
            if (this.filterText) {
                const hay = `${e.event_type} ${e.event_id} ${e.request_id ?? ""} ${e.agent_id ?? ""}`.toLowerCase();
                return hay.includes(this.filterText);
            }
            return true;
        });
        return rows.slice(-TABLE_LIMIT);
    }

    private renderTable(): void {
        const rows = this.tableRows();
        const wrap = byId<HTMLDivElement>("table-wrap");
        const atBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 4;
        const body = h("tbody");
        for (const e of rows) {
            const cls = classifyEvent(e);
            const tr = h(
                "tr",
                { class: `row cls-${cls}${this.highlighted.has(e.event_id) ? " evidence" : ""}${e.event_id === this.selectedId ? " selected" : ""}`, "aria-selected": e.event_id === this.selectedId ? "true" : "false" },
                h("td", { class: "mono", text: e.sequence }),
                h("td", { class: "mono", text: fmtRelNs(this.cursor.relativeTime(e)) }),
                h("td", {}, h("span", { class: `dot cls-${cls}`, "aria-hidden": "true" }), ` ${e.event_type}`),
                h("td", { text: cls }),
                h("td", { class: "mono", text: e.request_id ?? "" }),
                h("td", { class: "mono", text: e.agent_id ?? "" }),
                h("td", { class: "muted", text: summarizeAttributes(e.attributes) }),
            );
            tr.addEventListener("click", () => this.select(e));
            body.append(tr);
        }
        const table = h(
            "table",
            { class: "events" },
            h(
                "thead",
                {},
                h("tr", {}, ...["seq", "t", "event type", "class", "request", "agent", "attributes"].map((c) => h("th", { scope: "col", text: c }))),
            ),
            body,
        );
        wrap.replaceChildren(table);
        if (this.follow || atBottom) {
            wrap.scrollTop = wrap.scrollHeight;
        } else {
            wrap.querySelector("tr.selected")?.scrollIntoView({ block: "nearest" });
        }
        const total = this.cursor.visibleCount();
        byId("table-count").textContent = `${rows.length} shown${rows.length === TABLE_LIMIT ? ` (latest ${TABLE_LIMIT})` : ""} · ${total} at cursor`;
    }

    private renderInspectorPanel(): void {
        const panel = byId("inspector");
        const selected = this.selectedId ? this.store.events.find((e) => e.event_id === this.selectedId) : undefined;
        panel.replaceChildren(
            ...renderInspector(selected, this.store.events, {
                relativeTime: (e) => fmtRelNs(this.cursor.relativeTime(e)),
                onSelect: (e) => {
                    this.setFollow(false);
                    this.cursor.seek(this.cursor.relativeTime(e));
                    this.select(e);
                },
                onClose: () => this.select(undefined),
            }),
        );
    }
}
