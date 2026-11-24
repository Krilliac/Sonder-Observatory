/**
 * 3D Inference tab (lazy chunk: this module and three.js load on first use).
 *
 * Layout: stage rail + live output + token probabilities on the left, the
 * three.js scene with its legend and availability notices in the middle, and
 * the app's Inspector on the right (the app docks it beside every view).
 * Every scene entity is pickable (click in the scene, or the text-alternative
 * table) and opens its newest evidence event in the Inspector.
 */
import type { ObservatoryEvent } from "../protocol/events";
import { h } from "../renderer/dom";
import { derivePipeline } from "./derive";
import type { HealthBackend, PipelineModel, StageId } from "./model";
import { STAGES } from "./model";
import {
    buildEntityRows,
    renderEntityTable,
    renderFallbackTable,
    renderSelectionPanel,
    type EntityRow,
} from "./panelEntities";
import {
    createCameraControls,
    placeProjectedLabels,
    renderCapabilities,
    renderLegend,
    renderNotices,
    renderOutputFeed,
    renderPipelineSummary,
    renderProbabilities,
    renderStageRail,
} from "./panelViews";
import { createRenderer, InferenceScene, readPalette, type ProjectedLabel } from "./scene";
import "./inference3d.css";

export interface Inference3DCallbacks {
    /** Opens an evidence event in the Inspector (no cursor move). */
    onInspect(event: ObservatoryEvent): void;
    /** Evidence ids of the selection, for highlighting in the timeline and table (empty = none). */
    onEvidence(ids: string[]): void;
}

export interface Inference3DInput {
    /** Every event of the session (for evidence lookup). */
    all: readonly ObservatoryEvent[];
    /** Events at or before the replay cursor, in replay order. */
    visible: readonly ObservatoryEvent[];
    /** Replay cursor (mono_ns); null when there are no events. */
    nowNs: number | null;
    /** Health backends per producer instance id (live connections). */
    health: ReadonlyMap<string, readonly HealthBackend[]>;
    /** Changes whenever `health` changes (cheap memo key). */
    healthStamp: string;
    /** Formats a mono_ns relative to the session start. */
    relativeTime(ns: number): string;
}

export interface Inference3DTestHook {
    webgl: boolean;
    animating(): boolean;
    reducedMotion(): boolean;
    entities(): { id: string; kind: string; label: string }[];
    screenPoint(id: string): { x: number; y: number } | null;
    selected(): string | null;
    /** Last frame's WebGL draw calls and triangles (null without WebGL). */
    frameStats(): { calls: number; triangles: number; frames: number } | null;
}

declare global {
    interface Window {
        /** Read-only hook for e2e tests (entity ids and their screen positions). */
        __observatory3d?: Inference3DTestHook;
    }
}

/**
 * Skips re-deriving when `update` is called again with the same input. The
 * events array identity is part of the key: the store replaces the array on
 * every change and on every load, so another version of the same recording
 * (for example a redacted copy with the same ids, times and count) re-derives.
 */
export class UpdateMemo {
    private key = "";
    private source: readonly ObservatoryEvent[] | null = null;

    /** True when `input` differs from the last input seen (and records it). */
    changed(input: Pick<Inference3DInput, "all" | "visible" | "nowNs" | "healthStamp">): boolean {
        const key = `${input.all.length}|${input.visible.length}|${input.nowNs}|${input.healthStamp}|${input.all[0]?.event_id ?? ""}`;
        if (key === this.key && input.all === this.source) {
            return false;
        }
        this.key = key;
        this.source = input.all;
        return true;
    }

    invalidate(): void {
        this.key = "";
        this.source = null;
    }
}

export class Inference3DPanel {
    readonly element: HTMLElement;
    private readonly cb: Inference3DCallbacks;
    private readonly canvas: HTMLCanvasElement;
    private readonly labels: HTMLElement;
    private readonly fallback: HTMLElement;
    private readonly notices: HTMLElement;
    private readonly caps: HTMLElement;
    private readonly rail: HTMLElement;
    private readonly output: HTMLElement;
    private readonly probabilities: HTMLElement;
    private readonly legend: HTMLElement;
    private readonly selection: HTMLElement;
    private readonly table: HTMLElement;
    private readonly summary: HTMLElement;
    private readonly motionNote: HTMLElement;
    private scene: InferenceScene | null = null;
    private readonly webgl: boolean;
    private model: PipelineModel | null = null;
    private readonly memo = new UpdateMemo();
    private selected: string | null = null;
    private rows = new Map<string, EntityRow>();
    private byId = new Map<string, ObservatoryEvent>();
    private byIdSource: readonly ObservatoryEvent[] | null = null;
    private active = false;
    private readonly motion: MediaQueryList | null;
    private labelStamp = "";

