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

/** Pages affect presentation only: all findings/evidence remain addressable. */
describe("FindingsController pagination", () => {
    function fixture(count: number) {
        const source = runDiagnostics(DIAGNOSTIC_CASES.flatMap((item) => item.events))[0]!;
        return Array.from({ length: count }, (_, index) => ({ ...source, id: `finding_${index}`,
            severity: index % 2 === 0 ? "critical" as const : "warning" as const,
            evidenceEventIds: Array.from({ length: 125 }, (_, evidence) => `evt_${index}_${evidence}`) }));
    }

    it("walks every finding exactly once through bounded pages without changing counts", () => {
        const { host } = fakeHost();
        const controller = new FindingsController(host);
        const findings = fixture(125);
        controller.setFindings(findings);
        const ids: string[] = [];
        for (let index = 0; index < 3; index += 1) {
            controller.setFindingsPage(index);
            const page = controller.findingsPage();
            expect(page.items.length).toBeLessThanOrEqual(50);
            expect(page.total).toBe(125);
            ids.push(...page.items.map((finding) => finding.id));
        }
        expect(ids).toEqual(findings.map((finding) => finding.id));
        expect(controller.visible()).toEqual(findings);
        expect(controller.counts()).toEqual({ info: 0, warning: 62, critical: 63 });
        controller.setFindingsPage(100);
        expect(controller.findingsPage().index).toBe(2);
    });

    it("keyboard selection reveals the next page and highlights all evidence", () => {
        const { host, calls } = fakeHost();
        const controller = new FindingsController(host);
        const findings = fixture(125);
        controller.setFindings(findings);
        controller.select("finding_49");
        const revision = controller.revision;
        controller.move(1);
        expect(controller.findingsPage().index).toBe(1);
        expect(controller.selected()?.id).toBe("finding_50");
        expect(controller.revision).toBeGreaterThan(revision);
        expect(calls.highlighted.at(-1)).toEqual(findings[50]!.evidenceEventIds);
        controller.move(-1);
        expect(controller.findingsPage().index).toBe(0);
    });

    it("evidence paging keeps selection and inspections available beyond the first page", () => {
        const { host, calls } = fakeHost();
        const controller = new FindingsController(host);
        controller.setFindings(fixture(2));
        controller.select("finding_0");
        controller.setEvidencePage(2);
        const page = controller.evidencePage();
        expect(page.items.length).toBe(25);
        expect(page.total).toBe(125);
        controller.inspectEvidence(page.items.at(-1)!);
        expect(calls.selected.at(-1)).toBe("evt_0_124");
        expect(controller.evidencePage().index).toBe(2);
        controller.select("finding_1");
        expect(controller.evidencePage().index).toBe(0);
    });

    it("filter changes reset paging and source replacement clamps both boundaries", () => {
        const { host, calls } = fakeHost();
        const controller = new FindingsController(host);
        const findings = fixture(125);
        controller.setFindings(findings);
        controller.setFindingsPage(2);
        const revision = controller.revision;
        controller.filter.minSeverity = "critical";
        expect(controller.revision).toBeGreaterThan(revision);
        expect(controller.findingsPage().index).toBe(0);
        expect(controller.findingsPage().total).toBe(63);
        controller.select("finding_124");
        controller.setEvidencePage(2);
        controller.setFindings([{ ...findings[124]!, evidenceEventIds: ["evt_124_0"] }]);
        expect(controller.selected()?.id).toBe("finding_124");
        expect(controller.findingsPage().index).toBe(0);
        expect(controller.evidencePage().index).toBe(0);
        controller.setFindings([]);
        expect(controller.selected()).toBeUndefined();
        expect(controller.findingsPage().items).toEqual([]);
        expect(calls.highlighted.at(-1)).toEqual([]);
    });
});
