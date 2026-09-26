import type { ObservatoryEvent } from "../protocol/events";
import { streamKey } from "../replay/order";

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
 * A request is identified by (producer stream, request_id), as metrics key
 * request spans (contract 8.4): request ids are only unique within one
 * producer instance, and two producers replaying the same ids are unrelated.
 */
function requestKey(e: ObservatoryEvent): string | null {
    return e.request_id ? `${streamKey(e)}\u0000${e.request_id}` : null;
}

/** Two run ids conflict only when both are known and differ. */
function runsAgree(a: ObservatoryEvent, b: ObservatoryEvent): boolean {
    return !a.run_id || !b.run_id || a.run_id === b.run_id;
}

/**
 * Every correlation group of `event` (contract section 8.4):
 *
 * - Same tool call: attributes.tool_call_id.
 * - Same request: the same request_id in the same producer stream.
 * - Parent request: the request named by the event's
 *   attributes.parent_request_id, in any producer (the attribute states the
 *   cross-producer link); when the event has a run_id, a candidate from a
 *   different run is not the parent.
 * - Child requests: requests (keyed per producer stream) whose events name
 *   this request in attributes.parent_request_id, from a compatible run.
 * - Same run: run_id, across producers.
 * - Same agent: agent_id.
 *
 * Empty groups are left out; the event itself is never listed.
 */
export function relatedGroups(event: ObservatoryEvent, events: readonly ObservatoryEvent[], limit = 25): RelatedGroup[] {
    const toolCall = typeof event.attributes.tool_call_id === "string" && event.attributes.tool_call_id !== "" ? event.attributes.tool_call_id : null;
    const requestId = event.request_id ?? null;
    const ownRequest = requestKey(event);
    const parent = parentRequestId(event);
    const runId = event.run_id ?? null;
    const agentId = event.agent_id ?? null;

    const childRequests = new Set<string>();
    const childIds = new Set<string>();
    const parentRequests = new Set<string>();
    for (const e of events) {
        const key = requestKey(e);
        if (!key || key === ownRequest) {
            continue;
        }
        if (requestId && parentRequestId(e) === requestId && runsAgree(e, event)) {
            childRequests.add(key);
            childIds.add(e.request_id!);
        }
        if (parent && e.request_id === parent && runsAgree(e, event)) {
            parentRequests.add(key);
        }
    }

    const inRequests = (set: ReadonlySet<string>) => (e: ObservatoryEvent) => {
        const key = requestKey(e);
        return key !== null && set.has(key);
    };
    const specs: { kind: RelatedGroupKind; title: string; value: string | null; match: (e: ObservatoryEvent) => boolean }[] = [
        { kind: "tool_call", title: "Same tool call", value: toolCall, match: (e) => e.attributes.tool_call_id === toolCall },
        { kind: "request", title: "Same request", value: requestId, match: (e) => ownRequest !== null && requestKey(e) === ownRequest },
        { kind: "parent", title: "Parent request", value: parentRequests.size > 0 ? parent : null, match: inRequests(parentRequests) },
        { kind: "children", title: "Child requests", value: childIds.size > 0 ? [...childIds].join(", ") : null, match: inRequests(childRequests) },
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
