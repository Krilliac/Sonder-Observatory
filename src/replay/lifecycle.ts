/**
 * Per-request lifecycle state machine for live and replayed sessions.
 *
 * Guarantees that distinct `(producer stream, request_id)` lifecycles never
 * bleed into one another — in particular, when request #1 cancels during
 * decode and request #2 starts milliseconds later in prefill, request #1 stays
 * locked in `cancelled` (with `lastActivePhase: "decode"`) while request #2
 * starts cleanly in `prefill` with its own transition history.
 *
 * Also handles:
 * - Same `(stream, request_id)` reuse after a terminal outcome (opens a new
 *   generation instead of overwriting or blurring the cancelled attempt).
 * - Late/straggler events arriving after `request.cancelled`/`completed`/`failed`
 *   (never revert terminal state or emit bogus `decode -> prefill` moves).
 * - End-of-request facts (`inference.prefill.completed`, `inference.decode.completed`)
 *   which never move an active request backwards.
 * - Live retention eviction: cached per immutable ordered array and extended
 *   incrementally on in-order appends; eviction drops the old array so evicted
 *   requests do not leak memory.
 */
import type { ObservatoryEvent } from "../protocol/events";
import { createIdentityKeys, tupleKey } from "../query/identity";
import { isOrdered, onPrefixExtended } from "./lookup";
import { orderEvents, streamKey } from "./order";

export type RequestActivePhase = "queued" | "prefill" | "decode";
export type RequestLifecyclePhase = RequestActivePhase | "completed" | "cancelled" | "failed";
export type RequestLifecycleStatus = "active" | "completed" | "cancelled" | "failed";

export interface RequestPhaseTransition {
    from: RequestLifecyclePhase | null;
    to: RequestLifecyclePhase;
    monoNs: number;
    eventId: string;
    eventType: string;
}

export interface RequestLifecycle {
    /** Canonical unique key for this (producer stream, request_id[, generation]). */
    key: string;
    requestId: string;
    streamKey: string;
    producer: string;
    nodeId: string;
    sessionId: string;
    runId: string | null;
    parentRequestId: string | null;
    /** 0-based generation when the same (stream, request_id) restarts after reaching a terminal state. */
    generation: number;
    /** Current lifecycle phase. Terminal requests remain in completed | cancelled | failed. */
    phase: RequestLifecyclePhase;
    /** High-level status separating active vs completed vs cancelled vs failed. */
    status: RequestLifecycleStatus;
    /** True iff this request terminated via `request.cancelled`. */
    cancelled: boolean;
    /** Last non-terminal phase observed (e.g. "decode" when cancelled mid-decode). */
    lastActivePhase: RequestActivePhase | null;
    startNs: number;
    lastNs: number;
    endNs: number | null;
    firstTokenNs: number | null;
    /** Ordered phase transitions observed for this request instance only (bounded). */
    transitions: RequestPhaseTransition[];
    /** True when the earliest retained event was not `request.queued`/`request.started`/`scheduler.enqueued`. */
    partialStart: boolean;
    /** Count of events observed for this request after it already reached a terminal state. */
    lateEventsAfterTerminal: number;
}

/** Maximum transitions retained per request (bounds memory under pathological preemption storms). */
export const MAX_LIFECYCLE_TRANSITIONS = 64;

const ACTIVE_PHASE_ORDER: Record<RequestActivePhase, number> = {
    queued: 0,
    prefill: 1,
    decode: 2,
};

const TERMINAL_STATUS: Record<string, RequestLifecycleStatus> = {
    "request.completed": "completed",
    "request.cancelled": "cancelled",
    "request.failed": "failed",
};

interface PhaseReading {
    phase: RequestLifecyclePhase;
    terminal: boolean;
    /** False for end-of-request summary facts that never move a request backwards. */
    move: boolean;
    /** Explicit request birth events that start a new generation if the prior one is terminal. */
    startsRequest: boolean;
    /** Explicit scheduler preemption that legitimately moves an active request back to queued. */
    preemption: boolean;
}

