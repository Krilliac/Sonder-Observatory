/**
 * TypeScript view of protocol/producer-discovery.schema.json
 * (sonder.telemetry.producer/1), the document a live producer serves at
 * GET /.well-known/sonder-telemetry.
 *
 * The JSON Schema file is the source of truth. This module mirrors it by hand
 * (Observatory has no JSON-Schema library, see docs/DECISIONS.md) and
 * tests/protocol-discovery-drift.test.ts fails if the two diverge. Change the
 * schema first, then this mirror.
 */
import { SAMPLING_LEVELS, SCHEMA_ID, type SamplingLevel } from "./events";
import type { ValidationIssue } from "./validate";

export const DISCOVERY_SCHEMA_ID = "sonder.telemetry.producer/1";
/** Schema family without the major version, used to explain a major mismatch. */
export const DISCOVERY_SCHEMA_FAMILY = "sonder.telemetry.producer/";
export const WELL_KNOWN_DISCOVERY_PATH = "/.well-known/sonder-telemetry";

/** Required top-level fields, in schema order. */
export const DISCOVERY_REQUIRED_FIELDS = [
    "schema",
    "producer",
    "event_schema",
    "streams",
    "resume",
    "auth",
    "clock",
] as const;

/** Optional top-level fields the schema declares. */
export const DISCOVERY_OPTIONAL_FIELDS = ["sampling_level", "text_capture", "links", "vocabularies"] as const;

/** Required `producer` fields, in schema order. */
export const DISCOVERY_PRODUCER_FIELDS = ["name", "version", "node_id", "instance_id", "role", "synthetic"] as const;

export const DISCOVERY_PRODUCER_ROLES = ["inference", "runtime", "fixture"] as const;
export type DiscoveryProducerRole = (typeof DISCOVERY_PRODUCER_ROLES)[number];

export const STREAM_TRANSPORTS = ["sse", "ndjson", "websocket"] as const;
export type StreamTransport = (typeof STREAM_TRANSPORTS)[number];

/** Required `resume` fields, in schema order. */
export const RESUME_FIELDS = ["header", "query", "retained_events", "oldest_sequence", "next_sequence"] as const;
export const RESUME_HEADER = "Last-Event-ID";
export const RESUME_QUERY = "last_event_id";

export const AUTH_SCHEMES = ["bearer"] as const;
export const CLOCK_MONO_NS = "host-monotonic";

export interface DiscoveryProducer {
    name: string;
    version: string;
    node_id: string;
    instance_id: string;
    role: DiscoveryProducerRole;
    synthetic: boolean;
    [extra: string]: unknown;
}

export interface DiscoveryStream {
    transport: StreamTransport;
    /** Absolute, or relative to the discovery URL. */
    url: string;
    [extra: string]: unknown;
}

export interface ProducerDiscovery {
    schema: typeof DISCOVERY_SCHEMA_ID;
    producer: DiscoveryProducer;
    event_schema: typeof SCHEMA_ID;
    streams: DiscoveryStream[];
    resume: {
        header: typeof RESUME_HEADER;
        query: typeof RESUME_QUERY;
        retained_events: number;
        oldest_sequence: number | null;
        next_sequence: number;
        [extra: string]: unknown;
    };
    auth: { required: boolean; schemes: (typeof AUTH_SCHEMES)[number][]; [extra: string]: unknown };
    clock: { mono_ns: typeof CLOCK_MONO_NS; [extra: string]: unknown };
    sampling_level?: SamplingLevel;
    text_capture?: string;
    links?: Record<string, string>;
    /** Event vocabulary majors, e.g. {"sonder.runtime.events": 1}. */
    vocabularies?: Record<string, number>;
    /** Unknown additive fields are allowed and ignored. */
    [extra: string]: unknown;
}

