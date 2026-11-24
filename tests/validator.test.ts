import { describe, expect, it } from "vitest";
import {
    MAX_ATTRIBUTE_ARRAY_LENGTH,
    MAX_ATTRIBUTE_DEPTH,
    MAX_ATTRIBUTE_NODES,
    MAX_ATTRIBUTE_STRING_LENGTH,
} from "../src/protocol/events";
import { formatIssues, isLimitViolation, isValidDateTime, validateEvent } from "../src/protocol/validate";
import { makeEvent } from "./helpers";

function issuesOf(value: unknown): string[] {
    const r = validateEvent(value);
    return r.ok ? [] : r.issues.map((i) => i.path);
}

describe("validateEvent", () => {
    it("accepts a minimal valid envelope", () => {
        const r = validateEvent(makeEvent());
        expect(r.ok).toBe(true);
    });

    it("accepts the documented example envelope from TELEMETRY_PROTOCOL.md", () => {
        const r = validateEvent({
            schema: "sonder.observatory.event/1",
            event_id: "01J",
            sequence: 1842,
            event_type: "inference.token.generated",
            wall_time: "2026-09-26T05:00:00.123456Z",
            mono_ns: 9172231234,
            session_id: "ses_",
            run_id: "run_",
            request_id: "req_",
            producer: { name: "sonder-inference", version: "0.1.0", node_id: "main" },
            sampling: { level: "standard", sampled: true },
            attributes: {},
        });
        expect(r.ok).toBe(true);
    });

    it("preserves unknown additive fields untouched", () => {
        const input = { ...makeEvent(), span_id: "sp_1", future_field: { a: 1 } };
        const r = validateEvent(input);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.event).toBe(input);
            expect(r.event.future_field).toEqual({ a: 1 });
        }
    });

    it("rejects non-objects", () => {
        expect(issuesOf(null)).toEqual([""]);
        expect(issuesOf([])).toEqual([""]);
        expect(issuesOf("x")).toEqual([""]);
    });

    it("reports every missing required field", () => {
        expect(issuesOf({})).toEqual([
            "schema",
            "event_id",
            "event_type",
            "session_id",
            "sequence",
            "mono_ns",
            "wall_time",
            "producer",
            "attributes",
        ]);
    });

    it("rejects a different schema version", () => {
        expect(issuesOf(makeEvent({ schema: "sonder.observatory.event/2" as never }))).toEqual(["schema"]);
    });

    it("rejects negative, fractional and string clocks/sequences", () => {
        expect(issuesOf(makeEvent({ sequence: -1 }))).toEqual(["sequence"]);
        expect(issuesOf(makeEvent({ mono_ns: 1.5 }))).toEqual(["mono_ns"]);
        expect(issuesOf({ ...makeEvent(), sequence: "3" })).toEqual(["sequence"]);
    });

    it("rejects empty ids and bad wall_time", () => {
        expect(issuesOf(makeEvent({ event_id: "" }))).toEqual(["event_id"]);
        expect(issuesOf(makeEvent({ wall_time: "yesterday" }))).toEqual(["wall_time"]);
        expect(issuesOf(makeEvent({ wall_time: "2026-09-26 08:00:00" }))).toEqual(["wall_time"]);
    });

    it("allows null correlation ids but not numbers", () => {
        expect(validateEvent(makeEvent({ run_id: null, request_id: null })).ok).toBe(true);
        expect(issuesOf({ ...makeEvent(), request_id: 7 })).toEqual(["request_id"]);
    });

    it("validates producer and sampling objects", () => {
        expect(issuesOf({ ...makeEvent(), producer: { name: "p", version: "1" } })).toEqual(["producer.node_id"]);
        expect(issuesOf({ ...makeEvent(), producer: "p" })).toEqual(["producer"]);
        expect(issuesOf({ ...makeEvent(), sampling: { level: "verbose" } })).toEqual(["sampling.level"]);
        expect(issuesOf({ ...makeEvent(), sampling: { sampled: "yes" } })).toEqual(["sampling.sampled"]);
        expect(issuesOf({ ...makeEvent(), attributes: [] })).toEqual(["attributes"]);
    });

    it("formats issues readably", () => {
        const r = validateEvent({ ...makeEvent(), sequence: -1 });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(formatIssues(r.issues)).toBe("sequence: must be an integer >= 0");
            expect(isLimitViolation(r.issues)).toBe(false);
        }
    });

    it("enforces recursive bounds on attributes depth, node count, array length, and string length", () => {
        // Depth 8 container holding a scalar is allowed; depth 9 container is rejected.
        const nest = (levels: number): Record<string, unknown> => {
            let cur: Record<string, unknown> = { leaf: "ok" };
            for (let i = 0; i < levels; i += 1) {
                cur = { n: cur };
            }
            return cur;
        };
        expect(validateEvent(makeEvent({ attributes: nest(MAX_ATTRIBUTE_DEPTH) })).ok).toBe(true);
        const tooDeep = validateEvent(makeEvent({ attributes: nest(MAX_ATTRIBUTE_DEPTH + 1) }));
        expect(tooDeep.ok).toBe(false);
        if (!tooDeep.ok) {
            expect(formatIssues(tooDeep.issues)).toMatch(/maximum nesting depth/);
            expect(isLimitViolation(tooDeep.issues)).toBe(true);
        }

        // Array length 128 allowed; 129 rejected.
        expect(validateEvent(makeEvent({ attributes: { arr: Array.from({ length: MAX_ATTRIBUTE_ARRAY_LENGTH }, (_, i) => i) } })).ok).toBe(true);
        const tooWideArr = validateEvent(makeEvent({ attributes: { arr: Array.from({ length: MAX_ATTRIBUTE_ARRAY_LENGTH + 1 }, (_, i) => i) } }));
        expect(tooWideArr.ok).toBe(false);
        if (!tooWideArr.ok) {
            expect(formatIssues(tooWideArr.issues)).toMatch(/array exceeds maximum length/);
            expect(isLimitViolation(tooWideArr.issues)).toBe(true);
        }

        // 256 total nodes allowed; 257 rejected.
        const okNodes: Record<string, number> = {};
        for (let i = 0; i < MAX_ATTRIBUTE_NODES; i += 1) {
            okNodes[`k${i}`] = i;
        }
        expect(validateEvent(makeEvent({ attributes: okNodes })).ok).toBe(true);
        const tooManyNodes = validateEvent(makeEvent({ attributes: { ...okNodes, extra: 1 } }));
        expect(tooManyNodes.ok).toBe(false);
        if (!tooManyNodes.ok) {
            expect(formatIssues(tooManyNodes.issues)).toMatch(/maximum of 256 attribute nodes/);
            expect(isLimitViolation(tooManyNodes.issues)).toBe(true);
        }

        // String length 16 KiB allowed; 16 KiB + 1 rejected (values, keys, and top-level IDs).
        expect(validateEvent(makeEvent({ attributes: { s: "a".repeat(MAX_ATTRIBUTE_STRING_LENGTH) } })).ok).toBe(true);
        const tooLongVal = validateEvent(makeEvent({ attributes: { s: "a".repeat(MAX_ATTRIBUTE_STRING_LENGTH + 1) } }));
        expect(tooLongVal.ok).toBe(false);
        if (!tooLongVal.ok) {
            expect(formatIssues(tooLongVal.issues)).toMatch(/string exceeds maximum length/);
            expect(isLimitViolation(tooLongVal.issues)).toBe(true);
        }
        const tooLongKey = validateEvent(makeEvent({ attributes: { ["k".repeat(MAX_ATTRIBUTE_STRING_LENGTH + 1)]: 1 } }));
        expect(tooLongKey.ok).toBe(false);
        const tooLongEventId = validateEvent(makeEvent({ event_id: "e".repeat(MAX_ATTRIBUTE_STRING_LENGTH + 1) }));
        expect(tooLongEventId.ok).toBe(false);
    });
});

describe("isValidDateTime", () => {
    it("accepts RFC 3339 with offsets and fractions", () => {
        expect(isValidDateTime("2026-09-26T05:00:00Z")).toBe(true);
        expect(isValidDateTime("2026-09-26T05:00:00.123456789+02:00")).toBe(true);
    });
    it("rejects impossible dates", () => {
        expect(isValidDateTime("2026-13-40T05:00:00Z")).toBe(false);
    });
});
