/**
 * Canvas timeline drawing from level-of-detail buckets (timelineModel.ts).
 *
 * The number of draw calls is bounded by tracks x plot width (plus request
 * spans, the selected event and evidence events), independent of how many
 * events the session holds. `drawTimeline` only needs the small subset of
 * CanvasRenderingContext2D declared in `TimelineContext`, so tests can pass a
 * recording fake instead of a real canvas.
 */
import type { RequestSpan } from "../query/metrics";
import { eventPosition, TRACKS, type Buckets, type EventIndex } from "./timelineModel";

export interface TimelineContext {
    fillStyle: string | CanvasGradient | CanvasPattern;
    strokeStyle: string | CanvasGradient | CanvasPattern;
    globalAlpha: number;
    lineWidth: number;
    font: string;
    textBaseline: CanvasTextBaseline;
    fillRect(x: number, y: number, w: number, h: number): void;
    strokeRect(x: number, y: number, w: number, h: number): void;
    clearRect(x: number, y: number, w: number, h: number): void;
    fillText(text: string, x: number, y: number): void;
    beginPath(): void;
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    stroke(): void;
    setLineDash(segments: number[]): void;
}

export interface TimelinePalette {
    background: string;
    trackBg: string;
    label: string;
    cursor: string;
    selected: string;
    evidence: string;
    span: string;
    spanFailed: string;
    /** Colour per TRACKS entry. */
    tracks: readonly string[];
}

/** Fallbacks match styles.css (.cls-* and timeline rules). */
export const DEFAULT_PALETTE: TimelinePalette = {
    background: "#0f1726",
    trackBg: "#070b14",
    label: "#8a9ab3",
    cursor: "#e6edf7",
    selected: "#ffffff",
    evidence: "#f59e0b",
    span: "#3b82f6",
    spanFailed: "#ef4444",
    tracks: ["#8a9ab3", "#3b82f6", "#22d3ee", "#a855f7", "#10b981", "#f59e0b", "#ef4444", "#c0c8d6", "#6b7a90"],
};

export interface TimelineGeometry {
    width: number;
    labelW: number;
    rowH: number;
    padTop: number;
    /** Plot width in CSS pixels (one bucket column per pixel). */
    plotW: number;
    height: number;
}

export function timelineGeometry(width: number, rowH = 20, labelW = 84): TimelineGeometry {
    const w = Math.max(Math.floor(width), 320);
    const plotW = Math.max(1, w - labelW - 8);
    return { width: w, labelW, rowH, padTop: 4, plotW, height: TRACKS.length * rowH + 8 };
}

export interface DrawTimelineInput {
    geometry: TimelineGeometry;
    index: EventIndex;
    buckets: Buckets;
    /** Cursor position relative to the first event (ns). */
    cursorRel: number;
    requests: readonly RequestSpan[];
    selectedId: string | null;
    highlighted: ReadonlySet<string>;
    palette?: TimelinePalette;
    /** Upper bound on individually drawn evidence ticks. */
    maxEvidence?: number;
}

export interface DrawStats {
    tickRects: number;
    spanRects: number;
    evidenceRects: number;
}

