import type { ObservatoryEvent } from "../../protocol/events";
import { str } from "../util";

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
    if (fraction >= critical) {
        return "critical";
    }
    if (fraction >= warn) {
        return "warning";
    }
    return null;
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
