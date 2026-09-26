import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    NULLABLE_ID_FIELDS,
    PRODUCER_OPTIONAL_FIELDS,
    PRODUCER_REQUIRED_FIELDS,
    REQUIRED_FIELDS,
    SAMPLING_LEVELS,
    SCHEMA_ID,
} from "../src/protocol/events";
import { validateEvent } from "../src/protocol/validate";

// protocol/observatory-events.schema.json is the source of truth; these tests
// fail if the hand-written TypeScript mirror drifts from it.
const schema = JSON.parse(
    readFileSync(fileURLToPath(new URL("../protocol/observatory-events.schema.json", import.meta.url)), "utf8"),
) as {
    required: string[];
    properties: Record<
        string,
        {
            const?: string;
            type?: string | string[];
            required?: string[];
            properties?: Record<string, { enum?: string[]; type?: string | string[]; minLength?: number }>;
        }
    >;
};

describe("protocol schema mirror", () => {
    it("uses the same schema id constant", () => {
        expect(schema.properties.schema!.const).toBe(SCHEMA_ID);
    });

    it("has the same required envelope fields", () => {
        expect([...REQUIRED_FIELDS]).toEqual(schema.required);
    });

    it("covers exactly the nullable correlation ids", () => {
        const nullable = Object.entries(schema.properties)
            .filter(([, p]) => Array.isArray(p.type) && p.type.includes("null"))
            .map(([k]) => k);
        expect([...NULLABLE_ID_FIELDS].sort()).toEqual(nullable.sort());
    });

    it("has the same sampling levels", () => {
        expect([...SAMPLING_LEVELS]).toEqual(schema.properties.sampling!.properties!.level!.enum);
    });

    it("requires the same producer fields", () => {
        const producer = { name: "p", version: "1", node_id: "n" };
        for (const key of schema.properties.producer!.required!) {
            const partial: Record<string, string> = { ...producer };
            delete partial[key];
            const r = validateEvent({
                schema: SCHEMA_ID,
                event_id: "e",
                sequence: 0,
                event_type: "t",
                wall_time: "2026-09-26T00:00:00Z",
                mono_ns: 0,
                session_id: "s",
                producer: partial,
                attributes: {},
            });
            expect(r.ok, `missing producer.${key} should be rejected`).toBe(false);
        }
    });

    it("declares the same producer properties and types", () => {
        const props = schema.properties.producer!.properties!;
        expect([...PRODUCER_REQUIRED_FIELDS]).toEqual(schema.properties.producer!.required);
        const optional = Object.keys(props).filter((k) => !schema.properties.producer!.required!.includes(k));
        expect(Object.keys(PRODUCER_OPTIONAL_FIELDS).sort()).toEqual(optional.sort());
        for (const [key, type] of Object.entries(PRODUCER_OPTIONAL_FIELDS)) {
            // Optional producer fields also accept null ("not stated").
            expect(props[key]!.type, `producer.${key}`).toEqual([type, "null"]);
        }
        expect(props.instance_id!.minLength).toBe(1);
    });

    it("rejects producer optional fields of the wrong type", () => {
        const event = (producer: Record<string, unknown>) =>
            validateEvent({
                schema: SCHEMA_ID,
                event_id: "e",
                sequence: 0,
                event_type: "t",
                wall_time: "2026-09-26T00:00:00Z",
                mono_ns: 0,
                session_id: "s",
                producer: { name: "p", version: "1", node_id: "n", ...producer },
                attributes: {},
            }).ok;
        expect(event({ instance_id: "rt-0123456789ab", role: "runtime", synthetic: false })).toBe(true);
        expect(event({ role: "some-future-role" })).toBe(true);
        expect(event({ instance_id: null, role: null, synthetic: null })).toBe(true);
        expect(event({ instance_id: "" })).toBe(false);
        expect(event({ instance_id: 7 })).toBe(false);
        expect(event({ role: 1 })).toBe(false);
        expect(event({ synthetic: "yes" })).toBe(false);
    });

    it("rejects an event missing any schema-required field", () => {
        const base: Record<string, unknown> = {
            schema: SCHEMA_ID,
            event_id: "e",
            sequence: 0,
            event_type: "t",
            wall_time: "2026-09-26T00:00:00Z",
            mono_ns: 0,
            session_id: "s",
            producer: { name: "p", version: "1", node_id: "n" },
            attributes: {},
        };
        expect(validateEvent(base).ok).toBe(true);
        for (const key of schema.required) {
            const copy = { ...base };
            delete copy[key];
            expect(validateEvent(copy).ok, `missing ${key}`).toBe(false);
        }
    });
});