/** Maps one protocol event to its request lifecycle semantics, or null if unrelated. */
export function phaseOfRequestEvent(e: ObservatoryEvent): PhaseReading | null {
    const t = e.event_type;
    if (t in TERMINAL_STATUS) {
        return {
            phase: TERMINAL_STATUS[t] as RequestLifecyclePhase,
            terminal: true,
            move: true,
            startsRequest: false,
            preemption: false,
        };
    }
    switch (t) {
        case "request.queued":
        case "scheduler.enqueued":
            return { phase: "queued", terminal: false, move: true, startsRequest: true, preemption: false };
        case "scheduler.preempted":
            return { phase: "queued", terminal: false, move: true, startsRequest: false, preemption: true };
        case "request.started":
            return {
                phase: e.attributes.scheduled === true ? "queued" : "prefill",
                terminal: false,
                move: true,
                startsRequest: true,
                preemption: false,
            };
        case "scheduler.admitted":
        case "scheduler.prefill.chunk":
        case "scheduler.prefill.completed":
        case "inference.prefill.started":
        case "inference.prefill.chunk":
        case "kv.allocated":
        case "kv.reused":
            return { phase: "prefill", terminal: false, move: true, startsRequest: false, preemption: false };
        case "inference.prefill.completed":
            return { phase: "prefill", terminal: false, move: false, startsRequest: false, preemption: false };
        case "inference.decode.started":
        case "inference.token.generated":
            return { phase: "decode", terminal: false, move: true, startsRequest: false, preemption: false };
        case "inference.decode.completed":
            return { phase: "decode", terminal: false, move: false, startsRequest: false, preemption: false };
        default:
            return null;
    }
}

function nonEmptyStr(v: unknown): string | null {
    return typeof v === "string" && v !== "" ? v : null;
}

function isActivePhase(phase: RequestLifecyclePhase): phase is RequestActivePhase {
    return phase === "queued" || phase === "prefill" || phase === "decode";
}

function pushTransition(list: RequestPhaseTransition[], tr: RequestPhaseTransition): void {
    list.push(tr);
    if (list.length > MAX_LIFECYCLE_TRANSITIONS) {
        // Keep the initial birth transition and the most recent tail.
        list.splice(1, list.length - MAX_LIFECYCLE_TRANSITIONS);
    }
}

function cloneLifecycle(r: RequestLifecycle): RequestLifecycle {
    return { ...r, transitions: r.transitions.map((t) => ({ ...t })) };
}

/**
 * Append-only per-request lifecycle accumulator. Shared across in-order
 * SessionStore extensions so live ingest updates in O(new batch) time.
 */
class RequestLifecycleAccumulator {
    /** All request instances in birth order. */
    private readonly ordered: RequestLifecycle[] = [];
    /** Latest instance for each canonical (stream, request_id) base key. */
    private readonly latestByBase = new Map<string, RequestLifecycle>();
    /** Snapshot index: events already applied. */
    processed = 0;

    extend(events: readonly ObservatoryEvent[]): void {
        if (this.processed >= events.length) {
            return;
        }
        const keys = createIdentityKeys();
        for (let i = this.processed; i < events.length; i += 1) {
            this.apply(events[i]!, keys);
        }
        this.processed = events.length;
    }

    private apply(e: ObservatoryEvent, keys: ReturnType<typeof createIdentityKeys>): void {
        const rid = nonEmptyStr(e.request_id);
        if (rid === null) {
            return;
        }
        const reading = phaseOfRequestEvent(e);
        if (reading === null) {
            return;
        }
        const stream = keys.stream(e);
        const baseKey = keys.request(stream, rid);
        let current = this.latestByBase.get(baseKey);

        // If the prior instance for (stream, request_id) already terminated and a fresh
        // request.started/request.queued arrives, open a new generation instead of
        // mutating or blurring the cancelled/completed record.
        if (current && current.status !== "active" && reading.startsRequest) {
            const gen = current.generation + 1;
            current = this.create(
                tupleKey("request-gen", stream, rid, String(gen)),
                rid,
                stream,
                gen,
                e,
                reading,
            );
            this.latestByBase.set(baseKey, current);
            this.ordered.push(current);
            return;
        }

        if (!current) {
            if (!reading.move) {
                // Summary facts alone (e.g. inference.prefill.completed) do not synthesize a request.
                return;
            }
            current = this.create(baseKey, rid, stream, 0, e, reading);
            this.latestByBase.set(baseKey, current);
            this.ordered.push(current);
            return;
        }

        // Update metadata safely without clobbering existing values.
        if (e.mono_ns > current.lastNs) {
            current.lastNs = e.mono_ns;
        }
        current.runId ??= nonEmptyStr(e.run_id);
        current.parentRequestId ??= nonEmptyStr(e.attributes.parent_request_id);
        if (e.event_type === "inference.token.generated" && current.firstTokenNs === null) {
            current.firstTokenNs = e.mono_ns;
        }

        // Terminal states are strictly sticky: late/straggler events (e.g. late decode.completed,
        // prefill.completed, tokens, or duplicate terminal outcomes) never revert or mutate state.
        if (current.status !== "active") {
            current.lateEventsAfterTerminal += 1;
            return;
        }

        if (reading.terminal) {
            const prev = current.phase;
            const status = TERMINAL_STATUS[e.event_type]!;
            current.phase = reading.phase;
            current.status = status;
            current.cancelled = status === "cancelled";
            current.endNs = e.mono_ns;
            pushTransition(current.transitions, {
                from: prev,
                to: reading.phase,
                monoNs: e.mono_ns,
                eventId: e.event_id,
                eventType: e.event_type,
            });
            return;
        }

        if (!reading.move || !isActivePhase(reading.phase) || !isActivePhase(current.phase)) {
            return;
        }

        const forward = ACTIVE_PHASE_ORDER[reading.phase] > ACTIVE_PHASE_ORDER[current.phase];
        if (forward || (reading.preemption && reading.phase !== current.phase)) {
            const prev = current.phase;
            current.phase = reading.phase;
            current.lastActivePhase = reading.phase;
            pushTransition(current.transitions, {
                from: prev,
                to: reading.phase,
                monoNs: e.mono_ns,
                eventId: e.event_id,
                eventType: e.event_type,
            });
        }
    }

