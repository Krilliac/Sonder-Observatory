/**
 * Event-range selection for exports. Mirrors the renderer's event-table
 * filter (class + lower-case substring over type / id / request / agent) and
 * adds an optional replay-time window, so "export what I am looking at" and
 * "export the whole session" use the same code path.
 */
import type { ObservatoryEvent } from "../protocol/events";
import { classifyEvent, type EventClass } from "../query/classify";

export interface ExportRange {
    /** Event class, or "all" (default). */
    cls?: EventClass | "all";
    /** Case-insensitive substring over event type, id, request id and agent id. */
    text?: string;
    /** Inclusive lower bound, producer mono_ns. */
    fromNs?: number | null;
    /** Inclusive upper bound, producer mono_ns (for example the replay cursor). */
    toNs?: number | null;
}

function haystack(e: ObservatoryEvent): string {
    return `${e.event_type} ${e.event_id} ${e.request_id ?? ""} ${e.agent_id ?? ""}`.toLowerCase();
}

function finiteBound(ns: number | null | undefined): number | null {
    return typeof ns === "number" && Number.isFinite(ns) ? ns : null;
}

export function isFullRange(range: ExportRange = {}): boolean {
    return (
        (range.cls ?? "all") === "all" &&
        (range.text ?? "").trim() === "" &&
        finiteBound(range.fromNs) === null &&
        finiteBound(range.toNs) === null
    );
}

/**
 * Returns the events (in their given replay order) that fall inside `range`.
 * Never mutates or copies events; returns the input array itself for a full range.
 */
export function filterEvents(events: readonly ObservatoryEvent[], range: ExportRange = {}): readonly ObservatoryEvent[] {
    if (isFullRange(range)) {
        return events;
    }
    const cls = range.cls ?? "all";
    const text = (range.text ?? "").trim().toLowerCase();
    const from = finiteBound(range.fromNs) ?? -Infinity;
    const to = finiteBound(range.toNs) ?? Infinity;
    return events.filter(
        (e) =>
            Number.isFinite(e.mono_ns) &&
            e.mono_ns >= from &&
            e.mono_ns <= to &&
            (cls === "all" || classifyEvent(e) === cls) &&
            (text === "" || haystack(e).includes(text)),
    );
}

/** Human-readable description of a range, e.g. "class=error · text=\"tool\" · 1.000 s–4.000 s". */
export function describeRange(range: ExportRange, originNs: number): string {
    if (isFullRange(range)) {
        return "full session";
    }
    const origin = Number.isFinite(originNs) ? originNs : 0;
    const from = finiteBound(range.fromNs);
    const to = finiteBound(range.toNs);
    const parts: string[] = [];
    if ((range.cls ?? "all") !== "all") {
        parts.push(`class=${range.cls}`);
    }
    if ((range.text ?? "").trim() !== "") {
        parts.push(`text="${(range.text ?? "").trim()}"`);
    }
    if (from !== null || to !== null) {
        const f = from !== null ? `${((from - origin) / 1e9).toFixed(3)} s` : "start";
        const t = to !== null ? `${((to - origin) / 1e9).toFixed(3)} s` : "end";
        parts.push(`${f}–${t}`);
    }
    return parts.join(" · ");
}