export type DiscoveryValidationResult =
    | { ok: true; discovery: ProducerDiscovery; issues: [] }
    | { ok: false; issues: ValidationIssue[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function checkProducer(value: unknown, issues: ValidationIssue[]): void {
    if (!isPlainObject(value)) {
        issues.push({ path: "producer", message: "must be an object" });
        return;
    }
    for (const key of DISCOVERY_PRODUCER_FIELDS) {
        const path = `producer.${key}`;
        if (!(key in value)) {
            issues.push({ path, message: "is required" });
            continue;
        }
        const field = value[key];
        switch (key) {
            case "name":
            case "instance_id":
                if (typeof field !== "string" || field === "") {
                    issues.push({ path, message: "must be a non-empty string" });
                }
                break;
            case "version":
            case "node_id":
                if (typeof field !== "string") {
                    issues.push({ path, message: "must be a string" });
                }
                break;
            case "role":
                if (!(DISCOVERY_PRODUCER_ROLES as readonly unknown[]).includes(field)) {
                    issues.push({ path, message: `must be one of ${DISCOVERY_PRODUCER_ROLES.join(", ")}` });
                }
                break;
            case "synthetic":
                if (typeof field !== "boolean") {
                    issues.push({ path, message: "must be a boolean" });
                }
                break;
        }
    }
}

function checkStreams(value: unknown, issues: ValidationIssue[]): void {
    if (!Array.isArray(value)) {
        issues.push({ path: "streams", message: "must be an array" });
        return;
    }
    if (value.length === 0) {
        issues.push({ path: "streams", message: "must list at least one stream" });
    }
    value.forEach((stream: unknown, i) => {
        const path = `streams[${i}]`;
        if (!isPlainObject(stream)) {
            issues.push({ path, message: "must be an object" });
            return;
        }
        if (!(STREAM_TRANSPORTS as readonly unknown[]).includes(stream.transport)) {
            issues.push({ path: `${path}.transport`, message: `must be one of ${STREAM_TRANSPORTS.join(", ")}` });
        }
        if (typeof stream.url !== "string" || stream.url === "") {
            issues.push({ path: `${path}.url`, message: "must be a non-empty string" });
        }
    });
}

function checkResume(value: unknown, issues: ValidationIssue[]): void {
    if (!isPlainObject(value)) {
        issues.push({ path: "resume", message: "must be an object" });
        return;
    }
    for (const key of RESUME_FIELDS) {
        const path = `resume.${key}`;
        if (!(key in value)) {
            issues.push({ path, message: "is required" });
            continue;
        }
        const field = value[key];
        if (key === "header" && field !== RESUME_HEADER) {
            issues.push({ path, message: `must equal "${RESUME_HEADER}"` });
        } else if (key === "query" && field !== RESUME_QUERY) {
            issues.push({ path, message: `must equal "${RESUME_QUERY}"` });
        } else if ((key === "retained_events" || key === "next_sequence") && !isNonNegativeInteger(field)) {
            issues.push({ path, message: "must be an integer >= 0" });
        } else if (key === "oldest_sequence" && field !== null && !isNonNegativeInteger(field)) {
            issues.push({ path, message: "must be an integer >= 0 or null" });
        }
    }
}

function checkAuth(value: unknown, issues: ValidationIssue[]): void {
    if (!isPlainObject(value)) {
        issues.push({ path: "auth", message: "must be an object" });
        return;
    }
    if (!("required" in value)) {
        issues.push({ path: "auth.required", message: "is required" });
    } else if (typeof value.required !== "boolean") {
        issues.push({ path: "auth.required", message: "must be a boolean" });
    }
    if (!("schemes" in value)) {
        issues.push({ path: "auth.schemes", message: "is required" });
    } else if (
        !Array.isArray(value.schemes) ||
        !value.schemes.every((s) => (AUTH_SCHEMES as readonly unknown[]).includes(s))
    ) {
        issues.push({ path: "auth.schemes", message: `must be an array of ${AUTH_SCHEMES.join(", ")}` });
    }
}

function checkClock(value: unknown, issues: ValidationIssue[]): void {
    if (!isPlainObject(value)) {
        issues.push({ path: "clock", message: "must be an object" });
        return;
    }
    if (!("mono_ns" in value)) {
        issues.push({ path: "clock.mono_ns", message: "is required" });
    } else if (value.mono_ns !== CLOCK_MONO_NS) {
        issues.push({ path: "clock.mono_ns", message: `must equal "${CLOCK_MONO_NS}"` });
    }
}

function checkStringMap(value: unknown, path: string, issues: ValidationIssue[]): void {
    if (!isPlainObject(value)) {
        issues.push({ path, message: "must be an object" });
        return;
    }
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry !== "string" || entry === "") {
            issues.push({ path: `${path}.${key}`, message: "must be a non-empty string" });
        }
    }
}

