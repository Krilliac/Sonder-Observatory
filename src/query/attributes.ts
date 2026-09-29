/**
 * Producer attribute conventions shared by metrics, diagnostics and replay.
 *
 * Observatory's own synthetic fixture and Sonder-Inference (b2170c0) name some
 * attributes differently. These readers accept both spellings so one reading
 * rule lives in one place. They never invent values: when neither spelling is
 * present the result is null. See docs/telemetry-schema.md.
 */
import type { ObservatoryEvent } from "../protocol/events";

function finite(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type MemorySource = "used_bytes" | "available_bytes" | "used_fraction";

export interface MemoryUsage {
    usedBytes: number | null;
    totalBytes: number | null;
    fraction: number;
    /** Which attribute convention the value was read from. */
    source: MemorySource;
}

/**
 * Memory usage of a `device.memory.sample`, from (in order):
 * `used_bytes` + `total_bytes` (Observatory fixture), `total_bytes` +
 * `available_bytes` (Sonder-Inference: used = total - available), or
 * `used_fraction`.
 */
export function memoryUsage(event: ObservatoryEvent): MemoryUsage | null {
    const a = event.attributes;
    const total = finite(a.total_bytes);
    const used = finite(a.used_bytes);
    if (used !== null && total !== null && total > 0) {
        return { usedBytes: used, totalBytes: total, fraction: used / total, source: "used_bytes" };
    }
    const available = finite(a.available_bytes);
    if (available !== null && total !== null && total > 0 && available >= 0 && available <= total) {
        const u = total - available;
        return { usedBytes: u, totalBytes: total, fraction: u / total, source: "available_bytes" };
    }
    const fraction = finite(a.used_fraction);
    return fraction === null ? null : { usedBytes: null, totalBytes: null, fraction, source: "used_fraction" };
}

/**
 * Dropped-event count of a `telemetry.dropped` event: `dropped_count`
 * (Observatory fixture) or `dropped_events` (Sonder-Inference, Sonder
 * Runtime). Both are cumulative per producer instance; see
 * totalDroppedEvents for the aggregate.
 */
export function droppedCount(event: ObservatoryEvent): number | null {
    const n = finite(event.attributes.dropped_count) ?? finite(event.attributes.dropped_events);
    return n !== null && n > 0 ? n : null;
}

/**
 * Backend-reported completion token count on a request outcome event.
 * Sonder-Inference sets `token_counts_from_backend: true` when
 * `completion_tokens` comes from the backend (for example Ollama `eval_count`)
 * rather than from counting streamed chunks.
 */
export function backendTokenCount(event: ObservatoryEvent): number | null {
    if (event.attributes.token_counts_from_backend !== true) {
        return null;
    }
    const n = event.attributes.completion_tokens;
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Tokens carried by an `inference.token.generated` event, or null when the
 * event is output that carries no token count.
 *
 * `attributes.unit` decides (Sonder-Inference 912503a+): `"token"` is exactly
 * `count` tokens (default 1); any other unit, notably `"chunk"` (a
 * backend-streamed piece of visible text whose token count is unknown, with
 * hidden thinking tokens producing no chunk at all), is never a token count.
 * An event with no `unit` is read as one token, or an integer `count`
 * (the synthetic fixture and pre-912503a producers).
 *
 * `sampling.sampled` is deliberately not consulted: every current producer
 * (Inference, Runtime, the synthetic fixture) sets `sampled: true` on every
 * event, per-token or not, so it does not distinguish chunks from tokens.
 */
export function outputTokenCount(event: ObservatoryEvent): number | null {
    const unit = event.attributes.unit;
    if (unit !== undefined && unit !== null && unit !== "token") {
        return null;
    }
    const n = event.attributes.count;
    return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 1;
}

/**
 * Backend decode (eval) time in ms on `inference.decode.completed`
 * (`backend_eval_ms`, Sonder-Inference from Ollama `eval_duration`). It covers
 * every generated token, including hidden thinking tokens that never appear
 * as chunks. Null when not reported.
 */
export function backendEvalMs(event: ObservatoryEvent): number | null {
    if (event.event_type !== "inference.decode.completed") {
        return null;
    }
    const n = finite(event.attributes.backend_eval_ms);
    return n !== null && n > 0 ? n : null;
}

/**
 * True for a `model.load.completed` that reports a backend load inside a
 * request (for example Sonder-Inference's Ollama timing helper, which emits it
 * with the request's context and `load_duration_ns`). Such reports are timing
 * facts, not model residency transitions.
 */
export function isRequestScopedLoadReport(event: ObservatoryEvent): boolean {
    return event.event_type === "model.load.completed" && typeof event.request_id === "string" && event.request_id !== "";
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

/**
 * Producer-reported dropped events across a session: for each producer
 * instance, the latest cumulative `dropped_events` / `dropped_count` of its
 * `telemetry.dropped` events (in the order given, normally replay order),
 * summed over instances. A report without a count adds nothing. Events
 * without an instance fall back to session + producer name + node.
 */
export function totalDroppedEvents(events: Iterable<ObservatoryEvent>): number {
    const latest = new Map<string, number>();
    for (const e of events) {
        noteDroppedReport(latest, e);
    }
    return sumDroppedReports(latest);
}

/**
 * One step of totalDroppedEvents: records the cumulative count of a
 * `telemetry.dropped` report in `latest`, keyed per producer instance.
 */
export function noteDroppedReport(latest: Map<string, number>, e: ObservatoryEvent): void {
    if (e.event_type !== "telemetry.dropped") {
        return;
    }
    const n = droppedCount(e);
    if (n === null) {
        return;
    }
    const instance = producerInstance(e);
    const key =
        instance !== null
            ? `${e.producer.name}\u0000${e.producer.node_id}\u0000#${instance}`
            : `${e.session_id}\u0000${e.producer.name}\u0000${e.producer.node_id}`;
    latest.set(key, n);
}

/** The total of the latest reports noted by noteDroppedReport. */
export function sumDroppedReports(latest: ReadonlyMap<string, number>): number {
    let total = 0;
    for (const n of latest.values()) {
        total += n;
    }
    return total;
}
