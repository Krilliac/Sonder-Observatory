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
import { derivePipeline, streamLabel } from "./derive";
import type { HealthBackend, PanelAvailability, PipelineModel, ProducerCapabilities, StageId } from "./model";
import { STAGES } from "./model";
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

interface EntityRow {
    id: string;
    kind: string;
    label: string;
    where: string;
    state: string;
    measures: string;
    evidence: string[];
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

const STATUS_WORD: Record<PanelAvailability["status"], string> = {
    available: "available",
    unavailable: "not available",
    waiting: "waiting for data",
    "not-applicable": "not applicable",
};

const MAX_OUTPUT_ROWS = 10;
const MAX_CHUNK_ROWS = 20;

function fmtRate(r: number): string {
    return r === 0 ? "idle" : `${r < 10 ? r.toFixed(1) : Math.round(r)}/s`;
}

function fmtBytes(n: number | null): string {
    return n === null ? "? B" : `${n} B`;
}

function fmtMs(n: number | null): string {
    return n === null ? "—" : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(2)} s`;
}

/** Plain text with `code` spans rendered as <code>. */
/** Drops null/false children (replaceChildren rejects them). */
function nodes(...items: (Node | string | null | false | undefined)[]): (Node | string)[] {
    return items.filter((x): x is Node | string => x !== null && x !== false && x !== undefined);
}

function richText(text: string): (Node | string)[] {
    return text.split(/(`[^`]+`)/).map((part) => (part.startsWith("`") && part.endsWith("`") ? h("code", { text: part.slice(1, -1) }) : part));
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
    private memo = "";
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

        const cameraButtons = h(
            "div",
            { class: "i3d-camera", role: "group", "aria-label": "Camera" },
            ...(
                [
                    ["left", "Rotate left", "⟲"],
                    ["right", "Rotate right", "⟳"],
                    ["up", "Tilt up", "↑"],
                    ["down", "Tilt down", "↓"],
                    ["in", "Zoom in", "+"],
                    ["out", "Zoom out", "−"],
                ] as const
            ).map(([action, label, glyph]) =>
                h("button", { type: "button", class: "small i3d-cam-btn", "data-camera": action, "aria-label": label, title: label, text: glyph }),
            ),
            h("button", { type: "button", class: "small", "data-camera": "reset", text: "Reset view" }),
        );
        cameraButtons.addEventListener("click", (ev) => {
            const action = (ev.target as HTMLElement).closest<HTMLElement>("[data-camera]")?.dataset.camera;
            if (!action || !this.scene) {
                return;
            }
            if (action === "reset") {
                this.scene.reset();
            } else {
                this.scene.nudge(action as "left");
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
            this.memo = "";
        }
    }

    update(input: Inference3DInput): void {
        const key = `${input.all.length}|${input.visible.length}|${input.nowNs}|${input.healthStamp}|${input.all[0]?.event_id ?? ""}`;
        if (key === this.memo) {
            return;
        }
        this.memo = key;
        if (this.byIdSource !== input.all || this.byId.size !== input.all.length) {
            this.byIdSource = input.all;
            this.byId = new Map(input.all.map((e) => [e.event_id, e]));
        }
        const model = derivePipeline(input.visible, { nowNs: input.nowNs, health: input.health });
        this.model = model;
        this.rows = this.entityRows(model, input);
        if (this.selected && !this.rows.has(this.selected)) {
            // Keep the selection id: it comes back when the cursor returns to where the entity exists.
            this.scene?.setSelected(null);
        }
        this.renderCapabilities(model);
        this.renderNotices(model);
        this.renderRail(model);
        this.renderOutput(model, input);
        this.renderProbabilities(model);
        this.renderLegend(model);
        this.renderTable();
        this.renderSelection();
        this.renderSummary(model);
        if (this.scene) {
            this.scene.update(model, this.rows.has(this.selected ?? "") ? this.selected : null);
        } else {
            this.renderFallback(model);
        }
    }

    select(id: string | null): void {
        this.selected = id;
        const row = id ? this.rows.get(id) : undefined;
        this.scene?.setSelected(row ? id : null);
        this.renderTable();
        this.renderSelection();
        this.renderRail(this.model);
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

    // ------------------------------------------------------------ sections

    private renderCapabilities(model: PipelineModel): void {
        const producers = model.capabilities;
        const chip = (p: PanelAvailability) =>
            h(
                "li",
                { class: "i3d-chip", "data-status": p.status, "data-panel": p.panel },
                h("span", { class: "i3d-chip-label", text: p.label }),
                h("span", { class: "i3d-chip-status", text: STATUS_WORD[p.status] }),
            );
        const row = (c: ProducerCapabilities) => {
            const backend = c.backends.length > 0 ? c.backends.join(", ") : "backend not named";
            const caps = c.backends
                .map((b) => c.backendCapabilities[b])
                .filter((x) => x !== undefined)
                .map((x) => `${x!.capabilities.join(", ") || "none"} (${x!.source})`)
                .join("; ");
            const reasons = c.panels.filter((p) => p.status !== "available");
            return h(
                "div",
                { class: "i3d-caps-row", "data-producer": `${c.producer}@${c.nodeId}` },
                h(
                    "div",
                    { class: "i3d-caps-who" },
                    h("strong", { text: `${c.producer} @ ${c.nodeId}` }),
                    c.synthetic ? h("span", { class: "tag tag-synthetic", text: "synthetic" }) : null,
                    h("span", { class: "muted small", text: ` ${backend}${caps ? ` · capabilities: ${caps}` : ""} · level ${c.level ?? "unknown"}` }),
                ),
                h("ul", { class: "i3d-chips", "aria-label": `Panels for ${c.producer} at ${c.nodeId}` }, ...c.panels.map(chip)),
                reasons.length > 0
                    ? h(
                          "details",
                          { class: "i3d-reasons" },
                          h("summary", { text: `Why ${reasons.length} panel${reasons.length === 1 ? " is" : "s are"} not showing data` }),
                          h("ul", {}, ...reasons.map((p) => h("li", { "data-panel": p.panel }, h("strong", { text: `${p.label}: ` }), ...richText(p.reason)))),
                      )
                    : null,
            );
        };
        this.caps.replaceChildren(
            h("h3", { id: "i3d-caps-title", text: "Capabilities" }),
            producers.length === 0
                ? h("p", { class: "muted small", text: "No producer events at the cursor yet." })
                : h("div", { class: "i3d-caps-rows" }, ...producers.map(row)),
        );
    }

    /** First non-available reason of a panel across producers that can have internals (not Runtime). */
    private reasonFor(model: PipelineModel, panel: PanelAvailability["panel"]): { text: string; status: PanelAvailability["status"] }[] {
        const out: { text: string; status: PanelAvailability["status"] }[] = [];
        for (const c of model.capabilities) {
            const p = c.panels.find((x) => x.panel === panel);
            if (!p || p.status === "available" || p.status === "not-applicable") {
                continue;
            }
            out.push({ text: model.capabilities.length > 1 ? `${c.producer} @ ${c.nodeId}: ${p.reason}` : p.reason, status: p.status });
        }
        return out;
    }

    private renderNotices(model: PipelineModel): void {
        const items: HTMLElement[] = [];
        if (!model.hasLayers) {
            const reasons = this.reasonFor(model, "layers");
            const text = reasons.length > 0 ? reasons.map((r) => r.text) : ["no producer at the cursor sends backend.layer.* events"];
            items.push(
                h(
                    "div",
                    { class: "i3d-notice", role: "note", "data-notice": "layers" },
                    h("strong", { text: "Layer internals: not available. " }),
                    "The scene shows the reported request pipeline instead of model layers.",
                    h("ul", {}, ...text.map((t) => h("li", {}, ...richText(t)))),
                ),
            );
        }
        if (!this.webgl) {
            items.unshift(
                h(
                    "div",
                    { class: "i3d-notice", role: "note", "data-notice": "webgl" },
                    h("strong", { text: "WebGL 2 is unavailable in this browser. " }),
                    "Showing a 2D summary of the same pipeline; the entity table below lists every entity.",
                ),
            );
        }
        this.notices.replaceChildren(...items);
    }

    private renderRail(model: PipelineModel | null): void {
        if (!model) {
            return;
        }
        const items: HTMLElement[] = [];
        for (const s of model.stages) {
            const def = STAGES.find((d) => d.id === s.id)!;
            const id = `stage:${s.id}`;
            const holding = s.id === "output" ? `${s.requests} finished` : `${s.requests} in flight`;
            const btn = h(
                "button",
                { type: "button", class: "i3d-stage-btn", "data-entity": id, "aria-pressed": this.selected === id ? "true" : "false" },
                h("span", { class: "i3d-stage-name", text: s.label }),
                h("span", { class: "i3d-stage-meta", text: `${holding} · ${s.events} events · ${fmtRate(s.ratePerSec)}` }),
            );
            btn.title = `Placed by: ${def.evidence}`;
            btn.addEventListener("click", () => this.select(id));
            const li = h("li", { "data-stage": s.id }, btn);
            if (s.id === "layers") {
                const layers = h("ol", { class: "i3d-layers", "aria-label": "Layers" });
                for (const l of model.layers) {
                    const b = h("button", {
                        type: "button",
                        class: "i3d-layer-btn",
                        "data-entity": l.id,
                        "aria-pressed": this.selected === l.id ? "true" : "false",
                        text: `L${l.layer} · ${l.events} ev · ${fmtRate(l.ratePerSec)}`,
                    });
                    b.addEventListener("click", () => this.select(l.id));
                    layers.append(h("li", {}, b));
                }
                li.append(layers);
            }
            items.push(li);
        }
        this.rail.replaceChildren(...items);
        if (!model.hasLayers) {
            this.rail.append(h("li", { class: "i3d-stage-absent muted small", text: "Layers: not reported (see Capabilities)" }));
        }
    }

    private renderOutput(model: PipelineModel, input: Inference3DInput): void {
        const chunks = model.chunks.slice(-MAX_OUTPUT_ROWS).reverse();
        if (chunks.length === 0) {
            this.output.replaceChildren(h("p", { class: "muted small", text: "No output events at the cursor." }));
            return;
        }
        const withheld = chunks.some((c) => c.textWithheld) || chunks.every((c) => c.text === null);
        const reqById = new Map(model.requests.map((r) => [r.id, r]));
        const list = h(
            "ol",
            { class: "i3d-output-list", "aria-label": "Latest output events, newest first" },
            ...chunks.map((c) => {
                const r = c.requestEntityId ? reqById.get(c.requestEntityId) : undefined;
                const btn = h(
                    "button",
                    { type: "button", class: "i3d-output-row", "data-entity": c.id },
                    h("span", { class: "i3d-output-req", text: `${r?.requestId ?? "no request"} #${c.index ?? "?"}` }),
                    h("span", { class: "i3d-output-meta", text: `${c.unit} · ${fmtBytes(c.bytes)} · ${fmtMs(c.elapsedMs)} · ${input.relativeTime(c.ns)}` }),
                    c.text !== null ? h("span", { class: "i3d-output-text", text: JSON.stringify(c.text) }) : null,
                );
                btn.addEventListener("click", () => this.select(c.id));
                return h("li", {}, btn);
            }),
        );
        const note = withheld
            ? h("p", { class: "muted small", text: "Text is not shown: the producer's text capture policy does not allow it (sizes and timing only)." })
            : null;
        const chunkOnly = chunks.every((c) => c.tokens === null);
        this.output.replaceChildren(
            ...nodes(
                list,
                note,
                chunkOnly
                    ? h("p", {
                          class: "muted small",
                          text: "Unit chunk: a backend-streamed piece of text; its token count is not reported (see backend completion tokens on the request).",
                      })
                    : null,
            ),
        );
    }

    private renderProbabilities(model: PipelineModel): void {
        const latest = model.tokens.at(-1);
        if (!latest) {
            const reasons = this.reasonFor(model, "probabilities");
            this.probabilities.replaceChildren(
                h(
                    "div",
                    { class: "i3d-unavailable", "data-panel": "probabilities" },
                    h("strong", { text: "Not available." }),
                    h(
                        "ul",
                        {},
                        ...(reasons.length > 0 ? reasons : [{ text: "no token event with a probability at the cursor", status: "unavailable" as const }]).map(
                            (r) => h("li", {}, ...richText(r.text)),
                        ),
                    ),
                ),
            );
            return;
        }
        const bar = (label: string, p: number, testid: string) =>
            h(
                "li",
                { class: "i3d-prob", "data-testid": testid },
                h("span", { class: "i3d-prob-label", text: label }),
                h(
                    "span",
                    { class: "i3d-prob-bar", "aria-hidden": "true" },
                    h("span", { class: "i3d-prob-fill", style: `width:${Math.round(Math.min(1, Math.max(0, p)) * 100)}%` }),
                ),
                h("span", { class: "i3d-prob-value", text: p.toFixed(3) }),
            );
        const tokenLabel = latest.text !== null ? JSON.stringify(latest.text) : latest.tokenId !== null ? `token ${latest.tokenId}` : "sampled token";
        const alternatives = latest.alternatives;
        const altReasons = this.reasonFor(model, "alternatives");
        const btn = h("button", { type: "button", class: "link-button", "data-entity": latest.id, text: `Token #${latest.index ?? "?"}: ${tokenLabel}` });
        btn.addEventListener("click", () => this.select(latest.id));
        this.probabilities.replaceChildren(
            ...nodes(
                btn,
                latest.probability !== null
                    ? h("ul", { class: "i3d-prob-list", "aria-label": "Sampled token probability" }, bar("probability", latest.probability, "prob-sampled"))
                    : null,
                latest.probability !== null
                    ? h("p", { class: "muted small", text: `log-probability ${Math.log(latest.probability).toFixed(3)} (derived: ln p)` })
                    : null,
                h("h4", { text: "Top alternatives" }),
                alternatives
                    ? h(
                          "ol",
                          { class: "i3d-prob-list", "aria-label": "Top alternatives" },
                          ...alternatives
                              .slice(0, 5)
                              .map((a, i) =>
                                  bar(
                                      a.text !== null ? JSON.stringify(a.text) : a.tokenId !== null ? `token ${a.tokenId}` : "?",
                                      a.probability,
                                      `prob-alt-${i}`,
                                  ),
                              ),
                      )
                    : h(
                          "div",
                          { class: "i3d-unavailable", "data-panel": "alternatives" },
                          h("strong", { text: "Not available. " }),
                          ...richText(altReasons[0]?.text ?? "the producer does not report alternatives"),
                      ),
            ),
        );
    }

    private renderLegend(model: PipelineModel): void {
        const item = (swatch: string, text: string) => h("li", {}, h("span", { class: `swatch i3d-sw ${swatch}`, "aria-hidden": "true" }), text);
        const stageNames = model.stages.map((s) => s.label).join(" → ");
        this.legend.replaceChildren(
            ...nodes(
                item("i3d-sw-depth", `Depth, left to right: ${stageNames}`),
                item("i3d-sw-lane", "Row: one model on one node; bands group nodes"),
                item("i3d-sw-active", "Sphere: an inference request in flight"),
                item("i3d-sw-runtime", "Sphere: a Runtime turn in flight; line to the inference request it caused"),
                item("i3d-sw-completed", "Completed request"),
                item("i3d-sw-failed", "Failed request"),
                item("i3d-sw-cancelled", "Cancelled request"),
                item("i3d-sw-size", "Sphere size: backend-reported tokens (completion, else prompt; smallest when not reported)"),
                item("i3d-sw-chunk", "Small point: a sampled output event; size = bytes; drifts to Output and fades over 8 s"),
                item("i3d-sw-pulse", "Plane outline pulse: stage event rate over the last 5 s (steady when idle or with reduced motion)"),
                item("i3d-sw-age", "Opacity: age since the request finished (fades over 60 s)"),
                item("i3d-sw-kv", "Box: logical KV pool per producer; fill = blocks in use / total (amber high, red critical)"),
                model.hasLayers ? item("i3d-sw-layer", "Thin planes L0…Ln: backend.layer.* events; brightness = activation RMS when reported") : null,
                model.operators.length > 0 ? item("i3d-sw-op", "Cube above a layer: backend.operator.* (purple attention, cyan MLP, grey other)") : null,
                model.tokens.some((t) => t.alternatives)
                    ? item("i3d-sw-prob", "Bars beside Output: top alternatives of the latest token (length = probability)")
                    : null,
                item("i3d-sw-selected", "Outline cube: the selected entity"),
            ),
        );
    }

    private renderSummary(model: PipelineModel): void {
        const active = model.requests.filter((r) => r.state === "active").length;
        const text =
            `${model.lanes.length} lane(s) on ${model.nodes.length} node(s); ${active} request(s) in flight, ` +
            model.stages.map((s) => `${s.label} ${s.requests}`).join(", ") +
            `; ${model.chunks.length} recent output event(s); ${model.kvPools.length} KV pool(s)` +
            (model.hasLayers ? `; ${model.layers.length} layer plane(s)` : "; layer internals not reported") +
            (model.omittedFinished > 0 ? `; ${model.omittedFinished} older finished request(s) not drawn` : "") +
            ". The table below lists every entity.";
        if (this.summary.textContent !== text) {
            this.summary.textContent = text;
            this.canvas.setAttribute("aria-label", `3D inference pipeline: ${model.stages.map((s) => s.label).join(", ")}`);
        }
    }

    private entityRows(model: PipelineModel, input: Inference3DInput): Map<string, EntityRow> {
        const rows = new Map<string, EntityRow>();
        const add = (r: EntityRow) => rows.set(r.id, r);
        for (const s of model.stages) {
            if (s.id === "layers") {
                continue;
            }
            add({
                id: `stage:${s.id}`,
                kind: "stage",
                label: s.label,
                where: "pipeline",
                state: `${s.requests} ${s.id === "output" ? "finished" : "in flight"}`,
                measures: `${s.events} events · ${fmtRate(s.ratePerSec)}`,
                evidence: s.evidence,
            });
        }
        for (const l of model.layers) {
            add({
                id: l.id,
                kind: "layer",
                label: `L${l.layer}${l.layerCount !== null ? ` of ${l.layerCount}` : ""}`,
                where: streamLabel(l.stream),
                state: fmtRate(l.ratePerSec),
                measures: [
                    `${l.events} events`,
                    l.lastDurationMs !== null ? `last ${l.lastDurationMs.toFixed(2)} ms` : "",
                    l.activationRms !== null ? `activation RMS ${l.activationRms.toFixed(2)}` : "",
                    l.attentionEntropy !== null ? `attention entropy ${l.attentionEntropy.toFixed(2)}` : "",
                ]
                    .filter(Boolean)
                    .join(" · "),
                evidence: l.evidence,
            });
        }
        for (const o of model.operators) {
            add({
                id: o.id,
                kind: "operator",
                label: `${o.operator}${o.layer !== null ? ` @ L${o.layer}` : ""}`,
                where: streamLabel(o.stream),
                state: fmtRate(o.ratePerSec),
                measures: `${o.events} events · ${o.totalDurationMs.toFixed(2)} ms total`,
                evidence: o.evidence,
            });
        }
        for (const r of model.requests) {
            const tokens =
                r.completionTokens !== null
                    ? `${r.completionTokens} completion tokens (backend)`
                    : r.promptTokens !== null
                      ? `${r.promptTokens} prompt tokens`
                      : "tokens not reported yet";
            add({
                id: r.id,
                kind: r.role === "runtime" ? "runtime turn" : "request",
                label: r.requestId,
                where: `${r.model} @ ${r.nodeId}`,
                state: `${r.state} · ${STAGES.find((s) => s.id === r.stage)!.label}`,
                measures: `${tokens} · ${r.outputEvents} output events · started ${input.relativeTime(r.startNs)}`,
                evidence: r.evidence,
            });
        }
        for (const k of model.kvPools) {
            const frac = k.totalBlocks ? ` of ${k.totalBlocks}` : "";
            add({
                id: k.id,
                kind: "KV pool",
                label: streamLabel(k.stream),
                where: k.nodeId,
                state: k.level ?? "no pressure report",
                measures: `${k.usedBlocks}${frac} blocks in use${k.occupancy !== null ? ` · occupancy ${(k.occupancy * 100).toFixed(0)}%` : ""} · ${k.reusedTokens} reused tokens`,
                evidence: k.evidence,
            });
        }
        for (const c of model.chunks.slice(-MAX_CHUNK_ROWS)) {
            add({
                id: c.id,
                kind: "output",
                label: `#${c.index ?? "?"}`,
                where: c.requestEntityId?.split("|").pop() ?? "no request",
                state: c.unit,
                measures: `${fmtBytes(c.bytes)} · ${fmtMs(c.elapsedMs)}`,
                evidence: [c.eventId],
            });
        }
        const latest = model.tokens.at(-1);
        if (latest) {
            add({
                id: latest.id,
                kind: "token",
                label: `#${latest.index ?? "?"}`,
                where: latest.requestEntityId?.split("|").pop() ?? "no request",
                state: latest.probability !== null ? `p ${latest.probability.toFixed(3)}` : "no probability",
                measures: latest.alternatives ? `${latest.alternatives.length} alternatives` : "no alternatives",
                evidence: latest.candidatesEventId ? [latest.eventId, latest.candidatesEventId] : [latest.eventId],
            });
        }
        return rows;
    }

    private renderTable(): void {
        const rows = [...this.rows.values()];
        if (rows.length === 0) {
            this.table.replaceChildren(h("p", { class: "muted small", text: "No entities at the cursor." }));
            return;
        }
        const hadFocus = this.table.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.entity : undefined;
        const tbody = h("tbody");
        for (const r of rows) {
            const btn = h("button", {
                type: "button",
                class: "link",
                "data-entity": r.id,
                "aria-pressed": r.id === this.selected ? "true" : "false",
                text: r.label,
            });
            btn.addEventListener("click", () => this.select(r.id));
            tbody.append(
                h(
                    "tr",
                    { class: r.id === this.selected ? "selected" : "", "data-entity-row": r.id },
                    h("td", { text: r.kind }),
                    h("td", {}, btn),
                    h("td", { text: r.where }),
                    h("td", { text: r.state }),
                    h("td", { text: r.measures }),
                    h("td", { class: "mono", text: String(r.evidence.length) }),
                ),
            );
        }
        this.table.replaceChildren(
            h(
                "table",
                { class: "i3d-table" },
                h("caption", { class: "sr-only", text: "Every entity drawn in the 3D scene; select one to inspect its evidence" }),
                h("thead", {}, h("tr", {}, ...["Kind", "Entity", "Where", "State", "Measures", "Evidence"].map((t) => h("th", { scope: "col", text: t })))),
                tbody,
            ),
        );
        if (hadFocus) {
            this.table.querySelector<HTMLElement>(`[data-entity="${CSS.escape(hadFocus)}"]`)?.focus();
        }
    }

    private renderSelection(): void {
        const row = this.selected ? this.rows.get(this.selected) : undefined;
        if (!this.selected) {
            this.selection.replaceChildren(
                h("p", { class: "muted small", text: "Select an entity in the scene or the table to open its evidence in the Inspector." }),
            );
            return;
        }
        if (!row) {
            this.selection.replaceChildren(h("p", { class: "muted small", text: "The selected entity does not exist at the replay cursor." }));
            return;
        }
        const evidence = [...row.evidence].reverse().slice(0, 12);
        this.selection.replaceChildren(
            h("p", {}, h("strong", { text: `Selected ${row.kind} ${row.label}` }), ` · ${row.where} · ${row.state} · ${row.measures}`),
            h(
                "ul",
                { class: "related i3d-evidence", "aria-label": "Evidence events, newest first" },
                ...evidence.map((id) => {
                    const e = this.byId.get(id);
                    const b = h("button", { type: "button", class: "link", text: e ? `${e.event_type} · ${id}` : id });
                    b.addEventListener("click", () => e && this.cb.onInspect(e));
                    return h("li", {}, b);
                }),
            ),
        );
    }

    private renderFallback(model: PipelineModel): void {
        const stages = model.stages.filter((s) => s.id !== "layers");
        const table = h(
            "table",
            { class: "i3d-table i3d-fallback-table" },
            h("caption", { text: "Requests per lane and stage at the cursor" }),
            h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Lane" }), ...stages.map((s) => h("th", { scope: "col", text: s.label })))),
            h(
                "tbody",
                {},
                ...model.lanes.map((l) =>
                    h(
                        "tr",
                        {},
                        h("th", { scope: "row", text: `${l.model} @ ${l.nodeId}` }),
                        ...stages.map((s) => {
                            const reqs = model.requests.filter((r) => r.laneKey === l.key && r.stage === s.id);
                            return h("td", { text: reqs.length === 0 ? "—" : reqs.map((r) => `${r.requestId} (${r.state})`).join(", ") });
                        }),
                    ),
                ),
            ),
        );
        this.fallback.replaceChildren(table);
    }

    private placeLabels(labels: ProjectedLabel[]): void {
        const stamp = labels.map((l) => `${l.id}:${Math.round(l.x)},${Math.round(l.y)},${l.visible}`).join("|");
        if (stamp === this.labelStamp) {
            return;
        }
        this.labelStamp = stamp;
        this.labels.replaceChildren(
            ...labels
                .filter((l) => l.visible)
                .map((l) =>
                    h("span", {
                        class: `i3d-label i3d-label-${l.kind}`,
                        style: `transform: translate(${Math.round(l.x)}px, ${Math.round(l.y)}px)`,
                        text: l.text,
                    }),
                ),
        );
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
