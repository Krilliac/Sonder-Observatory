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

const SAFE_HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const SAFE_FUNC_COLOR = /^(?:rgba?|hsla?)\(\s*[0-9.%\s,/+-]+\)$/i;
const SAFE_NAMED_COLOR = /^[a-z]{3,20}$/i;
const FALLBACK_COLOR = "#94A3B8";
const MAX_TIMELINE_WIDTH = 2048;

export function isUnsafeControlCode(c: number): boolean {
    return (
        c <= 0x08 ||
        c === 0x0b ||
        c === 0x0c ||
        (c >= 0x0e && c <= 0x1f) ||
        (c >= 0x7f && c <= 0x9f) ||
        (c >= 0x202a && c <= 0x202e) ||
        (c >= 0x2066 && c <= 0x2069)
    );
}

/** Strips unsafe C0/C1 control characters (preserving tab/LF/CR) and Unicode bidi overrides. */
export function stripUnsafeControls(s: string): string {
    for (let i = 0; i < s.length; i += 1) {
        if (isUnsafeControlCode(s.charCodeAt(i))) {
            let out = s.slice(0, i);
            for (let j = i + 1; j < s.length; j += 1) {
                if (!isUnsafeControlCode(s.charCodeAt(j))) {
                    out += s[j]!;
                }
            }
            return out;
        }
    }
    return s;
}

/**
 * Escapes text for HTML/SVG content and attribute values. Control/bidi chars are
 * stripped, and URL/CSS-fetch constructs (`://`, protocol-relative `//`,
 * non-fragment `url(`, `@import`) are broken up with character references so
 * producer-controlled text renders identically without creating references.
 */
