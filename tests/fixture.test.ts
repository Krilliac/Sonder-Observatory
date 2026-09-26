import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyEvent } from "../src/query/classify";
import { deriveMetrics } from "../src/query/metrics";
import { parseNdjson } from "../src/recording/ndjson";
import { isSyntheticProducer } from "../src/recording/sobs";
import { findSequenceGaps, orderEvents } from "../src/replay/order";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = join(root, "fixtures/synthetic-session.ndjson");
const text = readFileSync(fixturePath, "utf8");
const parsed = parseNdjson(text);

describe("synthetic fixture", () => {
    it("parses with zero rejected lines", () => {
        expect(parsed.rejected).toEqual([]);
        expect(parsed.events.length).toBeGreaterThan(400);
    });

    it("labels every event as synthetic", () => {
        expect(parsed.events.every((e) => isSyntheticProducer(e.producer))).toBe(true);
        expect(parsed.events[0]!.event_type).toBe("session.started");
        expect(parsed.events[0]!.attributes.synthetic).toBe(true);
    });

    it("has unique ids, contiguous sequences and is already in replay order", () => {
        const ordered = orderEvents(parsed.events);
        expect(ordered.duplicates).toBe(0);
        expect(findSequenceGaps(parsed.events)).toEqual([]);
        expect(ordered.events.map((e) => e.event_id)).toEqual(parsed.events.map((e) => e.event_id));
    });

    it("covers the Milestone 1 success-gate signals", () => {
        const classes = new Set(parsed.events.map(classifyEvent));
        for (const c of ["session", "request", "inference", "agent", "tool", "resource", "error", "telemetry"]) {
            expect(classes.has(c as never), c).toBe(true);
        }
        const m = deriveMetrics(parsed.events);
        expect(m.requestLatency.count).toBe(10); // request latency
        expect(m.tokens.total).toBeGreaterThan(200); // token rate
        expect(m.tokens.overallRate).not.toBeNull();
        expect(m.errors.byType["request.failed"]).toBe(1); // errors
        expect(m.errors.byType["tool.failed"]).toBe(1);
        expect(m.agents.spawned).toBe(3); // agent/tool transitions
        expect(m.agents.active).toEqual([]);
        expect(m.tools.called).toBe(3);
        expect(m.resources.peak!.fraction).toBeGreaterThan(0.9); // resource pressure
        expect(m.resources.pressureEvents).toBe(2);
        expect(m.droppedEvents).toBe(3);
    });

    it("is reproducible: the generator output is byte-identical across runs", () => {
        const dir = mkdtempSync(join(tmpdir(), "sobs-fixture-"));
        try {
            const a = join(dir, "a.ndjson");
            const b = join(dir, "b.ndjson");
            execFileSync(process.execPath, [join(root, "scripts/generate-fixture.mjs"), a]);
            execFileSync(process.execPath, [join(root, "scripts/generate-fixture.mjs"), b]);
            expect(readFileSync(a, "utf8")).toBe(readFileSync(b, "utf8"));
            expect(readFileSync(a, "utf8")).toBe(text.replace(/\r\n/g, "\n"));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