export function drawTimeline(ctx: TimelineContext, input: DrawTimelineInput): DrawStats {
    const { geometry: g, index, buckets, cursorRel } = input;
    const p = input.palette ?? DEFAULT_PALETTE;
    const { t0, t1 } = buckets;
    const span = Math.max(t1 - t0, 1);
    const xOf = (rel: number) => g.labelW + ((rel - t0) / span) * g.plotW;
    const rowY = (row: number) => g.padTop + row * g.rowH;
    const stats: DrawStats = { tickRects: 0, spanRects: 0, evidenceRects: 0 };

    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.clearRect(0, 0, g.width, g.height);
    ctx.fillStyle = p.background;
    ctx.fillRect(0, 0, g.width, g.height);
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    TRACKS.forEach((cls, row) => {
        const y = rowY(row);
        ctx.fillStyle = p.trackBg;
        ctx.fillRect(g.labelW, y + 1, g.plotW, g.rowH - 2);
        ctx.fillStyle = p.label;
        ctx.fillText(cls, 4, y + g.rowH / 2);
    });

    // Request spans (merged when several fall into the same pixel column).
    const reqRow = TRACKS.indexOf("request");
    const cursorAbs = index.originNs + cursorRel;
    let lastX = -1;
    let lastOutcome = "";
    ctx.lineWidth = 0.5;
    for (const r of input.requests) {
        const x1 = xOf(r.startNs - index.originNs);
        const x2 = xOf((r.endNs ?? cursorAbs) - index.originNs);
        if (x2 < g.labelW || x1 > g.labelW + g.plotW) {
            continue;
        }
        const px = Math.floor(x1);
        if (x2 - x1 < 1 && px === lastX && r.outcome === lastOutcome) {
            continue;
        }
        lastX = px;
        lastOutcome = r.outcome;
        const color = r.outcome === "failed" ? p.spanFailed : p.span;
        const y = rowY(reqRow) + 4;
        const w = Math.max(x2 - x1, 1);
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = color;
        ctx.fillRect(x1, y, w, g.rowH - 8);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = color;
        ctx.setLineDash(r.outcome === "open" ? [3, 2] : []);
        ctx.strokeRect(x1, y, w, g.rowH - 8);
        stats.spanRects += 1;
    }
    ctx.setLineDash([]);

    // Bucketed ticks: one rect per non-empty (track, column), shaded by density.
    const { counts, maxPerTrack, width: cols } = buckets;
    const colW = g.plotW / cols;
    for (let track = 0; track < TRACKS.length; track += 1) {
        const max = maxPerTrack[track]!;
        if (max === 0) {
            continue;
        }
        const logMax = Math.log1p(max);
        ctx.fillStyle = p.tracks[track] ?? p.label;
        const y = rowY(track) + 3;
        const base = track * cols;
        for (let col = 0; col < cols; col += 1) {
            const c = counts[base + col]!;
            if (c === 0) {
                continue;
            }
            ctx.globalAlpha = max === 1 ? 1 : 0.45 + 0.55 * (Math.log1p(c) / logMax);
            ctx.fillRect(g.labelW + col * colW, y, Math.max(colW, 1.5), g.rowH - 6);
            stats.tickRects += 1;
        }
    }
    ctx.globalAlpha = 1;

    // Events after the cursor are dimmed with one overlay instead of per-tick state.
    const cx = Math.min(Math.max(xOf(cursorRel), g.labelW), g.labelW + g.plotW);
    if (cx < g.labelW + g.plotW) {
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = p.trackBg;
        ctx.fillRect(cx, 0, g.labelW + g.plotW - cx, g.height);
        ctx.globalAlpha = 1;
    }

    // Evidence and the selected event are always drawn individually.
    const drawEvent = (pos: number, color: string, w: number) => {
        const rel = index.rel[pos]!;
        if (rel < t0 || rel > t1) {
            return false;
        }
        ctx.fillStyle = color;
        ctx.fillRect(xOf(rel) - w / 2, rowY(index.cls[pos]!) + 3, w, g.rowH - 6);
        return true;
    };
    const maxEvidence = input.maxEvidence ?? 2000;
    for (const id of input.highlighted) {
        if (stats.evidenceRects >= maxEvidence) {
            break;
        }
        const pos = eventPosition(index, id);
        if (pos >= 0 && drawEvent(pos, p.evidence, 2)) {
            stats.evidenceRects += 1;
        }
    }
    if (input.selectedId) {
        const pos = eventPosition(index, input.selectedId);
        if (pos >= 0) {
            drawEvent(pos, p.selected, 3);
        }
    }

    ctx.strokeStyle = p.cursor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx + 0.5, 0);
    ctx.lineTo(cx + 0.5, g.height);
    ctx.stroke();
    return stats;
}
