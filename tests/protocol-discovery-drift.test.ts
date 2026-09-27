import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    AUTH_SCHEMES,
    CLOCK_MONO_NS,
    DISCOVERY_OPTIONAL_FIELDS,
    DISCOVERY_PRODUCER_FIELDS,
    DISCOVERY_PRODUCER_ROLES,
    DISCOVERY_REQUIRED_FIELDS,
    DISCOVERY_SCHEMA_ID,
    RESUME_FIELDS,
    RESUME_HEADER,
    RESUME_QUERY,
    STREAM_TRANSPORTS,
    parseDiscovery,
    validateDiscovery,
} from "../src/protocol/discovery";
import { SAMPLING_LEVELS, SCHEMA_ID } from "../src/protocol/events";

// protocol/producer-discovery.schema.json is the source of truth; these tests
// fail if the hand-written TypeScript mirror (src/protocol/discovery.ts)
// drifts from it in either direction.
interface SchemaNode {
    const?: string;
    enum?: string[];
    type?: string | string[];
    minimum?: number;
    minLength?: number;
    minItems?: number;
    required?: string[];
    properties?: Record<string, SchemaNode>;
    items?: SchemaNode;
    additionalProperties?: boolean | SchemaNode;
}

const schema = JSON.parse(
    readFileSync(fileURLToPath(new URL("../protocol/producer-discovery.schema.json", import.meta.url)), "utf8"),
) as SchemaNode & { properties: Record<string, SchemaNode>; required: string[] };

const props = schema.properties;

/** A minimal valid document, built from the mirror's constants. */
function validDocument(): Record<string, unknown> {
    return {
        schema: DISCOVERY_SCHEMA_ID,
        producer: {
            name: "sonder-runtime",
            version: "1.0.0",
            node_id: "host",
            instance_id: "rt-0123456789ab",
            role: "runtime",
            synthetic: false,
        },
        event_schema: SCHEMA_ID,
        streams: [{ transport: "sse", url: "/v1/observability/events" }],
        resume: {
            header: RESUME_HEADER,
            query: RESUME_QUERY,
            retained_events: 0,
            oldest_sequence: null,
            next_sequence: 0,
        },
        auth: { required: false, schemes: ["bearer"] },
        clock: { mono_ns: CLOCK_MONO_NS },
    };
}

describe("producer discovery schema mirror", () => {
    it("uses the same schema ids", () => {
        expect(props.schema!.const).toBe(DISCOVERY_SCHEMA_ID);
        expect(props.event_schema!.const).toBe(SCHEMA_ID);
    });

    it("has the same required and optional top-level fields", () => {
        expect([...DISCOVERY_REQUIRED_FIELDS]).toEqual(schema.required);
        const optional = Object.keys(props).filter((k) => !schema.required.includes(k));
        expect([...DISCOVERY_OPTIONAL_FIELDS].sort()).toEqual(optional.sort());
        expect(schema.additionalProperties).toBe(true);
    });

    it("has the same producer fields and roles", () => {
        const producer = props.producer!;
        expect([...DISCOVERY_PRODUCER_FIELDS]).toEqual(producer.required);
        expect(Object.keys(producer.properties!)).toEqual(producer.required);
        expect([...DISCOVERY_PRODUCER_ROLES]).toEqual(producer.properties!.role!.enum);
        expect(producer.additionalProperties).toBe(true);
    });

    it("has the same stream transports", () => {
        const stream = props.streams!.items!;
        expect(props.streams!.minItems).toBe(1);
        expect(stream.required).toEqual(["transport", "url"]);
        expect([...STREAM_TRANSPORTS]).toEqual(stream.properties!.transport!.enum);
    });

    it("has the same resume, auth and clock shapes", () => {
        const resume = props.resume!;
        expect([...RESUME_FIELDS]).toEqual(resume.required);
        expect(Object.keys(resume.properties!)).toEqual(resume.required);
        expect(resume.properties!.header!.const).toBe(RESUME_HEADER);
        expect(resume.properties!.query!.const).toBe(RESUME_QUERY);
        expect(resume.properties!.oldest_sequence!.type).toEqual(["integer", "null"]);
        expect(props.auth!.required).toEqual(["required", "schemes"]);
        expect([...AUTH_SCHEMES]).toEqual(props.auth!.properties!.schemes!.items!.enum);
        expect(props.clock!.required).toEqual(["mono_ns"]);
        expect(props.clock!.properties!.mono_ns!.const).toBe(CLOCK_MONO_NS);
    });

    it("has the same sampling levels", () => {
        expect([...SAMPLING_LEVELS]).toEqual(props.sampling_level!.enum);
    });

    it("accepts the minimal valid document and unknown additive keys", () => {
        expect(validateDiscovery(validDocument())).toEqual([]);
        const extra = {
            ...validDocument(),
            future: { anything: 1 },
            links: { ecosystem: "/v1/sonder/ecosystem" },
            vocabularies: { "sonder.runtime.events": 1 },
            sampling_level: "metrics",
            text_capture: "none",
        };
        expect(parseDiscovery(extra).ok).toBe(true);
    });

    it("rejects a document missing any schema-required field", () => {
        for (const key of schema.required) {
            const copy = validDocument();
            delete copy[key];
            expect(validateDiscovery(copy).map((i) => i.path), `missing ${key}`).toContain(key);
        }
    });

    it("rejects a document missing any schema-required nested field", () => {
        for (const [parent, node] of Object.entries(props)) {
            for (const key of node.required ?? []) {
                const copy = validDocument();
                const nested = { ...(copy[parent] as Record<string, unknown>) };
                delete nested[key];
                copy[parent] = nested;
                expect(validateDiscovery(copy).map((i) => i.path), `missing ${parent}.${key}`).toContain(
                    `${parent}.${key}`,
                );
            }
        }
    });

    it("refuses another schema major or event schema with a version message", () => {
        const v2 = { ...validDocument(), schema: "sonder.telemetry.producer/2" };
        expect(validateDiscovery(v2)[0]!.message).toMatch(/unsupported discovery schema major/);
        const ev2 = { ...validDocument(), event_schema: "sonder.observatory.event/2" };
        expect(validateDiscovery(ev2)[0]!.message).toMatch(/unsupported event schema/);
    });

    it("rejects wrong types in constrained fields", () => {
        const bad = (patch: Record<string, unknown>) => validateDiscovery({ ...validDocument(), ...patch }).length > 0;
        const producer = validDocument().producer as Record<string, unknown>;
        expect(bad({ producer: { ...producer, role: "relay" } })).toBe(true);
        expect(bad({ producer: { ...producer, synthetic: "no" } })).toBe(true);
        expect(bad({ producer: { ...producer, instance_id: "" } })).toBe(true);
        expect(bad({ streams: [] })).toBe(true);
        expect(bad({ streams: [{ transport: "grpc", url: "/x" }] })).toBe(true);
        expect(bad({ auth: { required: true, schemes: ["basic"] } })).toBe(true);
        expect(bad({ clock: { mono_ns: "wall" } })).toBe(true);
        expect(bad({ sampling_level: "verbose" })).toBe(true);
        expect(bad({ vocabularies: { "sonder.runtime.events": 0 } })).toBe(true);
        expect(bad({ links: { health: 3 } })).toBe(true);
        expect(validateDiscovery([])).toHaveLength(1);
    });
});
