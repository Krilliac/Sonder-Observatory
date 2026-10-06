/** Stateless, opaque identities derived from original protocol strings. */
import type { ObservatoryEvent } from "../protocol/events";

const KEY_PREFIX = "obs-key/1:";

/** String boundaries and fixed domains are encoded; no field is normalized. */
export function tupleKey(domain: string, ...fields: readonly string[]): string {
    return KEY_PREFIX + JSON.stringify([domain, ...fields]);
}

const INSTANCE_EVENT_ID = /^(.+)-(\d+)$/;

/**
 * Identity of the producer instance whose counter assigned `sequence`, if the
 * event reveals it: `producer.instance_id` when present, otherwise the prefix
 * of an event id shaped `<instance>-<sequence>` (Sonder-Inference uses
 * `tel-<hex>-<sequence>` from one counter shared by all of its sessions).
 * Returns null when neither applies.
 */
export function producerInstance(event: ObservatoryEvent): string | null {
    const explicit = event.producer.instance_id;
    if (typeof explicit === "string" && explicit !== "") {
        return explicit;
    }
    const match = INSTANCE_EVENT_ID.exec(event.event_id);
    if (match && Number(match[2]) === event.sequence && String(event.sequence) === match[2]) {
        return match[1]!;
    }
    return null;
}

/** A known instance spans sessions; unknown instances retain the session fallback. */
export function producerStreamKey(event: ObservatoryEvent): string {
    const instance = producerInstance(event);
    return instance !== null
        ? tupleKey("stream-instance", event.producer.name, event.producer.node_id, instance)
        : tupleKey("stream-session", event.session_id, event.producer.name, event.producer.node_id);
}

/** Presence/empty-ID rules belong to each caller, not this string composer. */
export function scopedRequestKey(stream: string, requestId: string): string {
    return tupleKey("request", stream, requestId);
}

export function scopedSessionKey(stream: string, sessionId: string): string {
    return tupleKey("stream-session-scope", stream, sessionId);
}

/** Source name/node of a canonical stream key, for labels only. */
export function streamNameAndNode(stream: string): { name: string; nodeId: string } | null {
    if (!stream.startsWith(KEY_PREFIX)) {
        return null;
    }
    let fields: unknown;
    try {
        fields = JSON.parse(stream.slice(KEY_PREFIX.length));
    } catch {
        return null;
    }
    if (!Array.isArray(fields) || fields.length !== 4 || !fields.every((v: unknown) => typeof v === "string")) {
        return null;
    }
    if (fields[0] === "stream-instance") {
        return { name: fields[1] as string, nodeId: fields[2] as string };
    }
    if (fields[0] === "stream-session") {
        return { name: fields[2] as string, nodeId: fields[3] as string };
    }
    return null;
}
