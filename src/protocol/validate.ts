import {
    MAX_ATTRIBUTE_ARRAY_LENGTH,
    MAX_ATTRIBUTE_DEPTH,
    MAX_ATTRIBUTE_NODES,
    MAX_ATTRIBUTE_STRING_LENGTH,
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
    /** Present when rejection was triggered by a size/depth/complexity limit. */
    code?: "limit";
}

export type ValidationResult =
    | { ok: true; event: ObservatoryEvent }
    | { ok: false; issues: ValidationIssue[] };

/** True when any validation issue was triggered by a structural size/depth/complexity cap. */
export function isLimitViolation(issues: readonly ValidationIssue[]): boolean {
    return issues.some((issue) => issue.code === "limit");
}

const REQUIRED_STRING_FIELDS = ["event_id", "event_type", "session_id"] as const;
const REQUIRED_INT_FIELDS = ["sequence", "mono_ns"] as const;
const PRODUCER_OPTIONAL_ENTRIES = Object.entries(PRODUCER_OPTIONAL_FIELDS) as readonly [
    keyof typeof PRODUCER_OPTIONAL_FIELDS,
    (typeof PRODUCER_OPTIONAL_FIELDS)[keyof typeof PRODUCER_OPTIONAL_FIELDS],
][];

// RFC 3339 date-time as required by JSON Schema "format": "date-time".
const DATE_TIME =
    /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
let lastValidDateTime = "";

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
    if (value === lastValidDateTime && value.length > 0) {
        return true;
    }
    if (!DATE_TIME.test(value)) {
        return false;
    }
    if (Number.isNaN(Date.parse(value))) {
        return false;
    }
    if (value.length <= 64) {
        lastValidDateTime = value;
    }
    return true;
}

const HAS_OWN = Object.prototype.hasOwnProperty;

/** Returns the first attribute structural limit violation, or null when valid. Zero path strings allocated on the valid fast path. */
function findAttributeLimitIssue(
    value: unknown,
    depth: number,
    state: { nodes: number },
    segments: (string | number)[],
): ValidationIssue | null {
    const buildPath = (): string => {
        let p = "attributes";
        for (let i = 0; i < segments.length; i += 1) {
            const seg = segments[i]!;
            p += typeof seg === "number" ? `[${seg}]` : `.${seg}`;
        }
        return p;
    };
    if (typeof value === "string") {
        if (value.length > MAX_ATTRIBUTE_STRING_LENGTH) {
            return {
                path: buildPath(),
                message: `string exceeds maximum length of ${MAX_ATTRIBUTE_STRING_LENGTH} characters`,
                code: "limit",
            };
        }
        return null;
    }
    if (value === null || typeof value !== "object") {
        return null;
    }
    if (depth > MAX_ATTRIBUTE_DEPTH) {
        return {
            path: buildPath(),
            message: `exceeds maximum nesting depth of ${MAX_ATTRIBUTE_DEPTH}`,
            code: "limit",
        };
    }
    if (Array.isArray(value)) {
        if (value.length > MAX_ATTRIBUTE_ARRAY_LENGTH) {
            return {
                path: buildPath(),
                message: `array exceeds maximum length of ${MAX_ATTRIBUTE_ARRAY_LENGTH}`,
                code: "limit",
            };
        }
        for (let i = 0; i < value.length; i += 1) {
            state.nodes += 1;
            if (state.nodes > MAX_ATTRIBUTE_NODES) {
                return {
                    path: "attributes",
                    message: `exceeds maximum of ${MAX_ATTRIBUTE_NODES} attribute nodes`,
                    code: "limit",
                };
            }
            const elem = value[i];
            if (typeof elem === "string") {
                if (elem.length > MAX_ATTRIBUTE_STRING_LENGTH) {
                    segments.push(i);
                    const issue: ValidationIssue = {
                        path: buildPath(),
                        message: `string exceeds maximum length of ${MAX_ATTRIBUTE_STRING_LENGTH} characters`,
                        code: "limit",
                    };
                    segments.pop();
                    return issue;
                }
            } else if (elem !== null && typeof elem === "object") {
                segments.push(i);
                const issue = findAttributeLimitIssue(elem, depth + 1, state, segments);
                segments.pop();
                if (issue) {
                    return issue;
                }
            }
        }
        return null;
    }
    const obj = value as Record<string, unknown>;
    for (const key in obj) {
        if (!HAS_OWN.call(obj, key)) {
            continue;
        }
        state.nodes += 1;
        if (state.nodes > MAX_ATTRIBUTE_NODES) {
            return {
                path: "attributes",
                message: `exceeds maximum of ${MAX_ATTRIBUTE_NODES} attribute nodes`,
                code: "limit",
            };
        }
        if (key.length > MAX_ATTRIBUTE_STRING_LENGTH) {
            segments.push(key.slice(0, 64));
            const issue: ValidationIssue = {
                path: buildPath(),
                message: `property name exceeds maximum length of ${MAX_ATTRIBUTE_STRING_LENGTH} characters`,
                code: "limit",
            };
            segments.pop();
            return issue;
        }
        const prop = obj[key];
        if (typeof prop === "string") {
            if (prop.length > MAX_ATTRIBUTE_STRING_LENGTH) {
                segments.push(key);
                const issue: ValidationIssue = {
                    path: buildPath(),
                    message: `string exceeds maximum length of ${MAX_ATTRIBUTE_STRING_LENGTH} characters`,
                    code: "limit",
                };
                segments.pop();
                return issue;
            }
        } else if (prop !== null && typeof prop === "object") {
            segments.push(key);
            const issue = findAttributeLimitIssue(prop, depth + 1, state, segments);
            segments.pop();
            if (issue) {
                return issue;
            }
        }
    }
    return null;
}

