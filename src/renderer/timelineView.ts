/**
 * Timeline view with two render paths that share one model (timelineModel.ts):
 *
 * - Small sessions (up to SVG_MAX_EVENTS) render as SVG, one DOM tick per
 *   (track, pixel column) as before: inspectable, and it keeps the existing
 *   DOM contract used by the e2e suite (rect.tick, line.cursor-line, ...).
 * - Large sessions render to a single <canvas> from cached level-of-detail
 *   buckets (TimelineLod). Scrubbing only moves the cursor, so a frame redraws
 *   from cached buckets in O(tracks x width) regardless of the event count.
 */
import type { ObservatoryEvent } from "../protocol/events";
import type { RequestSpan } from "../query/metrics";
import { h, svg } from "./dom";
import { DEFAULT_PALETTE, drawTimeline, timelineGeometry, type TimelineGeometry, type TimelinePalette } from "./timelineCanvas";
import { getEventIndex, nearestInTrack, TimelineLod, TRACKS, type EventIndex } from "./timelineModel";

/** Sessions up to this size keep the SVG renderer; larger ones use canvas. */
export const SVG_MAX_EVENTS = 2_000;

export interface TimelineRenderState {
    events: readonly ObservatoryEvent[];
    cursorRel: number;
    requests: readonly RequestSpan[];
    selectedId: string | null;
    highlighted: ReadonlySet<string>;
}

export interface TimelineClick {
    /** Relative time under the pointer (ns). */
    rel: number;
    /** Nearest event in the clicked track within 1% of the duration, if any. */
    event: ObservatoryEvent | undefined;
}

export type TimelineMode = "svg" | "canvas";

export class TimelineView {
    private readonly canvas: HTMLCanvasElement;
    private readonly lod = new TimelineLod();
    private palette: TimelinePalette | null = null;
    private geometry: TimelineGeometry | null = null;
    private index: EventIndex | null = null;
    private mode: TimelineMode | null = null;

    constructor(
        private readonly container: HTMLElement,
        private readonly onClick: (click: TimelineClick) => void,
    ) {
        this.canvas = h("canvas", {
            role: "img",
            "aria-label": "Event timeline by class",
            "aria-describedby": "timeline-summary",
            class: "timeline-canvas",
        });
        this.canvas.addEventListener("click", (ev) => this.handleClick(ev, this.canvas));
    }

    get currentMode(): TimelineMode | null {
        return this.mode;
    }

    /** Re-reads the colours on the next canvas frame (after a theme change). */
    invalidatePalette(): void {
        this.palette = null;
    }

    render(state: TimelineRenderState): void {
        const geometry = timelineGeometry(this.container.clientWidth);
        const index = getEventIndex(state.events);
        this.geometry = geometry;
        this.index = index;
        if (state.events.length <= SVG_MAX_EVENTS) {
            this.mode = "svg";
            this.renderSvg(state, geometry, index);
        } else {
            if (this.mode !== "canvas") {
                this.container.replaceChildren(this.canvas);
            }
            this.mode = "canvas";
            this.renderCanvas(state, geometry, index);
        }
    }

    private renderCanvas(state: TimelineRenderState, geometry: TimelineGeometry, index: EventIndex): void {
        const canvas = this.canvas;
        const dpr = Math.max(1, Math.min(globalThis.devicePixelRatio || 1, 3));
        const pxW = Math.round(geometry.width * dpr);
        const pxH = Math.round(geometry.height * dpr);
        if (canvas.width !== pxW || canvas.height !== pxH) {
            canvas.width = pxW;
            canvas.height = pxH;
            canvas.style.width = `${geometry.width}px`;
            canvas.style.height = `${geometry.height}px`;
        }
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            return;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const buckets = this.lod.get(index, geometry.plotW, 0, Math.max(index.durationNs, 1));
        const stats = drawTimeline(ctx, {
            geometry,
            index,
            buckets,
            cursorRel: state.cursorRel,
            requests: state.requests,
            selectedId: state.selectedId,
            highlighted: state.highlighted,
            palette: this.readPalette(),
        });
        canvas.dataset.ticks = String(stats.tickRects);
    }

