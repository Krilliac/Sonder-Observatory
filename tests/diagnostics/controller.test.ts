import { describe, expect, it } from "vitest";
import { FindingsController, type DiagnosticsSelectionHost } from "../../src/diagnostics/controller";
import { DIAGNOSTIC_CASES } from "../../src/diagnostics/fixtures";
import { runDiagnostics } from "./helpers";

function fakeHost() {
    const calls: { highlighted: string[][]; selected: string[] } = { highlighted: [], selected: [] };
    const host: DiagnosticsSelectionHost = {
        highlightEvents: (ids) => calls.highlighted.push([...ids]),
        selectEvent: (id) => calls.selected.push(id),
    };
    return { host, calls };
}

describe("FindingsController", () => {
    const findings = runDiagnostics(DIAGNOSTIC_CASES.flatMap((c) => c.events));

    it("selecting a finding highlights all evidence and inspects the first event", () => {
        const { host, calls } = fakeHost();
        const c = new FindingsController(host);
        c.setFindings(findings);
        const f = findings[0]!;
        c.select(f.id);
        expect(calls.highlighted.at(-1)).toEqual(f.evidenceEventIds);
        expect(calls.selected.at(-1)).toBe(f.evidenceEventIds[0]);
        expect(c.selected()?.id).toBe(f.id);
    });

    it("inspectEvidence only accepts evidence of the selected finding", () => {
        const { host, calls } = fakeHost();
        const c = new FindingsController(host);
        c.setFindings(findings);
        const f = findings.find((x) => x.evidenceEventIds.length > 1)!;
        c.select(f.id);
        c.inspectEvidence(f.evidenceEventIds[1]!);
        expect(calls.selected.at(-1)).toBe(f.evidenceEventIds[1]);
        const before = calls.selected.length;
        c.inspectEvidence("evt_not_evidence");
        expect(calls.selected.length).toBe(before);
    });

    it("filters by severity and kind, and navigates the visible list", () => {
        const { host } = fakeHost();
        const c = new FindingsController(host);
        c.setFindings(findings);
        c.filter = { minSeverity: "critical", kinds: [] };
        expect(c.visible().every((f) => f.severity === "critical")).toBe(true);
        c.filter = { minSeverity: "info", kinds: ["retry-storm"] };
        const vis = c.visible();
        expect(vis.every((f) => f.kind === "retry-storm")).toBe(true);
        c.move(1);
        expect(c.selected()?.id).toBe(vis[0]!.id);
        c.move(-1);
        expect(c.selected()?.id).toBe(vis[0]!.id);
    });

    it("clears highlight when the selected finding disappears, and counts severities", () => {
        const { host, calls } = fakeHost();
        const c = new FindingsController(host);
        c.setFindings(findings);
        c.select(findings[0]!.id);
        c.setFindings([]);
        expect(c.selected()).toBeUndefined();
        expect(calls.highlighted.at(-1)).toEqual([]);
        c.setFindings(findings);
        const counts = c.counts();
        expect(counts.info + counts.warning + counts.critical).toBe(findings.length);
    });
});
