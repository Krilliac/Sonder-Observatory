import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_CASES } from "../../src/diagnostics/fixtures";
import { FINDING_KINDS } from "../../src/diagnostics/types";
import { assertEvidence, detect } from "./helpers";

describe("labelled synthetic diagnostic cases", () => {
    it("covers every detector with a positive and a negative case", () => {
        for (const kind of FINDING_KINDS) {
            expect(DIAGNOSTIC_CASES.some((c) => c.kind === kind && c.expect === "positive"), kind).toBe(true);
            expect(DIAGNOSTIC_CASES.some((c) => c.kind === kind && c.expect === "negative"), kind).toBe(true);
        }
    });

    it("labels every event as synthetic with unique ids", () => {
        const ids = new Set<string>();
        for (const c of DIAGNOSTIC_CASES) {
            for (const e of c.events) {
                expect(e.producer.synthetic).toBe(true);
                expect(e.attributes.synthetic).toBe(true);
                expect(ids.has(e.event_id)).toBe(false);
                ids.add(e.event_id);
            }
        }
    });

    for (const c of DIAGNOSTIC_CASES) {
        it(`${c.expect}: ${c.label}`, () => {
            const findings = detect(c.kind, c.events);
            assertEvidence(findings, c.events);
            if (c.expect === "negative") {
                expect(findings).toEqual([]);
            } else {
                expect(findings.length).toBeGreaterThan(0);
                const cited = new Set(findings.flatMap((f) => f.evidenceEventIds));
                for (const id of c.mustCite ?? []) {
                    expect(cited.has(id), id).toBe(true);
                }
            }
        });
    }
});
