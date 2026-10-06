import type { ObservatoryEvent } from "../protocol/events";
import { createIdentityKeys, scopedRequestKey } from "../query/identity";
import { isOrdered, onPrefixExtended } from "../replay/lookup";
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
    return e.request_id ? scopedRequestKey(streamKey(e), e.request_id) : null;
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
 * - Parent request: the unique parent named by this producer-scoped request's
 *   events, in any producer. Output events need not repeat lifecycle parent
 *   attributes. Conflicting observed parents or runs withhold this group;
 *   known request runs exclude parent events from a different run.
 * - Child requests: requests (keyed per producer stream) whose events name
 *   this request in attributes.parent_request_id, from a compatible run.
 * - Same run: run_id, across producers.
 * - Same agent: agent_id.
 *
 * Empty groups are left out; the event itself is never listed.
 *
 * For the session store's arrays (immutable, replay order) a cached
 * correlation index supplies, per check, only the events that share the
 * checked value, in replay order; indexed and scan paths apply the same
 * lineage checks (docs/integration/perf.md).
 */
export function relatedGroups(event: ObservatoryEvent, events: readonly ObservatoryEvent[], limit = 25): RelatedGroup[] {
    const toolCall = typeof event.attributes.tool_call_id === "string" && event.attributes.tool_call_id !== "" ? event.attributes.tool_call_id : null;
    const requestId = event.request_id ?? null;
    const ownRequest = requestKey(event);
    const runId = event.run_id ?? null;
    const agentId = event.agent_id ?? null;

    const index = isOrdered(events) ? getCorrelationIndex(events) : null;
    /** Every event of `events` that may have one of `values` in `map` (all events without an index), in order. */
    const candidates = (map: keyof IndexMaps, values: Iterable<string | null>): Iterable<ObservatoryEvent> =>
        index ? index.lookup(events, map, values) : events;
    const ownCandidates = ownRequest === null ? [] : candidates("requestKey", [ownRequest]);

    // Derive lineage only from this request's original evidence. Include the
    // selected event even when it is outside the supplied session/prefix.
    const parents = new Set<string>();
    const requestRuns = new Set<string>();
    const observeLineage = (e: ObservatoryEvent): void => {
        const p = parentRequestId(e);
        // Two distinct values suffice to prove ambiguity; cap transient facts.
        if (p && parents.size < 2) {
            parents.add(p);
        }
        if (e.run_id && requestRuns.size < 2) {
            requestRuns.add(e.run_id);
        }
    };
    observeLineage(event);
    if (ownRequest !== null) {
        for (const e of ownCandidates) {
            // A different raw request id, or no lineage fact, cannot add
            // evidence. Canonical equality still scopes every scan candidate.
            if (e.request_id === requestId && (parentRequestId(e) || e.run_id) && (index !== null || requestKey(e) === ownRequest)) {
                observeLineage(e);
                // Ambiguity cannot be undone by later evidence. Keep the full
                // candidate list for Same request rows and totals below.
                if (parents.size > 1 || requestRuns.size > 1) {
                    break;
                }
            }
        }
    }
    const parent = parents.size === 1 && requestRuns.size <= 1 ? [...parents][0]! : null;
    const requestRun = requestRuns.size === 1 ? [...requestRuns][0]! : null;
    const parentRunAgrees = (e: ObservatoryEvent): boolean => !requestRun || !e.run_id || e.run_id === requestRun;

    const childRequests = new Set<string>();
    const childIds = new Set<string>();
    const parentRequests = new Set<string>();
    const childCheck = (e: ObservatoryEvent): void => {
        if (!requestId || !e.request_id || parentRequestId(e) !== requestId || !runsAgree(e, event)) {
            return;
        }
        const key = requestKey(e);
        if (key && key !== ownRequest) {
            childRequests.add(key);
            childIds.add(e.request_id!);
        }
    };
    const parentCheck = (e: ObservatoryEvent): void => {
        if (!parent || e.request_id !== parent || !parentRunAgrees(e)) {
            return;
        }
        const key = requestKey(e);
        if (key && key !== ownRequest) {
            parentRequests.add(key);
        }
    };
    // childIds keeps first-seen order, so each check visits its candidates in replay order.
    for (const e of candidates("parentRequest", [requestId || null])) {
        childCheck(e);
    }
    for (const e of candidates("requestId", [parent])) {
        parentCheck(e);
    }

    const inRequests = (set: ReadonlySet<string>, hasId: (id: string) => boolean) => (e: ObservatoryEvent) => {
        if (!e.request_id || !hasId(e.request_id)) {
            return false;
        }
        const key = requestKey(e);
        return key !== null && set.has(key);
    };
    const inParentRequests = inRequests(parentRequests, (id) => id === parent);
    const specs: {
        kind: RelatedGroupKind;
        title: string;
        value: string | null;
        match: (e: ObservatoryEvent) => boolean;
        candidates: () => Iterable<ObservatoryEvent>;
    }[] = [
        {
            kind: "tool_call",
            title: "Same tool call",
            value: toolCall,
            match: (e) => e.attributes.tool_call_id === toolCall,
            candidates: () => candidates("toolCall", [toolCall]),
        },
        {
            kind: "request",
            title: "Same request",
            value: requestId,
            match: (e) => ownRequest !== null && e.request_id === requestId && (index !== null || requestKey(e) === ownRequest),
            candidates: () => ownCandidates,
        },
        {
            kind: "parent",
            title: "Parent request",
            value: parentRequests.size > 0 ? parent : null,
            match: (e) => parentRunAgrees(e) && inParentRequests(e),
            candidates: () => candidates("requestKey", parentRequests),
        },
        {
            kind: "children",
            title: "Child requests",
            value: childIds.size > 0 ? [...childIds].join(", ") : null,
            match: inRequests(childRequests, (id) => childIds.has(id)),
            candidates: () => candidates("requestKey", childRequests),
        },
        { kind: "run", title: "Same run", value: runId, match: (e) => e.run_id === runId, candidates: () => candidates("run", [runId || null]) },
        { kind: "agent", title: "Same agent", value: agentId, match: (e) => e.agent_id === agentId, candidates: () => candidates("agent", [agentId || null]) },
    ];
    const groups: RelatedGroup[] = [];
    for (const spec of specs) {
        if (!spec.value) {
            continue;
        }
        const matches: ObservatoryEvent[] = [];
        for (const e of spec.candidates()) {
            if (e.event_id !== event.event_id && spec.match(e)) {
                matches.push(e);
            }
        }
        if (matches.length > 0) {
            groups.push({ kind: spec.kind, title: spec.title, value: spec.value, events: matches.slice(0, limit), total: matches.length });
        }
    }
    return groups;
}