    /** SVG path for small sessions (same markup and classes as before feat/perf). */
    private renderSvg(state: TimelineRenderState, g: TimelineGeometry, index: EventIndex): void {
        const { width, height, labelW, rowH, plotW } = g;
        const duration = Math.max(index.durationNs, 1);
        const xOf = (rel: number) => labelW + (rel / duration) * plotW;
        const root = svg("svg", {
            width,
            height,
            viewBox: `0 0 ${width} ${height}`,
            role: "img",
            "aria-label": "Event timeline by class",
            "aria-describedby": "timeline-summary",
        });
        const cursorRel = state.cursorRel;

        TRACKS.forEach((cls, row) => {
            const y = 4 + row * rowH;
            const label = svg("text", { x: 4, y: y + rowH * 0.7, class: "track-label" });
            label.textContent = cls;
            root.append(svg("rect", { x: labelW, y: y + 1, width: plotW, height: rowH - 2, class: "track-bg" }), label);
        });

        const reqRow = TRACKS.indexOf("request");
        for (const r of state.requests) {
            const x1 = xOf(r.startNs - index.originNs);
            const x2 = xOf((r.endNs ?? index.originNs + cursorRel) - index.originNs);
            root.append(svg("rect", { x: x1, y: 4 + reqRow * rowH + 4, width: Math.max(x2 - x1, 1), height: rowH - 8, class: `span span-${r.outcome}` }));
        }

        // One tick per (track, pixel column), plus every selected/evidence event.
        const seen = new Set<number>();
        const { events, rel, cls: clsOf } = index;
        for (let i = 0; i < events.length; i += 1) {
            const e = events[i]!;
            const t = rel[i]!;
            const row = clsOf[i]!;
            const x = Math.round(xOf(t));
            const key = row * 100_000 + x;
            const evidence = state.highlighted.has(e.event_id);
            const selected = e.event_id === state.selectedId;
            if (seen.has(key) && !selected && !evidence) {
                continue;
            }
            seen.add(key);
            const name = TRACKS[row] ?? "other";
            root.append(
                svg("rect", {
                    x: x - 0.5,
                    y: 4 + row * rowH + 3,
                    width: selected ? 3 : 1.5,
                    height: rowH - 6,
                    class: `tick cls-${name}${t > cursorRel ? " future" : ""}${evidence ? " evidence" : ""}${selected ? " selected" : ""}`,
                }),
            );
        }

        const cx = xOf(cursorRel);
        root.append(svg("line", { x1: cx, x2: cx, y1: 0, y2: height, class: "cursor-line" }));
        root.addEventListener("click", (ev) => this.handleClick(ev as MouseEvent, root));
        this.container.replaceChildren(root);
    }

    /** Palette from the design-token CSS custom properties, read once per theme. */
    private readPalette(): TimelinePalette {
        if (this.palette) {
            return this.palette;
        }
        const css = getComputedStyle(this.container);
        const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
        const d = DEFAULT_PALETTE;
        this.palette = {
            background: v("--color-surface", d.background),
            trackBg: v("--color-background", d.trackBg),
            label: v("--color-muted", d.label),
            cursor: v("--color-text", d.cursor),
            selected: v("--color-markSelected", d.selected),
            evidence: v("--semantic-warning", d.evidence),
            span: v("--semantic-token", d.span),
            spanFailed: v("--semantic-error", d.spanFailed),
            tracks: [
                v("--color-muted", d.tracks[0]!),
                v("--semantic-token", d.tracks[1]!),
                v("--semantic-activation", d.tracks[2]!),
                v("--semantic-attention", d.tracks[3]!),
                v("--semantic-healthy", d.tracks[4]!),
                v("--semantic-warning", d.tracks[5]!),
                v("--semantic-error", d.tracks[6]!),
                v("--color-trackTelemetry", d.tracks[7]!),
                v("--color-trackOther", d.tracks[8]!),
            ],
        };
        return this.palette;
    }

    private handleClick(ev: MouseEvent, target: Element): void {
        const g = this.geometry;
        const index = this.index;
        if (!g || !index) {
            return;
        }
        const rect = target.getBoundingClientRect();
        const px = ev.clientX - rect.left;
        if (px < g.labelW) {
            return;
        }
        const duration = Math.max(index.durationNs, 1);
        const rel = Math.min(Math.max(((px - g.labelW) / g.plotW) * duration, 0), duration);
        const row = Math.floor((ev.clientY - rect.top - g.padTop) / g.rowH);
        const track = row >= 0 && row < TRACKS.length ? row : -1;
        const pos = nearestInTrack(index, rel, track, duration * 0.01);
        this.onClick({ rel, event: pos >= 0 ? index.events[pos] : undefined });
    }
}