    private create(
        key: string,
        requestId: string,
        stream: string,
        generation: number,
        e: ObservatoryEvent,
        reading: PhaseReading,
    ): RequestLifecycle {
        const status: RequestLifecycleStatus = reading.terminal ? TERMINAL_STATUS[e.event_type]! : "active";
        const activePhase = isActivePhase(reading.phase) ? reading.phase : null;
        return {
            key,
            requestId,
            streamKey: stream,
            producer: e.producer.name,
            nodeId: e.producer.node_id,
            sessionId: e.session_id,
            runId: nonEmptyStr(e.run_id),
            parentRequestId: nonEmptyStr(e.attributes.parent_request_id),
            generation,
            phase: reading.phase,
            status,
            cancelled: status === "cancelled",
            lastActivePhase: activePhase,
            startNs: e.mono_ns,
            lastNs: e.mono_ns,
            endNs: reading.terminal ? e.mono_ns : null,
            firstTokenNs: e.event_type === "inference.token.generated" ? e.mono_ns : null,
            transitions: [
                {
                    from: null,
                    to: reading.phase,
                    monoNs: e.mono_ns,
                    eventId: e.event_id,
                    eventType: e.event_type,
                },
            ],
            partialStart: !reading.startsRequest,
            lateEventsAfterTerminal: 0,
        };
    }

    snapshot(): RequestLifecycle[] {
        return this.ordered.map(cloneLifecycle);
    }
}

const lifecycleCache = new WeakMap<readonly ObservatoryEvent[], { acc: RequestLifecycleAccumulator; snapshot: RequestLifecycle[] | null }>();

// Share the accumulator across in-order live appends so each batch only scans its tail.
// Eviction / out-of-order merges do NOT fire onPrefixExtended, so evicted requests are GC'd cleanly.
onPrefixExtended((previous, next) => {
    const entry = lifecycleCache.get(previous);
    if (entry && !lifecycleCache.has(next)) {
        lifecycleCache.set(next, { acc: entry.acc, snapshot: null });
    }
});

/**
 * Derives isolated per-request lifecycles in replay order.
 *
 * Immutable ordered arrays from `SessionStore` / `orderEvents` share a cached
 * incremental accumulator; arbitrary caller arrays are ordered safely without
 * mutating the input.
 */
export function deriveRequestLifecycles(events: readonly ObservatoryEvent[]): RequestLifecycle[] {
    if (!isOrdered(events)) {
        const ordered = orderEvents(events).events;
        const acc = new RequestLifecycleAccumulator();
        acc.extend(ordered);
        return acc.snapshot();
    }
    let entry = lifecycleCache.get(events);
    if (!entry) {
        entry = { acc: new RequestLifecycleAccumulator(), snapshot: null };
        lifecycleCache.set(events, entry);
    }
    if (entry.snapshot === null) {
        if (entry.acc.processed > events.length) {
            const fresh = new RequestLifecycleAccumulator();
            fresh.extend(events);
            entry.acc = fresh;
        } else {
            entry.acc.extend(events);
        }
        entry.snapshot = entry.acc.snapshot();
    }
    return entry.snapshot;
}

/** Looks up the latest lifecycle generation for `(stream, requestId)`, or undefined. */
export function findRequestLifecycle(
    lifecycles: readonly RequestLifecycle[],
    event: Pick<ObservatoryEvent, "request_id" | "session_id" | "event_id" | "sequence" | "producer">,
): RequestLifecycle | undefined {
    const rid = nonEmptyStr(event.request_id);
    if (rid === null) {
        return undefined;
    }
    const stream = streamKey(event as ObservatoryEvent);
    let match: RequestLifecycle | undefined;
    for (const item of lifecycles) {
        if (item.streamKey === stream && item.requestId === rid) {
            if (match === undefined || item.generation >= match.generation) {
                match = item;
            }
        }
    }
    return match;
}
