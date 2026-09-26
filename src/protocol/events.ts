/**
 * TypeScript view of protocol/observatory-events.schema.json (envelope v1).
 *
 * The JSON Schema file is the source of truth. This module mirrors it by hand
 * and tests/protocol-schema-drift.test.ts fails if the two diverge (required
 * fields, property names, const schema id, nullable correlation ids, sampling
 * levels). Do not add envelope fields here that the schema does not define.
 */

export const SCHEMA_ID = "sonder.observatory.event/1";

export const SAMPLING_LEVELS = ["off", "metrics", "standard", "deep"] as const;
export type SamplingLevel = (typeof SAMPLING_LEVELS)[number];

/** Required top-level envelope fields, in schema order. */
export const REQUIRED_FIELDS = [
    "schema",
    "event_id",
    "sequence",
    "event_type",
    "wall_time",
    "mono_ns",
    "session_id",
    "producer",
    "attributes",
] as const;

/** Optional correlation ids that the schema types as string | null. */
export const NULLABLE_ID_FIELDS = [
    "run_id",
    "request_id",
    "agent_id",
    "task_id",
    "model_instance_id",
    "device_id",
] as const;

export type NullableIdField = (typeof NULLABLE_ID_FIELDS)[number];

export interface Producer {
    name: string;
    version: string;
    node_id: string;
    /** Additional producer properties are allowed by the schema. */
    [extra: string]: unknown;
}

export interface Sampling {
    level?: SamplingLevel;
    sampled?: boolean;
    [extra: string]: unknown;
}

export interface ObservatoryEvent {
    schema: typeof SCHEMA_ID;
    event_id: string;
    sequence: number;
    event_type: string;
    /** RFC 3339 / ISO 8601 date-time (UTC recommended). */
    wall_time: string;
    /**
     * Monotonic producer timestamp in nanoseconds. Parsed from JSON as a
     * number; values above 2^53 lose precision (about 104 days of uptime).
     */
    mono_ns: number;
    session_id: string;
    run_id?: string | null;
    request_id?: string | null;
    agent_id?: string | null;
    task_id?: string | null;
    model_instance_id?: string | null;
    device_id?: string | null;
    producer: Producer;
    sampling?: Sampling;
    attributes: Record<string, unknown>;
    /** Unknown additive fields are allowed and preserved. */
    [extra: string]: unknown;
}
