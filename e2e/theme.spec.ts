import { expect, test } from "@playwright/test";
import { openFixture, showView } from "./helpers";

test.describe("theme", () => {
    test("follows prefers-color-scheme without a saved choice", async ({ page }) => {
        await page.emulateMedia({ colorScheme: "light" });
        await openFixture(page);
        await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
        await page.emulateMedia({ colorScheme: "dark" });
        await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
        const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        expect(bg).toBe("rgb(7, 11, 20)");
    });

    test("the toggle persists; ?theme= overrides for one load", async ({ page }) => {
        await openFixture(page);
        const toggle = page.locator("#theme-toggle");
        await expect(toggle).toHaveText("Light theme");
        await toggle.click();
        await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
        await expect(toggle).toHaveText("Dark theme");
        expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(244, 246, 250)");
        await page.reload();
        await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
        await page.goto("./?theme=dark");
        await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
        await page.goto("./");
        await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    });

    test("reduced motion disables smooth scrolling and transitions", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await openFixture(page);
        const styles = await page.evaluate(() => ({
            scroll: getComputedStyle(document.documentElement).scrollBehavior,
            sidebar: getComputedStyle(document.getElementById("sidebar")!).transitionDuration,
        }));
        expect(styles).toEqual({ scroll: "auto", sidebar: "0s" });
        await page.emulateMedia({ reducedMotion: "no-preference" });
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("smooth");
    });
});

test.describe("layout", () => {
    test("first load: no console errors and no failed requests (favicon included)", async ({ page }) => {
        const problems: string[] = [];
        page.on("console", (m) => {
            if (m.type() === "error") {
                problems.push(m.text());
            }
        });
        page.on("response", (r) => {
            if (r.status() >= 400) {
                problems.push(`${r.status()} ${r.url()}`);
            }
        });
        page.on("requestfailed", (r) => problems.push(`failed ${r.url()}`));
        await openFixture(page);
        await page.waitForLoadState("networkidle");
        expect(problems).toEqual([]);
        await expect(page.locator("link[rel=icon]")).toHaveAttribute("href", /^data:image\/svg\+xml,/);
        await expect(page.locator(".brand-mark svg")).toBeVisible();
    });

    test("1440x900: every view is reachable without page scroll", async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        for (const view of ["overview", "events", "diagnostics", "agents"] as const) {
            await openFixture(page, `view=${view}`);
            const noPageScroll = await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight);
            expect(noPageScroll, `${view} scrolls the page`).toBe(true);
        }
        await openFixture(page, "view=diagnostics");
        const finding = page.locator("#view-diagnostics .diag-finding").first();
        await expect(finding).toBeInViewport();
        await openFixture(page, "view=agents");
        await expect(page.locator("#view-agents g.topology-node").first()).toBeInViewport();
        await openFixture(page, "view=events");
        await expect(page.locator("#table-wrap [data-testid=event-row]").last()).toBeInViewport();
    });

    test("420x900: no horizontal page scroll in any view", async ({ page }) => {
        await page.setViewportSize({ width: 420, height: 900 });
        const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
        await page.goto("./?fixture=0");
        await expect(page.locator("#onboarding")).toBeVisible();
        expect(await fits(), "onboarding").toBe(true);
        await openFixture(page);
        await expect(page.locator("#sidebar")).toBeHidden();
        expect(await fits(), "overview").toBe(true);
        for (const view of ["Events", "Diagnostics", "Agents"] as const) {
            await showView(page, view);
            expect(await fits(), view).toBe(true);
        }
        await page.locator("#sidebar-toggle").click();
        await expect(page.locator("#connection-panel")).toBeVisible();
        await expect(page.locator("#sidebar-toggle")).toHaveAttribute("aria-expanded", "true");
        expect(await fits(), "sources").toBe(true);
    });
});