    constructor(cb: Inference3DCallbacks) {
        this.cb = cb;
        this.canvas = h("canvas", { class: "i3d-canvas", role: "img", "aria-label": "3D inference pipeline", "aria-describedby": "i3d-summary" });
        this.labels = h("div", { class: "i3d-labels", "aria-hidden": "true" });
        this.fallback = h("div", { class: "i3d-fallback", hidden: true });
        this.notices = h("div", { class: "i3d-notices" });
        this.caps = h("section", { class: "i3d-caps", "aria-labelledby": "i3d-caps-title" });
        this.rail = h("ol", { class: "i3d-stages", "aria-label": "Pipeline stages" });
        this.output = h("div", { class: "i3d-output" });
        this.probabilities = h("div", { class: "i3d-probs" });
        this.legend = h("ul", { class: "legend i3d-legend", "aria-label": "3D scene legend" });
        this.selection = h("div", { class: "i3d-selection", "aria-live": "polite" });
        this.table = h("div", { class: "i3d-table-wrap", tabindex: 0, role: "region", "aria-label": "Scene entities (text alternative)" });
        this.summary = h("p", { id: "i3d-summary", class: "muted small i3d-summary" });
        this.motionNote = h("span", { class: "i3d-motion muted small" });
        this.motion = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;

        const cameraButtons = createCameraControls((action) => {
            if (!this.scene) {
                return;
            }
            if (action === "reset") {
                this.scene.reset();
            } else {
                this.scene.nudge(action);
            }
        });

        this.element = h(
            "section",
            { class: "i3d", "aria-labelledby": "i3d-title", tabindex: -1 },
            h(
                "div",
                { class: "i3d-head" },
                h("h2", { id: "i3d-title", text: "3D Inference" }),
                h("p", { class: "muted small i3d-lede", text: "Requests moving through the pipeline the producers report, at the replay cursor." }),
                this.motionNote,
            ),
            h(
                "div",
                { class: "i3d-body" },
                h(
                    "aside",
                    { class: "i3d-rail", "aria-label": "Pipeline details" },
                    h(
                        "section",
                        { class: "i3d-block", "aria-labelledby": "i3d-stages-title" },
                        h("h3", { id: "i3d-stages-title", text: "Pipeline stages" }),
                        this.rail,
                    ),
                    h(
                        "section",
                        { class: "i3d-block", "aria-labelledby": "i3d-output-title" },
                        h("h3", { id: "i3d-output-title", text: "Live output" }),
                        this.output,
                    ),
                    h(
                        "section",
                        { class: "i3d-block", "aria-labelledby": "i3d-probs-title" },
                        h("h3", { id: "i3d-probs-title", text: "Token probabilities" }),
                        this.probabilities,
                    ),
                ),
                h(
                    "div",
                    { class: "i3d-stage" },
                    this.notices,
                    h("div", { class: "i3d-canvas-wrap" }, this.canvas, this.labels, this.fallback, cameraButtons),
                    this.legend,
                    this.summary,
                ),
            ),
            this.selection,
            this.caps,
            h(
                "section",
                { class: "i3d-entities", "aria-labelledby": "i3d-entities-title" },
                h("h3", { id: "i3d-entities-title", text: "Scene entities" }),
                this.table,
            ),
        );
        this.element.addEventListener("keydown", (ev) => {
            if (ev.key === "Escape" && this.selected) {
                this.select(null);
            }
        });

        const renderer = createRenderer(this.canvas);
        this.webgl = renderer !== null;
        if (renderer) {
            this.scene = new InferenceScene(renderer, readPalette(this.element), {
                reducedMotion: this.reducedMotion(),
                onPick: (id) => this.select(id),
                onFrame: (labels) => this.placeLabels(labels),
            });
        } else {
            this.canvas.hidden = true;
            this.fallback.hidden = false;
        }
        this.motion?.addEventListener?.("change", () => {
            this.scene?.setReducedMotion(this.reducedMotion());
            this.renderMotionNote();
        });
        document.addEventListener("visibilitychange", () => this.scene?.setActive(this.active && !document.hidden));
        window.addEventListener("resize", () => this.scene?.requestRender());
        this.renderMotionNote();
        window.__observatory3d = {
            webgl: this.webgl,
            animating: () => this.scene?.animating ?? false,
            reducedMotion: () => this.reducedMotion(),
            entities: () => [...this.rows.values()].map((r) => ({ id: r.id, kind: r.kind, label: r.label })),
            screenPoint: (id) => this.scene?.screenPoint(id) ?? null,
            selected: () => this.selected,
            frameStats: () => this.scene?.frameStats ?? null,
        };
    }

