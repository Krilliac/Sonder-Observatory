/**
 * Retained-memory helpers shared by live ingest, recording loaders and
 * SessionStore: fast JS heap byte estimation (without JSON.stringify) and
 * bounded previews for rejected raw payloads.
 */
import type { ObservatoryEvent } from "./events";
import type { RejectedLine } from "../recording/ndjson";

/** Most UTF-16 characters retained for a rejected raw line/frame preview. */
export const MAX_REJECTED_RAW_CHARS = 256;

const BASE_EVENT_OVERHEAD_BYTES = 256;
const CONTAINER_OVERHEAD_BYTES = 64;
const STRING_HEADER_BYTES = 40;
const MAX_ESTIMATE_DEPTH = 16;

function estimateStringBytes(value: string): number {
    return STRING_HEADER_BYTES + value.length * 2;
}

function estimateValueBytes(value: unknown, depth: number): number {
    if (value === null || value === undefined) {
        return 4;
    }
    const kind = typeof value;
    if (kind === "string") {
        return estimateStringBytes(value as string);
    }
    if (kind === "number" || kind === "boolean") {
        return 8;
    }
    if (kind !== "object" || depth > MAX_ESTIMATE_DEPTH) {
        return 16;
    }
    if (Array.isArray(value)) {
        let total = CONTAINER_OVERHEAD_BYTES + value.length * 8;
        for (let i = 0; i < value.length; i += 1) {
            total += estimateValueBytes(value[i], depth + 1);
        }
        return total;
    }
    let total = CONTAINER_OVERHEAD_BYTES;
    const obj = value as Record<string, unknown>;
    for (const key in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) {
            continue;
        }
        total += STRING_HEADER_BYTES + key.length * 2 + estimateValueBytes(obj[key], depth + 1);
    }
    return total;
}

/**
 * Estimates retained JS heap bytes for one validated event without allocating
 * or serializing. Used to bound live buffers, live session retention and
 * recording loads independently of raw event count.
 */
export function estimateEventBytes(event: ObservatoryEvent): number {
    let total = BASE_EVENT_OVERHEAD_BYTES;
    total += event.schema.length * 2;
    total += event.event_id.length * 2;
    total += event.event_type.length * 2;
    total += event.wall_time.length * 2;
    total += event.session_id.length * 2;
    if (typeof event.run_id === "string") total += event.run_id.length * 2;
    if (typeof event.request_id === "string") total += event.request_id.length * 2;
    if (typeof event.agent_id === "string") total += event.agent_id.length * 2;
    if (typeof event.task_id === "string") total += event.task_id.length * 2;
    if (typeof event.model_instance_id === "string") total += event.model_instance_id.length * 2;
    if (typeof event.device_id === "string") total += event.device_id.length * 2;
    const p = event.producer;
    total += CONTAINER_OVERHEAD_BYTES + (p.name.length + p.version.length + p.node_id.length) * 2;
    if (typeof p.instance_id === "string") total += p.instance_id.length * 2;
    if (typeof p.role === "string") total += p.role.length * 2;
    total += estimateValueBytes(event.attributes, 0);
    // Include unknown additive top-level fields if present.
    for (const key in event) {
        if (!Object.prototype.hasOwnProperty.call(event, key)) {
            continue;
        }
        if (
            key === "schema" ||
            key === "event_id" ||
            key === "sequence" ||
            key === "event_type" ||
            key === "wall_time" ||
            key === "mono_ns" ||
            key === "session_id" ||
            key === "run_id" ||
            key === "request_id" ||
            key === "agent_id" ||
            key === "task_id" ||
            key === "model_instance_id" ||
            key === "device_id" ||
            key === "producer" ||
            key === "sampling" ||
            key === "attributes"
        ) {
            continue;
        }
        total += STRING_HEADER_BYTES + key.length * 2 + estimateValueBytes(event[key], 0);
    }
    return total;
}

/** Truncates a rejected line's raw payload to a short bounded preview. */
export function boundRejectedLine(
    line: RejectedLine,
    maxRawChars: number = MAX_REJECTED_RAW_CHARS,
): RejectedLine {
    const cap = Math.max(0, Math.floor(maxRawChars));
    if (line.raw.length <= cap) {
        return line;
    }
    const preview = cap <= 1 ? line.raw.slice(0, cap) : `${line.raw.slice(0, cap - 1)}…`;
    return { line: line.line, reason: line.reason, raw: preview };
}

/** Compact human-readable byte budget string (B, KiB, MiB, GiB). */
export function formatByteBudget(bytes: number): string {
    if (bytes >= 1024 ** 3) {
        return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
    }
    if (bytes >= 1024 ** 2) {
        return `${Math.round(bytes / 1024 ** 2)} MiB`;
    }
    if (bytes >= 1024) {
        return `${Math.round(bytes / 1024)} KiB`;
    }
    return `${bytes} B`;
}
