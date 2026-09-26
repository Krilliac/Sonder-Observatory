import { expect, test } from "@playwright/test";
import { FIXTURE_EVENTS, cursorX, inspectorEventId, openFixture, showView, shot, visibleCount } from "./helpers";

test.describe("Diagnostics tab", () => {
    test.beforeEach(async ({ page }) => {
        await openFixture(page, "view=diagnostics");
    });

    test("?view=diagnostics opens it and lists findings", async ({ page }, testInfo) => {
        await expect(page.getByRole("tab", { name: "Diagnostics" })).toHaveAttribute("aria-selected", "true");
        await expect(page.locator("#view-diagnostics")).toBeVisible();
        await expect(page.locator("#view-agents")).toBeHidden();
        const findings = page.locator("#view-diagnostics .diag-finding");
        expect(await findings.count()).toBeGreaterThan(0);
        await expect(page.locator("#view-diagnostics .provenance")).toContainText("Synthetic session.");
        // Severity is shown as text, not colour alone.
        await expect(findings.first().locator(".sev-label")).toHaveText(/^(INFO|WARN|CRIT)$/);
        await page.locator("#view-diagnostics").scrollIntoViewIfNeeded();
        await shot(page, testInfo, "tab-diagnostics");
    });

    test("clicking a finding highlights evidence and moves the cursor", async ({ page }, testInfo) => {
        await showView(page, "Overview");
        const endX = await cursorX(page);
        await showView(page, "Diagnostics");
        const finding = page.locator("#view-diagnostics .diag-finding").first();
        const evidenceCount = Number(/\((\d+) evidence event/.exec((await finding.textContent()) ?? "")?.[1]);
        expect(evidenceCount).toBeGreaterThan(0);
        await finding.click();

        const selected = page.locator("#view-diagnostics .diag-finding.selected");
        await expect(selected).toHaveCount(1);
        await expect(selected).toHaveAttribute("aria-current", "true");
        await expect(selected).toHaveAttribute("aria-expanded", "true");
        await expect(page.locator("#view-diagnostics .diag-finding[aria-current]")).toHaveCount(1);
        const evidenceList = page.locator("#view-diagnostics ul.diag-evidence");
        await expect(evidenceList).toHaveAttribute("id", (await selected.getAttribute("aria-controls"))!);
        const evidenceButtons = evidenceList.locator("button");
        await expect(evidenceButtons).toHaveCount(evidenceCount);

        // Cursor moved to the first evidence event and the docked inspector shows it.
        await expect(page.locator("#follow-check")).not.toBeChecked();
        const firstEvidence = ((await evidenceButtons.first().textContent()) ?? "").trim();
        await expect(inspectorEventId(page)).toHaveText(firstEvidence);
        expect(await visibleCount(page)).toBeLessThan(FIXTURE_EVENTS);
        await shot(page, testInfo, "diagnostics-finding-selected");

        // Evidence is highlighted in the timeline (all of it) and table (up to the cursor).
        await showView(page, "Overview");
        expect(await page.locator("#timeline rect.tick.evidence").count()).toBeGreaterThan(0);
        expect(await cursorX(page)).toBeLessThan(endX);
        await showView(page, "Events");
        expect(await page.locator("#table-wrap tr.evidence").count()).toBeGreaterThan(0);
        await expect(page.locator("#table-wrap tr.selected")).toHaveCount(1);
        await showView(page, "Diagnostics");

        // Clicking another evidence id inspects it.
        if (evidenceCount > 1) {
            const lastEvidence = ((await evidenceButtons.last().textContent()) ?? "").trim();
            await evidenceButtons.last().click();
            await expect(inspectorEventId(page)).toHaveText(lastEvidence);
        }
    });
});
