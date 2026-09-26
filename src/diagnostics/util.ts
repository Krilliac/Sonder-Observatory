import type { ObservatoryEvent } from "../protocol/events";
import { compareEvents } from "../replay/order";
import type { Finding, FindingKind, Severity } from "./types";

export const NS_PER_MS = 1_000_000;

export function sortEvents(events: readonly ObservatoryEvent[]): ObservatoryEvent[] {
    return [...events].sort(compareEvents);
}

export function num(event: ObservatoryEvent, ...keys: string[]): number | null {
    for (const key of keys) {
        const v = event.attributes[key];
        if (typeof v === "number" && Number.isFinite(v)) {
            return v;
        }
    }
    return null;
}

export function str(event: ObservatoryEvent, ...keys: string[]): string | null {
    for (const key of keys) {
        const v = event.attributes[key];
        if (typeof v === "string" && v.length > 0) {
            return v;
        }
    }
    return null;
}

export function pct(fraction: number): string {
    return `${(fraction * 100).toFixed(1)}%`;
}

export function ms(ns: number): number {
    return Math.round(ns / NS_PER_MS);
}

export function makeFinding(
    kind: FindingKind,
    severity: Severity,
    evidence: readonly ObservatoryEvent[],
    summary: string,
    facts: Record<string, number | string> = {},
    provenance: Finding["provenance"] = "derived",
    discriminator?: string,
): Finding {
    if (evidence.length === 0) {
        throw new Error(`diagnostics: ${kind} finding without evidence`);
    }
    const sorted = sortEvents(evidence);
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    return {
        id: `${kind}:${discriminator ?? first.event_id}`,
        kind,
        severity,
        startNs: first.mono_ns,
        endNs: last.mono_ns,
        summary,
        evidenceEventIds: [...new Set(sorted.map((e) => e.event_id))],
        facts,
        provenance,
    };
}

/**
 * Groups time-ordered events into bursts: every event that belongs to some
 * window of `windowMs` containing at least `count` events is marked, and
 * consecutive marked events that are no more than `windowMs` apart form
 * one burst (events further apart cannot share a window).
 */
export function findBursts<T extends ObservatoryEvent>(sorted: readonly T[], count: number, windowMs: number): T[][] {
    const windowNs = windowMs * NS_PER_MS;
    const marked = new Array<boolean>(sorted.length).fill(false);
    let j = 0;
    for (let i = 0; i < sorted.length; i++) {
        if (j < i) {
            j = i;
        }
        while (j + 1 < sorted.length && sorted[j + 1]!.mono_ns - sorted[i]!.mono_ns <= windowNs) {
            j++;
        }
        if (j - i + 1 >= count) {
            for (let k = i; k <= j; k++) {
                marked[k] = true;
            }
        }
    }
    const bursts: T[][] = [];
    let current: T[] = [];
    for (let i = 0; i < sorted.length; i++) {
        const prev = current[current.length - 1];
        if (marked[i] && prev && sorted[i]!.mono_ns - prev.mono_ns > windowNs) {
            bursts.push(current);
            current = [];
        }
        if (marked[i]) {
            current.push(sorted[i]!);
        } else if (current.length > 0) {
            bursts.push(current);
            current = [];
        }
    }
    if (current.length > 0) {
        bursts.push(current);
    }
    return bursts;
}

export function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
    const map = new Map<string, T[]>();
    for (const item of items) {
        const k = key(item);
        const list = map.get(k);
        if (list) {
            list.push(item);
        } else {
            map.set(k, [item]);
        }
    }
    return map;
}
