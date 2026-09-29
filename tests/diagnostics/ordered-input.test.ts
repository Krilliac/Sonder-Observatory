import { describe, expect, it } from "vitest";
import { generateEvents } from "../../scripts/gen-large-fixture.mjs";
import { runDiagnostics } from "../../src/diagnostics";
import { DIAGNOSTIC_CASES } from "../../src/diagnostics/fixtures";
import type { ObservatoryEvent } from "../../src/protocol/events";
import { isOrdered } from "../../src/replay/lookup";
import { orderEvents } from "../../src/replay/order";
import { SessionStore } from "../../src/replay/session";

describe("runDiagnostics on already-ordered session arrays", () => {
    it("equals the result for the same events in any order", () => {
        const all = DIAGNOSTIC_CASES.flatMap((c) => c.events);
        const ordered = orderEvents(all).events;
        expect(isOrdered(ordered)).toBe(true);
        const expected = runDiagnostics([...all].reverse());
        expect(expected.length).toBeGreaterThan(0);
        expect(runDiagnostics(ordered)).toEqual(expected);
    });

    it("equals the result for an unmarked copy of a large store array", () => {
        const store = new SessionStore();
        store.reset("file", "test");
        store.append([...generateEvents(30_000, 21)] as ObservatoryEvent[]);
        expect(isOrdered(store.events)).toBe(true);
        const findings = runDiagnostics(store.events);
        expect(findings.length).toBeGreaterThan(0);
        expect(findings).toEqual(runDiagnostics([...store.events]));
    });

    it("never marks a caller's own array", () => {
        const events = [...DIAGNOSTIC_CASES[0]!.events];
        runDiagnostics(events);
        expect(isOrdered(events)).toBe(false);
    });
});