interface IndexMaps {
    toolCall: Map<string, number[]>;
    requestKey: Map<string, number[]>;
    requestId: Map<string, number[]>;
    parentRequest: Map<string, number[]>;
    run: Map<string, number[]>;
    agent: Map<string, number[]>;
}

/**
 * Positions of events by correlation value, for the session store's
 * (immutable, replay-ordered) arrays. Shared across in-order appends, which
 * keep every position: positions past an array's length are ignored for it.
 */
class CorrelationIndex {
    private built = 0;
    private readonly maps: IndexMaps = {
        toolCall: new Map(),
        requestKey: new Map(),
        requestId: new Map(),
        parentRequest: new Map(),
        run: new Map(),
        agent: new Map(),
    };

    private build(events: readonly ObservatoryEvent[]): void {
        if (this.built >= events.length) {
            return;
        }
        const m = this.maps;
        const keys = createIdentityKeys();
        for (let i = this.built; i < events.length; i += 1) {
            const e = events[i]!;
            const tool = e.attributes.tool_call_id;
            add(m.toolCall, typeof tool === "string" && tool !== "" ? tool : null, i);
            add(m.requestKey, e.request_id ? keys.request(keys.stream(e), e.request_id) : null, i);
            add(m.requestId, typeof e.request_id === "string" && e.request_id !== "" ? e.request_id : null, i);
            add(m.parentRequest, parentRequestId(e), i);
            add(m.run, typeof e.run_id === "string" && e.run_id !== "" ? e.run_id : null, i);
            add(m.agent, typeof e.agent_id === "string" && e.agent_id !== "" ? e.agent_id : null, i);
        }
        this.built = Math.max(this.built, events.length);
    }

    /** Events of `events` whose `map` value is one of `values`, in replay order. */
    lookup(events: readonly ObservatoryEvent[], map: keyof IndexMaps, values: Iterable<string | null>): ObservatoryEvent[] {
        this.build(events);
        const lists: number[][] = [];
        for (const v of values) {
            const list = v === null ? undefined : this.maps[map].get(v);
            if (list) {
                lists.push(list);
            }
        }
        const positions = lists.length === 1 ? lists[0]! : lists.flat().sort((a, b) => a - b);
        const out: ObservatoryEvent[] = [];
        for (const p of positions) {
            if (p >= events.length) {
                break;
            }
            out.push(events[p]!);
        }
        return out;
    }
}

function add(map: Map<string, number[]>, key: string | null, i: number): void {
    if (key === null) {
        return;
    }
    const list = map.get(key);
    if (list) {
        list.push(i);
    } else {
        map.set(key, [i]);
    }
}

const indexes = new WeakMap<readonly ObservatoryEvent[], CorrelationIndex>();

function getCorrelationIndex(events: readonly ObservatoryEvent[]): CorrelationIndex {
    let index = indexes.get(events);
    if (!index) {
        index = new CorrelationIndex();
        indexes.set(events, index);
    }
    return index;
}

// A store append after its last event keeps every position, so the index is shared.
onPrefixExtended((previous, next) => {
    const index = indexes.get(previous);
    if (index && !indexes.has(next)) {
        indexes.set(next, index);
    }
});
