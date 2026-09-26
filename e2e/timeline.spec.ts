import { expect, test } from "@playwright/test";
import { FIXTURE_EVENTS, cursorLine, cursorX, inspectorEventId, openFixture, scrubTo, shot, visibleCount } from "./helpers";

test.describe("timeline", () => {
    test.beforeEach(async ({ page }) => {
        await openFixture(page);
    });

    test("renders tracks, ticks and the replay cursor at the end", async ({ page }, testInfo) => {
        const svg = page.locator("#timeline svg");
        await expect(svg).toHaveAttribute("aria-label", "Event timeline by class");
        expect(await svg.locator("text.track-label").count()).toBeGreaterThan(3);
        expect(await svg.locator("rect.tick").count()).toBeGreaterThan(50);
        await expect(cursorLine(page)).toHaveCount(1);
        await expect(page.locator("#scrubber")).toHaveValue("1000");
        await expect(page.locator("#follow-check")).toBeChecked();
        // Metric cards render from the fixture.
        await expect(page.locator("#cards article.card")).toHaveCount(7);
        await expect(page.locator("#cards")).toContainText(`${FIXTURE_EVENTS} events`);
        await shot(page, testInfo, "timeline-default");
    });

    test("scrubbing moves the cursor and limits visible events", async ({ page }) => {
        const endX = await cursorX(page);
        await scrubTo(page, 500);
        await expect(page.locator("#follow-check")).not.toBeChecked();
        const midX = await cursorX(page);
        expect(midX).toBeLessThan(endX);
        const mid = await visibleCount(page);
        expect(mid).toBeGreaterThan(0);
        expect(mid).toBeLessThan(FIXTURE_EVENTS);
        // Future ticks are dimmed.
        expect(await page.locator("#timeline rect.tick.future").count()).toBeGreaterThan(0);

        await scrubTo(page, 100);
        expect(await cursorX(page)).toBeLessThan(midX);
        expect(await visibleCount(page)).toBeLessThan(mid);

        // Back to the end re-enables follow.
        await scrubTo(page, 1000);
        await expect(page.locator("#follow-check")).toBeChecked();
        expect(await visibleCount(page)).toBe(FIXTURE_EVENTS);
        expect(await cursorX(page)).toBeCloseTo(endX, 0);
    });

    test("clicking the timeline plot seeks there", async ({ page }) => {
        const svg = page.locator("#timeline svg");
        const box = (await svg.boundingBox())!;
        const endX = await cursorX(page);
        // A point about a quarter of the way along the plot, on the first track.
        await svg.click({ position: { x: 84 + (box.width - 92) * 0.25, y: 10 } });
        await expect(page.locator("#follow-check")).not.toBeChecked();
        expect(await cursorX(page)).toBeLessThan(endX);
        expect(await visibleCount(page)).toBeLessThan(FIXTURE_EVENTS);
        const scrub = Number(await page.locator("#scrubber").inputValue());
        expect(scrub).toBeGreaterThan(150);
        expect(scrub).toBeLessThan(350);
    });

    test("Next error jumps to an error event and inspects it", async ({ page }) => {
        await scrubTo(page, 0);
        await page.locator("#next-error-btn").click();
        await expect(page.locator("#inspector .big")).toBeVisible();
        const id = (await inspectorEventId(page).textContent())!.trim();
        await expect(page.locator("#table-wrap tr.selected")).toContainText(/\.failed|\.error|retry\.scheduled|recovery\.action|guard\./);
        expect(id.length).toBeGreaterThan(0);
        expect(await visibleCount(page)).toBeLessThan(FIXTURE_EVENTS);
    });
});
