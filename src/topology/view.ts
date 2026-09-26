import type { ObservatoryEvent } from "../protocol/events";
import { h, svg } from "../renderer/dom";
import { allDiagnostics, deriveTopology, evidenceFor, selectionValid } from "./derive";
import { layoutTopology, type TopologyLayout } from "./layout";
import type { TopologyGraph, TopologySelection } from "./model";
import { buildScene, shapePath, type LegendEntry, type TopologyScene } from "./scene";

export interface TopologyPanelCallbacks {
    /** Open one evidence event in the shared inspector / move the replay cursor. */
    onSelectEvent(event: ObservatoryEvent): void;
    /** Optional: notified when the graph selection changes (null = cleared). */
    onSelectionChange?(selection: TopologySelection | null, evidenceEventIds: string[]): void;
    /** Optional formatter for evidence rows (defaults to ms since first event). */
    relativeTime?(event: ObservatoryEvent): string;
}

/**
 * Topology panel: SVG graph at the replay cursor, legend, selection evidence
 * list and diagnostics. Plain DOM + SVG, no dependencies.
 *
 * Usage:
 *   const panel = new TopologyPanel({ onSelectEvent: (e) => app.select(e) });
 *   container.append(panel.element);
 *   panel.setEvents(sessionEvents);   // whenever the session grows
 *   panel.setTime(cursorMonoNs);      // on every scrub / replay tick (null = live/all)
 */
export class TopologyPanel {
    readonly element: HTMLElement;
    private readonly cb: TopologyPanelCallbacks;
    private events: readonly ObservatoryEvent[] = [];
    private byId = new Map<string, ObservatoryEvent>();
    private layout: TopologyLayout = { positions: new Map(), width: 0, height: 0, columns: [] };
    private graph: TopologyGraph | null = null;
    private at: number | null = null;
    private selection: TopologySelection | null = null;
    private readonly canvas: HTMLElement;
    private readonly side: HTMLElement;
    private readonly legend: HTMLElement;

    constructor(cb: TopologyPanelCallbacks) {
        this.cb = cb;
        this.canvas = h("div", { class: "topology-canvas" });
        this.side = h("div", { class: "topology-side", "aria-live": "polite" });
        this.legend = h("div", { class: "topology-legend", role: "list", "aria-label": "Topology legend" });
        this.element = h(
            "section",
            // tabindex -1: focus fallback (keeps Escape working) when a focused node disappears while scrubbing.
            { class: "topology-panel", "aria-label": "Sonder agent topology", tabindex: -1 },
            h("div", { class: "panel-head" }, h("h2", { text: "Agent topology" })),
            h(
                "p",
                { class: "muted small" },
                "Derived only from orchestration events at the replay cursor; every node and edge lists its evidence event ids.",
            ),
            this.canvas,
            this.legend,
            this.side,
        );
        this.element.addEventListener("keydown", (ev) => {
            if (ev.key === "Escape" && this.selection) {
                this.select(null);
            }
        });
    }

    /** Replace the session events. Layout is computed from the full session so nodes stay put while scrubbing. */
    setEvents(events: readonly ObservatoryEvent[]): void {
        this.events = events;
        this.byId = new Map(events.map((e) => [e.event_id, e]));
        this.layout = layoutTopology(deriveTopology(events));
        this.render();
    }

    /** Replay cursor time (mono_ns, inclusive); null shows all events. */
    setTime(atMonoNs: number | null): void {
        if (atMonoNs === this.at && this.graph) {
            return;
        }
        this.at = atMonoNs;
        this.render();
    }

    select(selection: TopologySelection | null): void {
        this.selection = selection;
        this.render();
        const evidence = selection && this.graph ? evidenceFor(this.graph, selection) : [];
        this.cb.onSelectionChange?.(selection, evidence);
    }

    getGraph(): TopologyGraph | null {
        return this.graph;
    }

    render(): void {
        const graph = deriveTopology(this.events, { atMonoNs: this.at });
        this.graph = graph;
        // Preserve selection while its identity remains valid (UX.md replay).
        const activeSelection = selectionValid(graph, this.selection) ? this.selection : null;
        const scene = buildScene(graph, this.layout, { selection: activeSelection, atMonoNs: this.at });
        // Re-rendering replaces the SVG; remember which node/edge had keyboard focus so it keeps it.
        const focused = this.focusedItem();
        this.canvas.replaceChildren(scene.nodes.length === 0 ? this.empty() : this.drawSvg(scene));
        if (focused) {
            this.restoreFocus(focused);
        }
        this.legend.replaceChildren(...scene.legend.map(legendItem));
        this.side.replaceChildren(...this.sideContent(graph, activeSelection));
    }

    /** The node/edge (by selection identity) that currently has focus inside the graph, if any. */
    private focusedItem(): TopologySelection | null {
        const active = this.element.ownerDocument.activeElement;
        if (!active || !this.canvas.contains(active)) {
            return null;
        }
        const kind = active.getAttribute("data-topo-kind");
        const id = active.getAttribute("data-topo-id");
        return (kind === "node" || kind === "edge") && id !== null ? { kind, id } : null;
    }

