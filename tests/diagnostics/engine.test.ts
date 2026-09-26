import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_CASES, syntheticStream } from "../../src/diagnostics/fixtures";
import { DEFAULT_CONFIG, resolveConfig } from "../../src/diagnostics/types";
import { findBursts } from "../../src/diagnostics/util";
import type { ObservatoryEvent } from "../../src/protocol/events";
import { assertEvidence, runDiagnostics } from "./helpers";

describe("runDiagnostics", () => {
    const all = DIAGNOSTIC_CASES.flatMap((c) => c.events);

    it("is pure, order-independent and deterministic", () => {
        const copy = JSON.stringify(all);
        const a = runDiagnostics(all);
        const b = runDiagnostics([...all].reverse());
        expect(JSON.stringify(all)).toBe(copy);
        expect(b).toEqual(a);
        expect(new Set(a.map((f) => f.id)).size).toBe(a.length);
        assertEvidence(a, all);
    });

    it("orders findings by start time then severity", () => {
        const f = runDiagnostics(all);
        for (let i = 1; i < f.length; i++) {
            expect(f[i]!.startNs).toBeGreaterThanOrEqual(f[i - 1]!.startNs);
        }
    });

    it("restricts to selected detectors", () => {
        const f = runDiagnostics(all, { kinds: ["retry-storm"] });
        expect(f.length).toBeGreaterThan(0);
        expect(f.every((x) => x.kind === "retry-storm")).toBe(true);
    });

    it("returns nothing for an empty stream", () => {
        expect(runDiagnostics([])).toEqual([]);
    });

    const leadFixture = new URL("../../fixtures/synthetic-session.ndjson", import.meta.url);
    it.skipIf(!existsSync(leadFixture))("runs over the lead's synthetic session fixture with valid evidence", () => {
        const text = readFileSync(leadFixture, "utf8");
        const events = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ObservatoryEvent);
        const f = runDiagnostics(events);
        assertEvidence(f, events);
        const kinds = new Set(f.map((x) => x.kind));
        // The fixture contains a guard.budget_pressure (0.93) and kv.pressure (0.96).
        expect(kinds.has("budget-pressure")).toBe(true);
        expect(kinds.has("resource-pressure")).toBe(true);
        // Redacted tool args must never be treated as a loop.
        expect(kinds.has("no-progress-loop")).toBe(false);
    });
});

describe("config and burst helpers", () => {
    it("resolveConfig merges overrides without mutating defaults", () => {
        const c = resolveConfig({ retryStorm: { count: 9 } });
        expect(c.retryStorm).toEqual({ count: 9, windowMs: DEFAULT_CONFIG.retryStorm.windowMs });
        expect(DEFAULT_CONFIG.retryStorm.count).toBe(3);
    });

    it("findBursts marks only events inside a qualifying window", () => {
        const e = syntheticStream("bursts");
        const ev = [0, 100, 200, 5000, 9000, 9100, 9200, 9300].map((t) => e(t, "x"));
        const bursts = findBursts(ev, 3, 500);
        expect(bursts.map((b) => b.length)).toEqual([3, 4]);
        expect(findBursts(ev, 9, 500)).toEqual([]);
    });
});
