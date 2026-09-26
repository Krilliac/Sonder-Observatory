/**
 * Pure helpers for stepping through a session: next/previous error, the
 * producers present, and the text alternative for the timeline.
 */
import type { ObservatoryEvent } from "../protocol/events";
import { isSyntheticProducer } from "../recording/sobs";

/**
 * Index of the next (dir 1) or previous (dir -1) event matching `predicate`,
 * starting at `start` inclusive and moving in `dir`; -1 when there is none.
 */
export function findMatching(
    events: readonly ObservatoryEvent[],
    start: number,
    dir: 1 | -1,
    predicate: (e: ObservatoryEvent) => boolean,
): number {
    for (let i = start; i >= 0 && i < events.length; i += dir) {
        if (predicate(events[i]!)) {
            return i;
        }
    }
    return -1;
}

/**
 * Where error navigation starts: just after/before the selected event when
 * there is one, otherwise at the replay cursor (`visibleCount` events are at
 * or before it).
 */
export function errorSearchStart(selectedIndex: number, visibleCount: number, dir: 1 | -1): number {
    if (selectedIndex >= 0) {
        return selectedIndex + dir;
    }
    return dir === 1 ? visibleCount : visibleCount - 1;
}

export interface ProducerSummary {
    name: string;
    role: string | null;
    synthetic: boolean;
    events: number;
}

const summaryCache = new WeakMap<readonly ObservatoryEvent[], ProducerSummary[]>();

/** Producers present in a session (by producer.name), cached per events array. */
export function producersInSession(events: readonly ObservatoryEvent[]): ProducerSummary[] {
    const cached = summaryCache.get(events);
    if (cached) {
        return cached;
    }
    const byName = new Map<string, ProducerSummary>();
    for (const e of events) {
        const name = e.producer.name;
        let s = byName.get(name);
        if (!s) {
            s = { name, role: null, synthetic: false, events: 0 };
            byName.set(name, s);
        }
        s.events += 1;
        if (s.role === null && typeof e.producer.role === "string") {
            s.role = e.producer.role;
        }
        if (isSyntheticProducer(e.producer)) {
            s.synthetic = true;
        }
    }
    const out = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    summaryCache.set(events, out);
    return out;
}

/** "a", "a and b", "a, b and c" */
export function listText(items: readonly string[]): string {
    if (items.length <= 1) {
        return items[0] ?? "";
    }
    return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function syntheticBannerText(syntheticProducers: readonly string[]): string {
    const who = syntheticProducers.length > 0 ? ` from ${listText(syntheticProducers)}` : "";
    return (
        `Synthetic data${who}: these events are labelled synthetic by their producer (a fixture script, ` +
        `a fake producer or a mock backend). They were not measured from a real model; values illustrate the viewer only.`
    );
}

export interface TimelineSummaryInput {
    total: number;
    visible: number;
    cursorSeconds: number;
    durationSeconds: number;
    /** Event count per class, in track order. */
    classCounts: readonly (readonly [string, number])[];
    errors: number;
    requests: number;
    selected: { eventType: string; producer: string; seconds: number } | null;
}

/** Text alternative for the canvas/SVG timeline (#timeline-summary). */
export function timelineSummaryText(s: TimelineSummaryInput): string {
    if (s.total === 0) {
        return "Timeline: no events yet.";
    }
    const classes = s.classCounts.filter(([, n]) => n > 0).map(([c, n]) => `${c} ${n}`);
    const parts = [
        `Timeline: ${s.total} events over ${s.durationSeconds.toFixed(3)} s; cursor at ${s.cursorSeconds.toFixed(3)} s with ${s.visible} events at or before it.`,
        `By class: ${classes.join(", ")}.`,
        `${s.requests} request span(s), ${s.errors} error event(s).`,
    ];
    if (s.selected) {
        parts.push(`Selected: ${s.selected.eventType} from ${s.selected.producer} at ${s.selected.seconds.toFixed(3)} s.`);
    }
    return parts.join(" ");
}
