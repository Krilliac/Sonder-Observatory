import {
    NULLABLE_ID_FIELDS,
    PRODUCER_OPTIONAL_FIELDS,
    PRODUCER_REQUIRED_FIELDS,
    SAMPLING_LEVELS,
    SCHEMA_ID,
    type ObservatoryEvent,
} from "./events";

export interface ValidationIssue {
    path: string;
    message: string;
}

export type ValidationResult =
    | { ok: true; event: ObservatoryEvent }
    | { ok: false; issues: ValidationIssue[] };

// RFC 3339 date-time as required by JSON Schema "format": "date-time".
const DATE_TIME =
    /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isValidDateTime(value: string): boolean {
    if (!DATE_TIME.test(value)) {
        return false;
    }
    return !Number.isNaN(Date.parse(value));
}

/**
 * Validates one decoded value against the v1 event envelope schema.
 * Unknown additional fields are accepted (the schema allows them) and the
 * original object is returned untouched so recordings stay lossless.
 */
export function validateEvent(value: unknown): ValidationResult {
    const issues: ValidationIssue[] = [];
    if (!isPlainObject(value)) {
        return { ok: false, issues: [{ path: "", message: "event must be a JSON object" }] };
    }

    if (!("schema" in value)) {
        issues.push({ path: "schema", message: "is required" });
    } else if (value.schema !== SCHEMA_ID) {
        issues.push({ path: "schema", message: `must equal "${SCHEMA_ID}"` });
    }

    for (const key of ["event_id", "event_type", "session_id"] as const) {
        if (!(key in value)) {
            issues.push({ path: key, message: "is required" });
        } else if (!isNonEmptyString(value[key])) {
            issues.push({ path: key, message: "must be a non-empty string" });
        }
    }

    for (const key of ["sequence", "mono_ns"] as const) {
        if (!(key in value)) {
            issues.push({ path: key, message: "is required" });
        } else if (!isNonNegativeInteger(value[key])) {
            issues.push({ path: key, message: "must be an integer >= 0" });
        }
    }

    if (!("wall_time" in value)) {
        issues.push({ path: "wall_time", message: "is required" });
    } else if (typeof value.wall_time !== "string" || !isValidDateTime(value.wall_time)) {
        issues.push({ path: "wall_time", message: "must be an RFC 3339 date-time string" });
    }

    for (const key of NULLABLE_ID_FIELDS) {
        if (key in value && value[key] !== null && typeof value[key] !== "string") {
            issues.push({ path: key, message: "must be a string or null" });
        }
    }

    if (!("producer" in value)) {
        issues.push({ path: "producer", message: "is required" });
    } else if (!isPlainObject(value.producer)) {
        issues.push({ path: "producer", message: "must be an object" });
    } else {
        for (const key of PRODUCER_REQUIRED_FIELDS) {
            if (!(key in value.producer)) {
                issues.push({ path: `producer.${key}`, message: "is required" });
            } else if (typeof value.producer[key] !== "string") {
                issues.push({ path: `producer.${key}`, message: "must be a string" });
            }
        }
        for (const [key, type] of Object.entries(PRODUCER_OPTIONAL_FIELDS)) {
            if (!(key in value.producer)) {
                continue;
            }
            const field = value.producer[key];
            if (typeof field !== type) {
                issues.push({ path: `producer.${key}`, message: `must be a ${type}` });
            } else if (key === "instance_id" && field === "") {
                issues.push({ path: `producer.${key}`, message: "must be a non-empty string" });
            }
        }
    }

    if ("sampling" in value) {
        const sampling = value.sampling;
        if (!isPlainObject(sampling)) {
            issues.push({ path: "sampling", message: "must be an object" });
        } else {
            if (
                "level" in sampling &&
                !(SAMPLING_LEVELS as readonly unknown[]).includes(sampling.level)
            ) {
                issues.push({
                    path: "sampling.level",
                    message: `must be one of ${SAMPLING_LEVELS.join(", ")}`,
                });
            }
            if ("sampled" in sampling && typeof sampling.sampled !== "boolean") {
                issues.push({ path: "sampling.sampled", message: "must be a boolean" });
            }
        }
    }

    if (!("attributes" in value)) {
        issues.push({ path: "attributes", message: "is required" });
    } else if (!isPlainObject(value.attributes)) {
        issues.push({ path: "attributes", message: "must be an object" });
    }

    if (issues.length > 0) {
        return { ok: false, issues };
    }
    return { ok: true, event: value as ObservatoryEvent };
}

export function formatIssues(issues: ValidationIssue[]): string {
    return issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ");
}