    private reducedMotion(): boolean {
        return this.motion?.matches ?? false;
    }

    private renderMotionNote(): void {
        this.motionNote.textContent = !this.webgl ? "" : this.reducedMotion() ? "Motion paused (reduced motion): pulses are shown as brightness." : "";
    }

    /** The tab became visible or hidden: rendering runs only while visible. */
    setActive(active: boolean): void {
        this.active = active;
        this.scene?.setActive(active && !document.hidden);
    }

    /** Re-reads the theme colours (theme toggle). */
    invalidatePalette(): void {
        if (this.scene) {
            this.scene.setPalette(readPalette(this.element));
            this.memo.invalidate();
        }
    }

    update(input: Inference3DInput): void {
        if (!this.memo.changed(input)) {
            return;
        }
        if (this.byIdSource !== input.all || this.byId.size !== input.all.length) {
            this.byIdSource = input.all;
            this.byId = new Map(input.all.map((e) => [e.event_id, e]));
        }
        const model = derivePipeline(input.visible, { nowNs: input.nowNs, health: input.health });
        this.model = model;
        this.rows = buildEntityRows(model, input.visible, input.relativeTime);
        if (this.selected && !this.rows.has(this.selected)) {
            // Keep the selection id: it comes back when the cursor returns to where the entity exists.
            this.scene?.setSelected(null);
        }
        const onSelect = (id: string) => this.select(id);
        renderCapabilities(this.caps, model);
        renderNotices(this.notices, model, this.webgl);
        renderStageRail(this.rail, model, this.selected, onSelect);
        renderOutputFeed(this.output, model, input.relativeTime, onSelect);
        renderProbabilities(this.probabilities, model, onSelect);
        renderLegend(this.legend, model);
        renderEntityTable(this.table, this.rows, this.selected, onSelect);
        renderSelectionPanel(this.selection, this.selected, this.rows, this.byId, this.cb.onInspect);
        renderPipelineSummary(this.summary, this.canvas, model);
        if (this.scene) {
            this.scene.update(model, this.rows.has(this.selected ?? "") ? this.selected : null);
        } else {
            renderFallbackTable(this.fallback, model);
        }
    }

    select(id: string | null): void {
        this.selected = id;
        const row = id ? this.rows.get(id) : undefined;
        this.scene?.setSelected(row ? id : null);
        const onSelect = (nextId: string) => this.select(nextId);
        renderEntityTable(this.table, this.rows, this.selected, onSelect);
        renderSelectionPanel(this.selection, this.selected, this.rows, this.byId, this.cb.onInspect);
        renderStageRail(this.rail, this.model, this.selected, onSelect);
        this.cb.onEvidence(row ? row.evidence : []);
        const newest = row
            ? [...row.evidence]
                  .reverse()
                  .map((e) => this.byId.get(e))
                  .find((e) => e !== undefined)
            : undefined;
        if (newest) {
            this.cb.onInspect(newest);
        }
    }

    private placeLabels(labels: ProjectedLabel[]): void {
        this.labelStamp = placeProjectedLabels(this.labels, labels, this.labelStamp);
    }

    dispose(): void {
        this.scene?.dispose();
        if (window.__observatory3d) {
            delete window.__observatory3d;
        }
    }
}

/** Stage ids in pipeline order (re-exported for the app). */
export const PIPELINE_STAGE_IDS: readonly StageId[] = STAGES.map((s) => s.id);
