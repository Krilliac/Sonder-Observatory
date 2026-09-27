/**
 * Static SVG renderings for the self-contained report: the topology scene and
 * a timeline density snapshot. Output is inline-SVG markup for an HTML5
 * document (no xmlns, no external references; the only url() is the local
 * arrow marker `url(#...)`). CSS custom-property colours from the live theme
 * are resolved to their literal fallbacks so the file renders anywhere.
 */
import type { EventClass } from "../query/classify";
import { shapePath, type TopologyScene } from "../topology";
import type { TimelineSnapshot } from "./report";

/** Escapes text for HTML/SVG content and attribute values. "://" is broken up so event text can never read as a URL. */
export function esc(value: unknown): string {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
        .replace(/:\/\//g, "&#58;//");
}

/** `var(--x, #abc)` -> `#abc`; anything else unchanged. */
export function resolveColor(color: string): string {
    const m = /^var\(\s*--[\w-]+\s*,\s*([^)]+)\)$/.exec(color.trim());
    return m ? m[1]!.trim() : color;
}

const TEXT = "#E2E8F0";
const MUTED = "#94A3B8";

export const TRACK_COLORS: Record<EventClass, string> = {
    session: "#94A3B8",
    request: "#3B82F6",
    inference: "#A855F7",
    agent: "#22D3EE",
    tool: "#10B981",
    resource: "#F59E0B",
    error: "#EF4444",
    telemetry: "#64748B",
    other: "#CBD5E1",
};

function attrs(a: Record<string, string | number | undefined>): string {
    return Object.entries(a)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => ` ${k}="${esc(v)}"`)
        .join("");
}

export function renderTopologySvg(scene: TopologyScene): string {
    if (scene.nodes.length === 0) {
        return `<p class="muted">No orchestration events (agent/route/tool/memory/guard) in this range.</p>`;
    }
    const w = Math.max(scene.width, 200);
    const h = Math.max(scene.height, 120);
    const out: string[] = [];
    out.push(
        `<svg class="topology" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(
            `Topology graph: ${scene.nodes.length} nodes, ${scene.edges.length} edges`,
        )}">`,
    );
    out.push(
        `<defs><marker id="topo-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" fill="${MUTED}"/></marker></defs>`,
    );
    for (const col of scene.columns) {
        out.push(`<text${attrs({ x: col.x, y: 18, "text-anchor": "middle", fill: MUTED, "font-size": 11 })}>${esc(col.label)}</text>`);
    }
    for (const e of scene.edges) {
        out.push(
            `<g${attrs({ opacity: e.opacity })}><title>${esc(e.ariaLabel)}</title><path${attrs({
                d: e.path,
                fill: "none",
                stroke: resolveColor(e.color),
                "stroke-width": e.width,
                "stroke-dasharray": e.dash,
                "marker-end": "url(#topo-arrow)",
            })}/><text${attrs({ x: e.labelX, y: e.labelY - 4, "text-anchor": "middle", "font-size": 10, fill: TEXT })}>${esc(e.label)}</text></g>`,
        );
    }
    for (const n of scene.nodes) {
        const parts = [
            `<title>${esc(n.ariaLabel)}</title>`,
            `<path${attrs({ d: shapePath(n.shape, n.x, n.y, n.r), fill: resolveColor(n.fill), "fill-opacity": 0.85, stroke: resolveColor(n.stroke), "stroke-width": 2, "stroke-dasharray": n.dash })}/>`,
            `<text${attrs({ x: n.x, y: n.y + 4, "text-anchor": "middle", "font-size": 12, fill: "#0B1220", "font-weight": 700 })}>${esc(n.badge)}</text>`,
            `<text${attrs({ x: n.x, y: n.y + n.r + 14, "text-anchor": "middle", "font-size": 11, fill: TEXT })}>${esc(n.label)}</text>`,
        ];
        if (n.sublabel) {
            parts.push(`<text${attrs({ x: n.x, y: n.y + n.r + 27, "text-anchor": "middle", "font-size": 10, fill: MUTED })}>${esc(n.sublabel)}</text>`);
        }
        if (n.diagnosticCount > 0) {
            parts.push(
                `<text${attrs({ x: n.x + n.r, y: n.y - n.r + 4, "text-anchor": "middle", "font-size": 11, fill: "#F59E0B", "font-weight": 700 })}>⚠${n.diagnosticCount}</text>`,
            );
        }
        out.push(`<g${attrs({ opacity: n.opacity })}>${parts.join("")}</g>`);
    }
    out.push("</svg>");
    return out.join("\n");
}

/** Legend as an HTML list (kinds/statuses present in the scene). */
export function renderTopologyLegend(scene: TopologyScene): string {
    const items = scene.legend.filter((l) => l.group !== "mapping");
    if (items.length === 0) {
        return "";
    }
    return `<ul class="legend">${items
        .map((l) => {
            const swatch = l.color ? `<span class="swatch" style="background:${esc(resolveColor(l.color))}"></span>` : l.badge ? `<span class="badge">${esc(l.badge)}</span>` : "";
            return `<li>${swatch}${esc(l.label)}</li>`;
        })
        .join("")}</ul>`;
}

export function renderTimelineSvg(t: TimelineSnapshot): string {
    const labelW = 78;
    const colW = 6;
    const rowH = 16;
    const w = labelW + t.width * colW + 8;
    const h = t.tracks.length * rowH + 22;
    const out: string[] = [];
    out.push(`<svg class="timeline" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(`Timeline snapshot: ${t.total} events over ${t.durationS.toFixed(3)} s`)}">`);
    t.tracks.forEach((track, i) => {
        const y = i * rowH;
        out.push(`<text x="${labelW - 6}" y="${y + 12}" text-anchor="end" font-size="11" fill="${MUTED}">${esc(track)}</text>`);
        out.push(`<rect x="${labelW}" y="${y + 2}" width="${t.width * colW}" height="${rowH - 4}" fill="#111A2B"/>`);
        const max = t.maxPerTrack[i] ?? 0;
        const row = t.counts[i] ?? [];
        for (let c = 0; c < row.length; c += 1) {
            const n = row[c]!;
            if (n === 0 || max === 0) {
                continue;
            }
            const alpha = Math.round((0.35 + 0.65 * (n / max)) * 100) / 100;
            out.push(`<rect x="${labelW + c * colW}" y="${y + 2}" width="${colW}" height="${rowH - 4}" fill="${TRACK_COLORS[track]}" fill-opacity="${alpha}"><title>${esc(`${track}: ${n}`)}</title></rect>`);
        }
    });
    const axisY = t.tracks.length * rowH + 14;
    out.push(`<text x="${labelW}" y="${axisY}" font-size="10" fill="${MUTED}">0.000 s</text>`);
    out.push(`<text x="${labelW + t.width * colW}" y="${axisY}" text-anchor="end" font-size="10" fill="${MUTED}">${t.durationS.toFixed(3)} s</text>`);
    out.push("</svg>");
    return out.join("\n");
}
