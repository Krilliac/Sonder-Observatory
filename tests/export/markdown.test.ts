import { describe, expect, it } from "vitest";
import { buildReport, mdEscape, renderExport, renderMarkdown } from "../../src/export";
import { fixtureEvents, GENERATED_AT } from "./fixture";

const events = fixtureEvents();

describe("markdown summary", () => {
    it("matches the fixture snapshot", async () => {
        const md = renderExport("markdown", { events, generatedAt: GENERATED_AT }).content;
        await expect(md).toMatchFileSnapshot("__snapshots__/synthetic-session.summary.md");
    });

    it("fits in a GitHub comment and cites every finding", () => {
        const report = buildReport({ events, generatedAt: GENERATED_AT });
        const md = renderMarkdown(report);
        expect(md.length).toBeLessThan(65_536);
        for (const f of report.findings) {
            expect(md).toContain(f.id);
            expect(md).toContain(f.evidenceEventIds[0]!);
        }
    });

    it("caps findings and evidence lists", () => {
        const report = buildReport({ events, generatedAt: GENERATED_AT });
        const md = renderMarkdown(report, { maxFindings: 1, maxEvidencePerFinding: 2 });
        expect(md).toContain(`…and ${report.findings.length - 1} more findings`);
        const first = report.findings[0]!;
        if (first.evidence.length > 2) {
            expect(md).toContain(`…${first.evidence.length - 2} more`);
        }
    });

    it("escapes table-breaking and markup characters", () => {
        expect(mdEscape("a|b\n<c>*d*`e`[f]")).toBe("a\\|b \\<c\\>\\*d\\*\\`e\\`\\[f\\]");
    });

    it("notes a filtered range", () => {
        const md = renderExport("markdown", { events, range: { cls: "error" }, generatedAt: GENERATED_AT }).content;
        expect(md).toContain(`of ${events.length}`);
        expect(md).toContain("class=error");
    });
});
