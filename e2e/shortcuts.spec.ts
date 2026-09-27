import { expect, test } from "@playwright/test";
import { FIXTURE_EVENTS, inspectorEventId, openFixture, scrubTo, visibleCount } from "./helpers";

const ERROR_TYPE = /\.failed|\.error|retry\.scheduled|recovery\.action|guard\./;

test.describe("keyboard shortcuts", () => {
    test.beforeEach(async ({ page }) => {
        await openFixture(page);
    });

    test("? opens the dialog, which traps focus and closes with Esc", async ({ page }) => {
        const opener = page.locator("#play-btn");
        await opener.focus();
        await page.keyboard.press("?");
        const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText("Play or pause the replay");
        await expect(page.locator("#shortcuts-dialog")).toHaveAttribute("aria-modal", "true");
        for (let i = 0; i < 5; i += 1) {
            await page.keyboard.press(i % 2 === 0 ? "Tab" : "Shift+Tab");
            expect(await page.evaluate(() => document.getElementById("shortcuts-dialog")!.contains(document.activeElement))).toBe(true);
        }
        // Shortcuts are inert while the dialog is open.
        await page.keyboard.press("t");
        await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(opener).toBeFocused();
        // The header button opens it too.
        await page.locator("#shortcuts-btn").click();
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Close" }).click();
        await expect(dialog).toBeHidden();
    });

    test("Space plays and pauses; F follows the latest event", async ({ page }) => {
        await page.locator("body").click({ position: { x: 5, y: 5 } });
        await page.keyboard.press(" ");
        await expect(page.locator("#play-btn")).toHaveText("Pause");
        await page.keyboard.press(" ");
        await expect(page.locator("#play-btn")).toHaveText("Play");
        await scrubTo(page, 200);
        await expect(page.locator("#follow-check")).not.toBeChecked();
        await page.locator("body").click({ position: { x: 5, y: 5 } });
        await page.keyboard.press("f");
        await expect(page.locator("#follow-check")).toBeChecked();
        expect(await visibleCount(page)).toBe(FIXTURE_EVENTS);
    });

    test("J/K step through events and [/] through errors", async ({ page }) => {
        await page.locator("body").click({ position: { x: 5, y: 5 } });
        await page.keyboard.press("k"); // no selection: the event at the cursor
        const last = (await inspectorEventId(page).textContent())!.trim();
        await page.keyboard.press("k");
        const previous = (await inspectorEventId(page).textContent())!.trim();
        expect(previous).not.toBe(last);
        await page.keyboard.press("j");
        await expect(inspectorEventId(page)).toHaveText(last);

        await page.keyboard.press("[");
        await expect(page.locator("#inspector .big")).toHaveText(ERROR_TYPE);
        const error = (await inspectorEventId(page).textContent())!.trim();
        await page.keyboard.press("[");
        await expect(page.locator("#inspector .big")).toHaveText(ERROR_TYPE);
        await expect(inspectorEventId(page)).not.toHaveText(error);
        await page.keyboard.press("]");
        await expect(inspectorEventId(page)).toHaveText(error);
    });

    test("/ focuses the filter, and shortcuts stay off while typing", async ({ page }) => {
        await page.locator("body").click({ position: { x: 5, y: 5 } });
        await page.keyboard.press("/");
        const filter = page.locator("#filter-text");
        await expect(filter).toBeFocused();
        await expect(page.getByRole("tab", { name: "Events" })).toHaveAttribute("aria-selected", "true");
        await page.keyboard.type("tjk f?");
        await expect(filter).toHaveValue("tjk f?");
        await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
        await expect(page.locator("#shortcuts-dialog")).toBeHidden();
        await expect(page.locator("#inspector")).toContainText("Select an event");
        await page.locator("#ws-url").fill("");
        await page.locator("#ws-url").press("t");
        await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    });

    test("single-key shortcuts can be turned off, and the choice persists (WCAG 2.1.4)", async ({ page }) => {
        const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
        const enabled = page.getByRole("checkbox", { name: "Single-key shortcuts" });
        await page.locator("#shortcuts-btn").click();
        await expect(enabled).toBeChecked();
        await enabled.uncheck();
        await dialog.getByRole("button", { name: "Close" }).click();
        await page.locator("body").click({ position: { x: 5, y: 5 } });
        for (const key of ["t", "?", "j", " "]) {
            await page.keyboard.press(key);
        }
        await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
        await expect(dialog).toBeHidden();
        await expect(page.locator("#inspector")).toContainText("Select an event");
        await expect(page.locator("#play-btn")).toHaveText("Play");

        await page.reload();
        await page.locator("body").click({ position: { x: 5, y: 5 } });
        await page.keyboard.press("t");
        await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
        await page.locator("#shortcuts-btn").click();
        await expect(enabled).not.toBeChecked();
        await enabled.check();
        await page.keyboard.press("Escape");
        await page.locator("body").click({ position: { x: 5, y: 5 } });
        await page.keyboard.press("t");
        await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    });

    test("T toggles the theme", async ({ page }) => {
        await page.locator("body").click({ position: { x: 5, y: 5 } });
        await page.keyboard.press("t");
        await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
        await page.keyboard.press("T");
        await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    });
});