function checkVocabularies(value: unknown, issues: ValidationIssue[]): void {
    if (!isPlainObject(value)) {
        issues.push({ path: "vocabularies", message: "must be an object" });
        return;
    }
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 1) {
            issues.push({ path: `vocabularies.${key}`, message: "must be an integer >= 1" });
        }
    }
}

/**
 * Validates a decoded discovery document against sonder.telemetry.producer/1
 * and returns the issue list (empty when valid). A different schema major or
 * event schema is reported with an explicit version message, so the UI can
 * say why the document was refused.
 */
export function validateDiscovery(value: unknown): ValidationIssue[] {
    if (!isPlainObject(value)) {
        return [{ path: "", message: "discovery document must be a JSON object" }];
    }
    const issues: ValidationIssue[] = [];
    for (const key of DISCOVERY_REQUIRED_FIELDS) {
        if (!(key in value)) {
            issues.push({ path: key, message: "is required" });
        }
    }
    if ("schema" in value && value.schema !== DISCOVERY_SCHEMA_ID) {
        const found = typeof value.schema === "string" ? value.schema : JSON.stringify(value.schema);
        issues.push({
            path: "schema",
            message:
                typeof value.schema === "string" && value.schema.startsWith(DISCOVERY_SCHEMA_FAMILY)
                    ? `unsupported discovery schema major "${found}" (this Observatory reads "${DISCOVERY_SCHEMA_ID}")`
                    : `must equal "${DISCOVERY_SCHEMA_ID}" (found ${found})`,
        });
    }
    if ("event_schema" in value && value.event_schema !== SCHEMA_ID) {
        issues.push({
            path: "event_schema",
            message: `unsupported event schema ${JSON.stringify(value.event_schema)} (this Observatory reads "${SCHEMA_ID}")`,
        });
    }
    if ("producer" in value) {
        checkProducer(value.producer, issues);
    }
    if ("streams" in value) {
        checkStreams(value.streams, issues);
    }
    if ("resume" in value) {
        checkResume(value.resume, issues);
    }
    if ("auth" in value) {
        checkAuth(value.auth, issues);
    }
    if ("clock" in value) {
        checkClock(value.clock, issues);
    }
    if ("sampling_level" in value && !(SAMPLING_LEVELS as readonly unknown[]).includes(value.sampling_level)) {
        issues.push({ path: "sampling_level", message: `must be one of ${SAMPLING_LEVELS.join(", ")}` });
    }
    if ("text_capture" in value && typeof value.text_capture !== "string") {
        issues.push({ path: "text_capture", message: "must be a string" });
    }
    if ("links" in value) {
        checkStringMap(value.links, "links", issues);
    }
    if ("vocabularies" in value) {
        checkVocabularies(value.vocabularies, issues);
    }
    return issues;
}

/** validateDiscovery plus the typed document when it is valid. */
export function parseDiscovery(value: unknown): DiscoveryValidationResult {
    const issues = validateDiscovery(value);
    return issues.length === 0 ? { ok: true, discovery: value as ProducerDiscovery, issues: [] } : { ok: false, issues };
}
