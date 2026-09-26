import { expect, test } from "@playwright/test";
import { inspectorEventId, openFixture, shot } from "./helpers";

test.describe("event table + inspector", () => {
    test.beforeEach(async ({ page }) => {
        await openFixture(page);
    });

    test("inspector starts empty", async ({ page }) => {
        await expect(page.locator("#inspector")).toContainText("Select an event in the table or timeline");
    });

    test("selecting a row opens the inspector for that event", async ({ page }, testInfo) => {
        const rows = page.locator("#table-wrap tbody tr");
        expect(await rows.count()).toBeGreaterThan(10);
        const row = rows.nth(5);
        const eventType = ((await row.locator("td").nth(2).textContent()) ?? "").trim();
        const seq = ((await row.locator("td").nth(0).textContent()) ?? "").trim();
        await row.click();

        await expect(row).toHaveAttribute("aria-selected", "true");
        await expect(row).toHaveClass(/selected/);
        await expect(page.locator("#inspector .big")).toHaveText(eventType);
        await expect(page.locator("#inspector dl.kv dt", { hasText: /^sequence$/ }).locator("xpath=following-sibling::dd[1]")).toHaveText(seq);
        await expect(page.locator("#inspector .provenance")).toContainText("Synthetic event");
        await expect(page.locator("#inspector pre.json")).toBeVisible();
        // Selected event gets a wide tick on the timeline.
        await expect(page.locator("#timeline rect.tick.selected")).toHaveCount(1);
        await shot(page, testInfo, "inspector-selected");

        // Related-event links select another event.
        const related = page.locator("#inspector ul.related button");
        if ((await related.count()) > 1) {
            const before = await inspectorEventId(page).textContent();
            await related.last().click();
            await expect(inspectorEventId(page)).not.toHaveText(before ?? "");
        }

        await page.getByRole("button", { name: "Close inspector" }).click();
        await expect(page.locator("#inspector")).toContainText("Select an event in the table or timeline");
    });

    test("table filter narrows rows", async ({ page }) => {
        await page.locator("#filter-class").selectOption("error");
        const rows = page.locator("#table-wrap tbody tr");
        const n = await rows.count();
        expect(n).toBeGreaterThan(0);
        for (let i = 0; i < n; i += 1) {
            await expect(rows.nth(i).locator("td").nth(3)).toHaveText("error");
        }
    });
});
