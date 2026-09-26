import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_SEED, generateEvents, generateNdjson, parseSize, PRESET_SIZES } from "../../scripts/gen-large-fixture.mjs";
import { validateEvent } from "../../src/protocol/validate";
import { deriveMetrics } from "../../src/query/metrics";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("scripts/gen-large-fixture.mjs", () => {
    it("is deterministic for a given count and seed", () => {
        expect(sha(generateNdjson(10_000))).toBe(sha(generateNdjson(10_000, DEFAULT_SEED)));
        expect(sha(generateNdjson(2_000, 7))).toBe(sha(generateNdjson(2_000, 7)));
    });

    it("changes with the seed", () => {
        expect(sha(generateNdjson(2_000, 1))).not.toBe(sha(generateNdjson(2_000, 2)));
    });

    it("emits exactly N schema-valid events in replay order", () => {
        const events = [...generateEvents(10_000)];
        expect(events).toHaveLength(10_000);
        expect(events[0]!.event_type).toBe("session.started");
        expect(events.at(-1)!.event_type).toBe("session.ended");
        const ids = new Set<string>();
        for (let i = 0; i < events.length; i += 1) {
            const e = events[i]!;
            expect(validateEvent(e).ok).toBe(true);
            expect(e.sequence).toBe(i);
            expect(e.producer.synthetic).toBe(true);
            if (i > 0) {
                expect(e.mono_ns).toBeGreaterThanOrEqual(events[i - 1]!.mono_ns);
            }
            ids.add(e.event_id);
        }
        expect(ids.size).toBe(events.length);
    });

    it("reports telemetry.dropped counts as a cumulative running total", () => {
        const events = [...generateEvents(100_000)];
        const counts = events
            .filter((e) => e.event_type === "telemetry.dropped")
            .map((e) => e.attributes.dropped_count as number);
        expect(counts.length).toBeGreaterThan(1);
        counts.forEach((count, i) => {
            if (i > 0) {
                expect(count).toBeGreaterThan(counts[i - 1]!);
            }
        });
        // One producer instance: the latest cumulative value is the total.
        expect(deriveMetrics(events).droppedEvents).toBe(counts.at(-1));
    });

    it("covers every timeline track that the viewer draws", () => {
        const types = new Set([...generateEvents(10_000)].map((e) => e.event_type.split(".")[0]));
        for (const prefix of ["session", "request", "inference", "agent", "tool", "device", "kv", "telemetry"]) {
            expect(types.has(prefix)).toBe(true);
        }
    });

    it("parses size presets", () => {
        expect(parseSize("10k")).toBe(PRESET_SIZES["10k"]);
        expect(parseSize("100k")).toBe(100_000);
        expect(parseSize("1m")).toBe(1_000_000);
        expect(parseSize("2500")).toBe(2_500);
        expect(() => parseSize("lots")).toThrow();
    });
});