    private restoreFocus(item: TopologySelection): void {
        const match = Array.from(this.canvas.querySelectorAll<SVGElement>("[data-topo-kind]")).find(
            (el) => el.getAttribute("data-topo-kind") === item.kind && el.getAttribute("data-topo-id") === item.id,
        );
        (match ?? this.element).focus({ preventScroll: true });
    }

    private empty(): HTMLElement {
        return h("p", { class: "muted", text: "No orchestration events (agent/route/tool/memory/guard) at this point in the session." });
    }

    private drawSvg(scene: TopologyScene): SVGElement {
        const root = svg("svg", {
            viewBox: `0 0 ${Math.max(1, scene.width)} ${Math.max(1, scene.height)}`,
            width: "100%",
            role: "group",
            "aria-label": `Topology graph: ${scene.nodes.length} nodes, ${scene.edges.length} edges`,
            class: "topology-svg",
        });
        const defs = svg("defs");
        const marker = svg("marker", { id: "topo-arrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "9", markerHeight: "9", markerUnits: "userSpaceOnUse", orient: "auto-start-reverse" });
        marker.append(svg("path", { d: "M0,0 L10,5 L0,10 Z", fill: "context-stroke" }));
        defs.append(marker);
        root.append(defs);
        for (const col of scene.columns) {
            const t = svg("text", { x: col.x, y: 18, "text-anchor": "middle", class: "topology-column", fill: "var(--muted, #94A3B8)", "font-size": 11 });
            t.textContent = col.label;
            root.append(t);
        }
        for (const e of scene.edges) {
            const g = svg("g", {
                class: `topology-edge${e.selected ? " selected" : ""}`,
                tabindex: 0,
                role: "button",
                "aria-pressed": String(e.selected),
                "aria-label": e.ariaLabel,
                opacity: e.opacity,
                "data-topo-kind": "edge",
                "data-topo-id": e.id,
            });
            // wide transparent hit area
            g.append(svg("path", { d: e.path, fill: "none", stroke: "transparent", "stroke-width": 12 }));
            g.append(
                svg("path", {
                    d: e.path,
                    fill: "none",
                    stroke: e.color,
                    "stroke-width": e.selected ? e.width + 2 : e.width,
                    "stroke-dasharray": e.dash || "none",
                    "marker-end": "url(#topo-arrow)",
                }),
            );
            const title = svg("title");
            title.textContent = e.label;
            g.append(title);
            if (e.selected || e.status === "failed") {
                const t = svg("text", { x: e.labelX, y: e.labelY - 4, "text-anchor": "middle", "font-size": 10, fill: "var(--text, #E2E8F0)" });
                t.textContent = e.label;
                g.append(t);
            }
            this.bindSelect(g, { kind: "edge", id: e.id });
            root.append(g);
        }
        for (const n of scene.nodes) {
            const g = svg("g", {
                class: `topology-node${n.selected ? " selected" : ""}`,
                tabindex: 0,
                role: "button",
                "aria-pressed": String(n.selected),
                "aria-label": n.ariaLabel,
                opacity: n.opacity,
                "data-topo-kind": "node",
                "data-topo-id": n.id,
            });
            g.append(
                svg("path", {
                    d: shapePath(n.shape, n.x, n.y, n.r),
                    fill: n.fill,
                    "fill-opacity": 0.25,
                    stroke: n.selected ? "var(--text, #E2E8F0)" : n.stroke,
                    "stroke-width": n.selected ? 3 : 2,
                    "stroke-dasharray": n.dash || "none",
                }),
            );
            const badge = svg("text", { x: n.x, y: n.y + 4, "text-anchor": "middle", "font-size": 12, fill: "var(--text, #E2E8F0)", "aria-hidden": "true" });
            badge.textContent = n.badge;
            const label = svg("text", { x: n.x, y: n.y + n.r + 14, "text-anchor": "middle", "font-size": 11, fill: "var(--text, #E2E8F0)" });
            label.textContent = n.label;
            const sub = svg("text", { x: n.x, y: n.y + n.r + 27, "text-anchor": "middle", "font-size": 10, fill: "var(--muted, #94A3B8)" });
            sub.textContent = n.sublabel;
            g.append(badge, label, sub);
            if (n.diagnosticCount > 0) {
                const warn = svg("text", { x: n.x + n.r, y: n.y - n.r, "font-size": 11, fill: "var(--color-warning, #F59E0B)" });
                warn.textContent = `⚠ ${n.diagnosticCount}`;
                g.append(warn);
            }
            const title = svg("title");
            title.textContent = n.ariaLabel;
            g.append(title);
            this.bindSelect(g, { kind: "node", id: n.id });
            root.append(g);
        }
        return root;
    }

    private bindSelect(el: Element, sel: TopologySelection): void {
        const toggle = (): void => {
            const same = this.selection?.kind === sel.kind && this.selection.id === sel.id;
            this.select(same ? null : sel);
        };
        el.addEventListener("click", toggle);
        el.addEventListener("keydown", (ev) => {
            const key = (ev as KeyboardEvent).key;
            if (key === "Enter" || key === " ") {
                ev.preventDefault();
                toggle();
            }
        });
    }

    private rel(e: ObservatoryEvent): string {
        if (this.cb.relativeTime) {
            return this.cb.relativeTime(e);
        }
        const t0 = this.events.reduce((m, x) => Math.min(m, x.mono_ns), Number.POSITIVE_INFINITY);
        return `+${((e.mono_ns - t0) / 1e6).toFixed(0)} ms`;
    }

    private eventButton(id: string): HTMLElement {
        const e = this.byId.get(id);
        if (!e) {
            return h("li", { class: "mono muted", text: `${id} (not in loaded events)` });
        }
        const btn = h("button", { type: "button", class: "link", text: `${this.rel(e)}  ${e.event_type}  ${e.event_id}` });
        btn.addEventListener("click", () => this.cb.onSelectEvent(e));
        return h("li", {}, btn);
    }

    private sideContent(graph: TopologyGraph, selection: TopologySelection | null): Node[] {
        const out: Node[] = [];
        if (selection) {
            const item =
                selection.kind === "node" ? graph.nodes.find((n) => n.id === selection.id) : graph.edges.find((e) => e.id === selection.id);
            if (item) {
                const facts = h("dl", { class: "kv" });
                const add = (k: string, v: string): void => {
                    facts.append(h("dt", { text: k }), h("dd", { class: "mono", text: v }));
                };
                if ("kind" in item && selection.kind === "node" && "entityId" in item) {
                    add("kind", item.kind);
                    add("id", item.entityId);
                    add("role", item.role ?? "not reported");
                    add("status", item.status);
                    add("diagnostics", item.diagnostics.map((d) => d.kind).join(", ") || "none");
                } else if ("source" in item) {
                    add("kind", item.kind);
                    add("from", item.source);
                    add("to", item.target);
                    add("status", item.status);
                    add("count", String(item.count));
                    add("failures", String(item.failures));
                    add("tokens", item.tokens === null ? "not reported" : String(item.tokens));
                }
                out.push(
                    h("h3", { text: `Selected ${selection.kind}: ${selection.id}` }),
                    facts,
                    h("h3", { text: `Evidence (${item.evidence.length} events)` }),
                    h("ul", { class: "related" }, ...item.evidence.map((id) => this.eventButton(id))),
                );
            }
        } else {
            out.push(h("p", { class: "muted", text: "Select a node or edge (click, or Tab + Enter) to list its evidence events. Esc clears." }));
        }
        const diags = allDiagnostics(graph);
        if (diags.length > 0) {
            out.push(
                h("h3", { text: `Retry / recovery / guard diagnostics (${diags.length})` }),
                h(
                    "ul",
                    { class: "related" },
                    ...diags.map((d) => {
                        const e = this.byId.get(d.eventId);
                        const btn = h("button", { type: "button", class: "link", text: `${e ? this.rel(e) : ""}  ${d.kind}  ${d.nodeId ?? "(no agent)"}` });
                        if (e) {
                            btn.addEventListener("click", () => this.cb.onSelectEvent(e));
                        }
                        return h("li", {}, btn);
                    }),
                ),
            );
        }
        if (graph.unmappedEventIds.length > 0) {
            out.push(
                h("p", {
                    class: "muted small",
                    text: `${graph.unmappedEventIds.length} orchestration event(s) lacked the ids needed to place them in the graph and are not drawn.`,
                }),
            );
        }
        return out;
    }
}

function legendItem(entry: LegendEntry): HTMLElement {
    const swatch = svg("svg", { width: 28, height: 14, "aria-hidden": "true" });
    if (entry.group === "node" && entry.shape) {
        swatch.append(svg("path", { d: shapePath(entry.shape, 14, 7, 6), fill: entry.color ?? "none", "fill-opacity": 0.4, stroke: entry.color ?? "none" }));
    } else if (entry.group === "edge") {
        swatch.append(svg("line", { x1: 1, y1: 7, x2: 27, y2: 7, stroke: entry.color ?? "currentColor", "stroke-width": 2, "stroke-dasharray": entry.dash || "none" }));
    } else if (entry.group === "status") {
        swatch.append(svg("circle", { cx: 14, cy: 7, r: 5, fill: "none", stroke: entry.color ?? "currentColor", "stroke-width": 1.5, "stroke-dasharray": entry.dash || "none" }));
    }
    const text = entry.badge ? `${entry.badge} ${entry.label}` : entry.label;
    return h("div", { class: `topology-legend-item legend-${entry.group}`, role: "listitem" }, entry.group === "mapping" ? null : swatch, h("span", { text }));
}
