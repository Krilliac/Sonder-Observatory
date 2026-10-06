/** Source labels for bounded output references, including omitted finished requests. */
import type { ObservatoryEvent } from "../protocol/events";
import { scopedRequestKey } from "../query/identity";
import { streamKey } from "../replay/order";

export interface RequestLabelRef {
    requestEntityId: string | null;
    eventId: string;
    candidatesEventId?: string | null;
}

/**
 * Resolve only requested labels from original events visible at the cursor.
 * Temporary maps are bounded by `references`, not the entire event history.
 * Never decode an entity ID, use future evidence, or require a finished
 * request to survive the scene's MAX_FINISHED bound.
 */
export function requestLabelsAt(
    events: readonly ObservatoryEvent[],
    references: readonly RequestLabelRef[],
    nowNs: number | null,
): ReadonlyMap<string, string> {
    const wanted = new Map<string, Set<string>>();
    for (const ref of references) {
        if (ref.requestEntityId === null) {
            continue;
        }
        for (const eventId of [ref.eventId, ref.candidatesEventId]) {
            if (!eventId) {
                continue;
            }
            const keys = wanted.get(eventId) ?? new Set<string>();
            keys.add(ref.requestEntityId);
            wanted.set(eventId, keys);
        }
    }
    const labels = new Map<string, string>();
    if (wanted.size === 0 || nowNs === null) {
        return labels;
    }
    // Recent output normally resolves near the end; no extra history index.
    for (let i = events.length - 1; i >= 0 && wanted.size > 0; i -= 1) {
        const event = events[i]!;
        if (event.mono_ns > nowNs || !event.request_id) {
            continue;
        }
        const keys = wanted.get(event.event_id);
        if (keys) {
            const key = scopedRequestKey(streamKey(event), event.request_id);
            if (keys.has(key)) {
                // The original request ID, including embedded delimiters.
                labels.set(key, event.request_id);
                keys.delete(key);
                if (keys.size === 0) {
                    wanted.delete(event.event_id);
                }
            }
        }
    }
    return labels;
}

/** Null attachment and missing original evidence are different readings. */
export function requestLabel(requestEntityId: string | null, labels: ReadonlyMap<string, string>): string {
    return requestEntityId === null ? "no request" : labels.get(requestEntityId) ?? "request evidence unavailable";
}
