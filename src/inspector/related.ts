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

export type RelatedGroupKind = "tool_call" | "request" | "parent" | "children" | "run" | "agent";

export interface RelatedGroup {
    kind: RelatedGroupKind;
    title: string;
    /** The correlation value the group is keyed on. */
    value: string;
    /** Matching events in replay order, at most `limit`. */
    events: ObservatoryEvent[];
    /** All matches before the limit. */
    total: number;
}

function parentRequestId(e: ObservatoryEvent): string | null {
    const v = e.attributes.parent_request_id;
    return typeof v === "string" && v !== "" ? v : null;
}

/**
 * Every correlation group of `event` (contract section 8.4), across
 * producers: the tool call; the request; its parent request (the event's
 * attributes.parent_request_id); its child requests (events whose
 * attributes.parent_request_id is this request_id, with every event of those
 * requests); the run_id; the agent. Empty groups are left out; the event
 * itself is never listed.
 */
export function relatedGroups(event: ObservatoryEvent, events: readonly ObservatoryEvent[], limit = 25): RelatedGroup[] {
    const toolCall = typeof event.attributes.tool_call_id === "string" && event.attributes.tool_call_id !== "" ? event.attributes.tool_call_id : null;
    const requestId = event.request_id ?? null;
    const parent = parentRequestId(event);
    const runId = event.run_id ?? null;
    const agentId = event.agent_id ?? null;

    const childRequests = new Set<string>();
    if (requestId) {
        for (const e of events) {
            if (e.request_id && e.request_id !== requestId && parentRequestId(e) === requestId) {
                childRequests.add(e.request_id);
            }
        }
    }

    const specs: { kind: RelatedGroupKind; title: string; value: string | null; match: (e: ObservatoryEvent) => boolean }[] = [
        { kind: "tool_call", title: "Same tool call", value: toolCall, match: (e) => e.attributes.tool_call_id === toolCall },
        { kind: "request", title: "Same request", value: requestId, match: (e) => e.request_id === requestId },
        { kind: "parent", title: "Parent request", value: parent, match: (e) => e.request_id === parent },
        {
            kind: "children",
            title: "Child requests",
            value: childRequests.size > 0 ? [...childRequests].join(", ") : null,
            match: (e) => e.request_id !== null && e.request_id !== undefined && childRequests.has(e.request_id),
        },
        { kind: "run", title: "Same run", value: runId, match: (e) => e.run_id === runId },
        { kind: "agent", title: "Same agent", value: agentId, match: (e) => e.agent_id === agentId },
    ];
    const groups: RelatedGroup[] = [];
    for (const spec of specs) {
        if (!spec.value) {
            continue;
        }
        const matches = events.filter((e) => e.event_id !== event.event_id && spec.match(e));
        if (matches.length > 0) {
            groups.push({ kind: spec.kind, title: spec.title, value: spec.value, events: matches.slice(0, limit), total: matches.length });
        }
    }
    return groups;
}
