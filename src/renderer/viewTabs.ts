/**
 * View tab activation, lazy-loaded tabs (Compare, 3D Inference), Diagnostics
 * findings, Agents topology, and registered extra overview panels.
 */
import type { ComparePanel } from "../compare/panel";
import { FindingsController, renderFindingsPanel, runDiagnostics } from "../diagnostics";
import type { Inference3DPanel } from "../inference3d/inference3dPanel";
import type { HealthBackend } from "../ingest/live/health";
import type { ObservatoryEvent } from "../protocol/events";
import type { ReplayCursor } from "../replay/controller";
import type { SessionStore } from "../replay/session";
import { TopologyPanel } from "../topology";
import { VIEWS, type ViewId } from "./appLayout";
import { byId, h } from "./dom";
import { fmtRelNs } from "./format";
import type { ObservatoryPanel, PanelContext } from "./panels";

export interface ViewTabsHooks {
    getStore(): SessionStore;
    getCursor(): ReplayCursor;
    getSelectedId(): string | null;
    isFollow(): boolean;
    describeSource(): string;
    healthByInstance(): { map: Map<string, readonly HealthBackend[]>; levels: Map<string, string>; stamp: string };
    setHighlighted(ids: readonly string[]): void;
    selectEventById(id: string): void;
    selectEvent(event: ObservatoryEvent): void;
    seekTo(event: ObservatoryEvent): void;
    onRender(): void;
}

export class ViewTabsController {
    private readonly hooks: ViewTabsHooks;
    private readonly panels: readonly ObservatoryPanel[];
    private readonly diag: FindingsController;
    private findingsDirty = true;
    private findingsVersion = 0;
    private diagStamp = "";
    private readonly topology: TopologyPanel;
    private topologyDirty = true;
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

    constructor(panels: readonly ObservatoryPanel[], hooks: ViewTabsHooks) {
        this.panels = panels;
        this.hooks = hooks;
        this.diag = new FindingsController({
            highlightEvents: (ids) => this.hooks.setHighlighted(ids),
            selectEvent: (id) => this.hooks.selectEventById(id),
        });
        this.topology = new TopologyPanel({
            onSelectEvent: (event) => this.hooks.seekTo(event),
            onSelectionChange: (_selection, evidenceEventIds) => {
                this.hooks.setHighlighted(evidenceEventIds);
                this.hooks.onRender();
            },
            relativeTime: (event) => fmtRelNs(this.hooks.getCursor().relativeTime(event)),
        });
    }

    mountTopology(): void {
        byId("view-agents").append(this.topology.element);
    }

    markDataChanged(): void {
        this.findingsDirty = true;
        this.topologyDirty = true;
    }

    invalidatePalette(): void {
        this.inference3d?.invalidatePalette();
    }

    render(view: ViewId, visible: readonly ObservatoryEvent[]): void {
        for (const v of VIEWS) {
            const active = v.id === view;
            const tab = byId<HTMLButtonElement>(`tab-${v.id}`);
            tab.setAttribute("aria-selected", active ? "true" : "false");
            // Roving tabindex: only the active tab is in the Tab sequence.
            tab.tabIndex = active ? 0 : -1;
            tab.classList.toggle("active", active);
            byId(`view-${v.id}`).hidden = !active;
        }
        byId("extra-panels").hidden = view !== "overview";
        this.renderDiagnostics();
        this.renderTopology();
        this.renderCompare(visible);
        this.render3d(visible);
    }

    renderExtraPanels(view: ViewId, visible: readonly ObservatoryEvent[]): void {
        if (view !== "overview") {
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

    private panelContext(visible: readonly ObservatoryEvent[]): PanelContext {
        const store = this.hooks.getStore();
        return {
            visible,
            all: store.events,
            selectedId: this.hooks.getSelectedId(),
            select: (e) => this.hooks.seekTo(e),
            synthetic: store.synthetic,
        };
    }

    /** Hidden tabs are not rendered; the panel throttles re-analysis of a growing live session. */
    private renderCompare(visible: readonly ObservatoryEvent[]): void {
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
                        this.compare = new ComparePanel({ describeCurrent: () => this.hooks.describeSource() });
                        this.hooks.onRender();
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
            this.compare.render(container, this.panelContext(visible));
        } catch (error) {
            container.replaceChildren(h("p", { class: "warning", text: `Compare failed: ${(error as Error).message}` }));
        }
    }

    /** 3D Inference tab: loads its chunk (and three.js) on first use; hidden tabs stop rendering. */
    private render3d(visible: readonly ObservatoryEvent[]): void {
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
                            onInspect: (event) => this.hooks.selectEvent(event),
                            onEvidence: (ids) => this.hooks.setHighlighted(ids),
                        });
                        container.replaceChildren(this.inference3d.element);
                        this.hooks.onRender();
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
        const health = this.hooks.healthByInstance();
        const cursor = this.hooks.getCursor();
        const store = this.hooks.getStore();
        try {
            this.inference3d.update({
                all: store.events,
                visible,
                nowNs: cursor.events.length > 0 ? cursor.originNs + cursor.position : null,
                health: health.map,
                declaredLevels: health.levels,
                healthStamp: health.stamp,
                relativeTime: (ns) => fmtRelNs(ns - cursor.originNs),
            });
        } catch (error) {
            container.append(h("p", { class: "warning", text: `3D view failed: ${(error as Error).message}` }));
        }
    }

    /** Topology layout uses the whole session; the graph itself is derived at the replay cursor. */
    private renderTopology(): void {
        if (byId("view-agents").hidden) {
            return;
        }
        if (this.topologyDirty) {
            this.topologyDirty = false;
            this.topology.setEvents(this.hooks.getStore().events);
        }
        const cursor = this.hooks.getCursor();
        this.topology.setTime(this.hooks.isFollow() ? null : cursor.originNs + cursor.position);
    }

    /** Findings are recomputed over the whole session when it changes (fine for M1-sized sessions). */
    private renderDiagnostics(): void {
        const container = byId("view-diagnostics");
        if (container.hidden) {
            return;
        }
        const store = this.hooks.getStore();
        if (this.findingsDirty) {
            this.findingsDirty = false;
            this.findingsVersion += 1;
            this.diag.setFindings(runDiagnostics(store.events));
        }
        const cursor = this.hooks.getCursor();
        const stamp = `${this.findingsVersion}|${this.diag.revision}|${store.synthetic}|${cursor.originNs}`;
        if (stamp === this.diagStamp) {
            return;
        }
        this.diagStamp = stamp;
        const hadFocus = container.contains(document.activeElement);
        const origin = cursor.originNs;
        container.replaceChildren(
            ...renderFindingsPanel(this.diag, {
                relativeTime: (ns) => fmtRelNs(ns - origin),
                onChange: () => this.hooks.onRender(),
                synthetic: store.synthetic,
            }),
        );
        if (hadFocus) {
            (container.querySelector<HTMLElement>(".diag-finding.selected") ?? container.querySelector<HTMLElement>(".diag-finding"))?.focus();
        }
    }
}
