import type { ObservatoryEvent } from "../../protocol/events";
import { NS_PER_MS, ms, str } from "../util";

/** Best available correlation key for grouping context/tool activity. */
export function scopeKey(e: ObservatoryEvent): string {
    const ctx = str(e, "context_id");
    if (ctx) {
        return `context:${ctx}`;
    }
    if (e.request_id) {
        return `request:${e.request_id}`;
    }
    if (e.agent_id) {
        return `agent:${e.agent_id}`;
    }
    return `session:${e.session_id}`;
}

export function severityFor(fraction: number, warn: number, critical: number): "warning" | "critical" | null {
    if (!Number.isFinite(fraction)) {
        return null;
    }
    if (Number.isFinite(critical) && fraction >= critical) {
        return "critical";
    }
    if (Number.isFinite(warn) && fraction >= warn) {
        return "warning";
    }
    return null;
}

/** Non-negative rounded millisecond duration, or null on non-finite / negative clock skew. */
export function nonNegDurationMs(startNs: number, endNs: number): number | null {
    if (!Number.isFinite(startNs) || !Number.isFinite(endNs) || endNs < startNs) {
        return null;
    }
    return ms(endNs - startNs);
}

/** Non-negative rounded millisecond span between two timestamps (0 on invalid/skewed input). */
export function safeSpanMs(firstNs: number, lastNs: number): number {
    return nonNegDurationMs(firstNs, lastNs) ?? 0;
}

/**
 * O(N) burst finder equivalent to `findBursts`: every event belonging to some
 * window of `windowMs` containing at least `count` events is marked, and
 * consecutive marked events no more than `windowMs` apart form one burst.
 * Guards against non-finite timestamps and invalid (<=0 / NaN) thresholds.
 */
export function findBurstsLinear<T extends ObservatoryEvent>(sorted: readonly T[], count: number, windowMs: number): T[][] {
    if (!Number.isFinite(count) || count < 1 || !Number.isFinite(windowMs) || windowMs < 0) {
        return [];
    }
    const minCount = Math.ceil(count);
    const valid = sorted.every((e) => Number.isFinite(e.mono_ns)) ? sorted : sorted.filter((e) => Number.isFinite(e.mono_ns));
    if (valid.length < minCount) {
        return [];
    }
    const windowNs = windowMs * NS_PER_MS;
    const marked = new Uint8Array(valid.length);
    let j = 0;
    let markedThrough = -1;
    for (let i = 0; i < valid.length; i += 1) {
        if (j < i) {
            j = i;
        }
        while (j + 1 < valid.length && valid[j + 1]!.mono_ns - valid[i]!.mono_ns <= windowNs) {
            j += 1;
        }
        if (j - i + 1 >= minCount) {
            for (let k = Math.max(i, markedThrough + 1); k <= j; k += 1) {
                marked[k] = 1;
            }
            if (j > markedThrough) {
                markedThrough = j;
            }
        }
    }
    const bursts: T[][] = [];
    let current: T[] = [];
    for (let i = 0; i < valid.length; i += 1) {
        const prev = current[current.length - 1];
        if (marked[i] && prev && valid[i]!.mono_ns - prev.mono_ns > windowNs) {
            bursts.push(current);
            current = [];
        }
        if (marked[i]) {
            current.push(valid[i]!);
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

/**
 * Splits a time-ordered sample series into contiguous episodes where
 * `isHigh` holds. A sample that is not high ends the episode.
 */
export function episodes<T>(samples: readonly T[], isHigh: (s: T) => boolean): T[][] {
    const out: T[][] = [];
    let cur: T[] = [];
    for (const s of samples) {
        if (isHigh(s)) {
            cur.push(s);
        } else if (cur.length > 0) {
            out.push(cur);
            cur = [];
        }
    }
    if (cur.length > 0) {
        out.push(cur);
    }
    return out;
}