export function esc(value: unknown): string {
    return stripUnsafeControls(String(value))
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
        .replace(/:\/\//g, "&#58;&#47;/")
        .replace(/\/\//g, "&#47;/")
        .replace(/url\(\s*(?!['"]?#)/gi, (m) => `${m.slice(0, 3)}&#40;${m.slice(4)}`)
        .replace(/@import/gi, (m) => `&#64;${m.slice(1)}`);
}

/** `var(--x, #abc)` -> `#abc`; validates safe CSS color literals or falls back to neutral. */
export function resolveColor(color: string): string {
    const trimmed = color.trim();
    const m = /^var\(\s*--[\w-]+\s*,\s*(.+)\)$/.exec(trimmed);
    const candidate = (m ? m[1]! : trimmed).trim();
    if (
        !candidate.includes("//") &&
        (SAFE_HEX_COLOR.test(candidate) || SAFE_FUNC_COLOR.test(candidate) || SAFE_NAMED_COLOR.test(candidate))
    ) {
        return candidate;
    }
    return FALLBACK_COLOR;
}

export function trackColor(cls: string): string {
    return Object.hasOwn(TRACK_COLORS, cls) ? TRACK_COLORS[cls as EventClass] : TRACK_COLORS.other;
}

function finiteNum(value: number, fallback = 0): number {
    return Number.isFinite(value) ? value : fallback;
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
    const w = Math.max(finiteNum(scene.width, 200), 200);
    const h = Math.max(finiteNum(scene.height, 120), 120);
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
        out.push(`<text${attrs({ x: finiteNum(col.x), y: 18, "text-anchor": "middle", fill: MUTED, "font-size": 11 })}>${esc(col.label)}</text>`);
    }
    for (const e of scene.edges) {
        out.push(
            `<g${attrs({ opacity: finiteNum(e.opacity, 1) })}><title>${esc(e.ariaLabel)}</title><path${attrs({
                d: e.path,
                fill: "none",
                stroke: resolveColor(e.color),
                "stroke-width": finiteNum(e.width, 1),
                "stroke-dasharray": e.dash,
                "marker-end": "url(#topo-arrow)",
            })}/><text${attrs({ x: finiteNum(e.labelX), y: finiteNum(e.labelY) - 4, "text-anchor": "middle", "font-size": 10, fill: TEXT })}>${esc(e.label)}</text></g>`,
        );
    }
    for (const n of scene.nodes) {
        const nx = finiteNum(n.x);
        const ny = finiteNum(n.y);
        const nr = Math.max(1, finiteNum(n.r, 16));
        const diagCount = Number.isFinite(n.diagnosticCount) ? Math.max(0, Math.floor(n.diagnosticCount)) : 0;
        const parts = [
            `<title>${esc(n.ariaLabel)}</title>`,
            `<path${attrs({ d: shapePath(n.shape, nx, ny, nr), fill: resolveColor(n.fill), "fill-opacity": 0.85, stroke: resolveColor(n.stroke), "stroke-width": 2, "stroke-dasharray": n.dash })}/>`,
            `<text${attrs({ x: nx, y: ny + 4, "text-anchor": "middle", "font-size": 12, fill: "#0B1220", "font-weight": 700 })}>${esc(n.badge)}</text>`,
            `<text${attrs({ x: nx, y: ny + nr + 14, "text-anchor": "middle", "font-size": 11, fill: TEXT })}>${esc(n.label)}</text>`,
        ];
        if (n.sublabel) {
            parts.push(`<text${attrs({ x: nx, y: ny + nr + 27, "text-anchor": "middle", "font-size": 10, fill: MUTED })}>${esc(n.sublabel)}</text>`);
        }
        if (diagCount > 0) {
            parts.push(
                `<text${attrs({ x: nx + nr, y: ny - nr + 4, "text-anchor": "middle", "font-size": 11, fill: "#F59E0B", "font-weight": 700 })}>⚠${diagCount}</text>`,
            );
        }
        out.push(`<g${attrs({ opacity: finiteNum(n.opacity, 1) })}>${parts.join("")}</g>`);
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
    const widthCols = Math.max(1, Math.min(Math.floor(finiteNum(t.width, 1)), MAX_TIMELINE_WIDTH));
    const durationS = Math.max(0, finiteNum(t.durationS, 0));
    const total = Math.max(0, Math.floor(finiteNum(t.total, 0)));
    const w = labelW + widthCols * colW + 8;
    const h = t.tracks.length * rowH + 22;
    const out: string[] = [];
    out.push(`<svg class="timeline" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(`Timeline snapshot: ${total} events over ${durationS.toFixed(3)} s`)}">`);
    t.tracks.forEach((track, i) => {
        const y = i * rowH;
        const color = trackColor(track);
        out.push(`<text x="${labelW - 6}" y="${y + 12}" text-anchor="end" font-size="11" fill="${MUTED}">${esc(track)}</text>`);
        out.push(`<rect x="${labelW}" y="${y + 2}" width="${widthCols * colW}" height="${rowH - 4}" fill="#111A2B"/>`);
        const max = finiteNum(t.maxPerTrack[i] ?? 0, 0);
        const row = t.counts[i] ?? [];
        const cols = Math.min(row.length, widthCols);
        for (let c = 0; c < cols; c += 1) {
            const n = finiteNum(row[c] ?? 0, 0);
            if (n <= 0 || max <= 0) {
                continue;
            }
            const alpha = Math.round((0.35 + 0.65 * Math.min(1, n / max)) * 100) / 100;
            out.push(`<rect x="${labelW + c * colW}" y="${y + 2}" width="${colW}" height="${rowH - 4}" fill="${color}" fill-opacity="${alpha}"><title>${esc(`${track}: ${n}`)}</title></rect>`);
        }
    });
    const axisY = t.tracks.length * rowH + 14;
    out.push(`<text x="${labelW}" y="${axisY}" font-size="10" fill="${MUTED}">0.000 s</text>`);
    out.push(`<text x="${labelW + widthCols * colW}" y="${axisY}" text-anchor="end" font-size="10" fill="${MUTED}">${durationS.toFixed(3)} s</text>`);
    out.push("</svg>");
    return out.join("\n");
}
