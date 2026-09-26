import { expect, test } from "@playwright/test";
import { inspectorEventId, openFixture, showView, shot } from "./helpers";

test.describe("event table + inspector", () => {
    test.beforeEach(async ({ page }) => {
        await openFixture(page, "view=events");
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
        await expect(page.locator("#inspector [data-testid=inspector-producer]")).toContainText("sonder-observatory-synthetic-fixture");
        await shot(page, testInfo, "inspector-selected");
        // Selected event gets a wide tick on the timeline (Overview).
        await showView(page, "Overview");
        await expect(page.locator("#timeline rect.tick.selected")).toHaveCount(1);
        await showView(page, "Events");

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

    test("rows carry the producer column and stable hooks", async ({ page }) => {
        const header = page.locator("#table-wrap thead th");
        await expect(header.nth(4)).toHaveText("producer");
        const row = page.locator("#table-wrap [data-testid=event-row]").first();
        await expect(row).toHaveAttribute("data-producer", "sonder-observatory-synthetic-fixture");
        await expect(row).toHaveAttribute("data-event-type", /\w+\.\w+/);
        await expect(row.locator("td").nth(4)).toHaveText("sonder-observatory-synthetic-fixture");
    });

    test("the text filter matches run_id and producer name", async ({ page }) => {
        const count = page.locator("#table-count");
        await page.locator("#filter-text").fill("run_synthetic_0001");
        await expect(count).toContainText(/^\d+ shown/);
        const byRun = Number(/^(\d+)/.exec((await count.textContent()) ?? "")![1]);
        expect(byRun).toBeGreaterThan(0);
        expect(byRun).toBeLessThan(575);
        await page.locator("#filter-text").fill("sonder-observatory-synthetic");
        await expect(count).toContainText("575 shown");
        await page.locator("#filter-text").fill("no-such-producer");
        await expect(count).toContainText("0 shown");
    });

    test("related events are grouped by request and run, with producer labels", async ({ page }) => {
        await page.locator("#filter-text").fill("request.completed");
        await page.locator("#table-wrap [data-testid=event-row]").first().click();
        const related = page.locator("#inspector [data-testid=related-events]");
        await expect(related).toBeVisible();
        await expect(related.locator("[data-group=request]")).toBeVisible();
        await expect(related.locator("[data-group=run]")).toContainText("run_synthetic_0001");
        const item = related.locator("[data-testid=related-event]").first();
        await expect(item).toHaveAttribute("data-producer", "sonder-observatory-synthetic-fixture");
        await expect(item).toContainText("sonder-observatory-synthetic-fixture");
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
