import type { ObservatoryEvent } from "../protocol/events";

/**
 * Events that share the most specific correlation id with `event`
 * (request, then agent, then tool_call_id), excluding the event itself.
 */
export function relatedEvents(
    event: ObservatoryEvent,
    events: readonly ObservatoryEvent[],
    limit = 25,
): { by: string; value: string; events: ObservatoryEvent[] } | null {
    const toolCall = typeof event.attributes.tool_call_id === "string" ? event.attributes.tool_call_id : null;
    const candidates: [string, string | null | undefined, (e: ObservatoryEvent) => unknown][] = [
        ["tool_call_id", toolCall, (e) => e.attributes.tool_call_id],
        ["request_id", event.request_id, (e) => e.request_id],
        ["agent_id", event.agent_id, (e) => e.agent_id],
    ];
    for (const [by, value, get] of candidates) {
        if (!value) {
            continue;
        }
        const matches = events.filter((e) => e.event_id !== event.event_id && get(e) === value);
        if (matches.length > 0) {
            return { by, value, events: matches.slice(0, limit) };
        }
    }
    return null;
}