const ATTR_SEGMENTS: (string | number)[] = [];
const ATTR_STATE = { nodes: 0 };

function validateAttributes(attributes: Record<string, unknown>): ValidationIssue | null {
    ATTR_STATE.nodes = 0;
    ATTR_SEGMENTS.length = 0;
    try {
        return findAttributeLimitIssue(attributes, 0, ATTR_STATE, ATTR_SEGMENTS);
    } finally {
        ATTR_SEGMENTS.length = 0;
    }
}

/**
 * Validates one decoded value against the v1 event envelope schema.
 * Unknown additional fields are accepted (the schema allows them) and the
 * original object is returned untouched so recordings stay lossless.
 */
export function validateEvent(value: unknown): ValidationResult {
    if (!isPlainObject(value)) {
        return { ok: false, issues: [{ path: "", message: "event must be a JSON object" }] };
    }
    let issues: ValidationIssue[] | null = null;
    const addIssue = (issue: ValidationIssue): void => {
        if (issues === null) {
            issues = [issue];
        } else {
            issues.push(issue);
        }
    };

    if (!("schema" in value)) {
        addIssue({ path: "schema", message: "is required" });
    } else if (value.schema !== SCHEMA_ID) {
        addIssue({ path: "schema", message: `must equal "${SCHEMA_ID}"` });
    }

    for (let i = 0; i < REQUIRED_STRING_FIELDS.length; i += 1) {
        const key = REQUIRED_STRING_FIELDS[i]!;
        if (!(key in value)) {
            addIssue({ path: key, message: "is required" });
        } else if (!isNonEmptyString(value[key])) {
            addIssue({ path: key, message: "must be a non-empty string" });
        } else if (value[key].length > MAX_ATTRIBUTE_STRING_LENGTH) {
            addIssue({
                path: key,
                message: `string exceeds maximum length of ${MAX_ATTRIBUTE_STRING_LENGTH} characters`,
                code: "limit",
            });
        }
    }

    for (let i = 0; i < REQUIRED_INT_FIELDS.length; i += 1) {
        const key = REQUIRED_INT_FIELDS[i]!;
        if (!(key in value)) {
            addIssue({ path: key, message: "is required" });
        } else if (!isNonNegativeInteger(value[key])) {
            addIssue({ path: key, message: "must be an integer >= 0" });
        }
    }

    if (!("wall_time" in value)) {
        addIssue({ path: "wall_time", message: "is required" });
    } else if (typeof value.wall_time !== "string" || !isValidDateTime(value.wall_time)) {
        addIssue({ path: "wall_time", message: "must be an RFC 3339 date-time string" });
    }

    for (let i = 0; i < NULLABLE_ID_FIELDS.length; i += 1) {
        const key = NULLABLE_ID_FIELDS[i]!;
        const field = value[key];
        if (field !== undefined && field !== null) {
            if (typeof field !== "string") {
                addIssue({ path: key, message: "must be a string or null" });
            } else if (field.length > MAX_ATTRIBUTE_STRING_LENGTH) {
                addIssue({
                    path: key,
                    message: `string exceeds maximum length of ${MAX_ATTRIBUTE_STRING_LENGTH} characters`,
                    code: "limit",
                });
            }
        } else if (field === undefined && key in value) {
            addIssue({ path: key, message: "must be a string or null" });
        }
    }

    if (!("producer" in value)) {
        addIssue({ path: "producer", message: "is required" });
    } else if (!isPlainObject(value.producer)) {
        addIssue({ path: "producer", message: "must be an object" });
    } else {
        const producer = value.producer;
        for (let i = 0; i < PRODUCER_REQUIRED_FIELDS.length; i += 1) {
            const key = PRODUCER_REQUIRED_FIELDS[i]!;
            if (!(key in producer)) {
                addIssue({ path: `producer.${key}`, message: "is required" });
            } else if (typeof producer[key] !== "string") {
                addIssue({ path: `producer.${key}`, message: "must be a string" });
            }
        }
        for (let i = 0; i < PRODUCER_OPTIONAL_ENTRIES.length; i += 1) {
            const [key, type] = PRODUCER_OPTIONAL_ENTRIES[i]!;
            if (!(key in producer)) {
                continue;
            }
            const field = producer[key];
            if (field === null) {
                continue; // "not stated"
            }
            if (typeof field !== type) {
                addIssue({ path: `producer.${key}`, message: `must be a ${type} or null` });
            } else if (key === "instance_id" && field === "") {
                addIssue({ path: `producer.${key}`, message: "must be a non-empty string" });
            }
        }
    }

    if ("sampling" in value) {
        const sampling = value.sampling;
        if (!isPlainObject(sampling)) {
            addIssue({ path: "sampling", message: "must be an object" });
        } else {
            if (
                "level" in sampling &&
                !(SAMPLING_LEVELS as readonly unknown[]).includes(sampling.level)
            ) {
                addIssue({
                    path: "sampling.level",
                    message: `must be one of ${SAMPLING_LEVELS.join(", ")}`,
                });
            }
            if ("sampled" in sampling && typeof sampling.sampled !== "boolean") {
                addIssue({ path: "sampling.sampled", message: "must be a boolean" });
            }
        }
    }

    if (!("attributes" in value)) {
        addIssue({ path: "attributes", message: "is required" });
    } else if (!isPlainObject(value.attributes)) {
        addIssue({ path: "attributes", message: "must be an object" });
    } else {
        const attrIssue = validateAttributes(value.attributes);
        if (attrIssue !== null) {
            addIssue(attrIssue);
        }
    }

    if (issues !== null) {
        return { ok: false, issues };
    }
    return { ok: true, event: value as ObservatoryEvent };
}

export function formatIssues(issues: ValidationIssue[]): string {
    return issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ");
}
