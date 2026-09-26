import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";

/** Number of events in fixtures/synthetic-session.ndjson (scripts/generate-fixture.mjs). */
export const FIXTURE_EVENTS = 575;

/** Loads the app with the bundled synthetic fixture and waits until it is rendered. */
export async function openFixture(page: Page, query = ""): Promise<void> {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto(`./${query ? `?${query}` : ""}`);
    await expect(page.locator("#source-badge")).toContainText("fixture");
    await expect(page.locator("#synthetic-badge")).toBeVisible();
    await expect(page.locator("#cursor-label")).toContainText(`${FIXTURE_EVENTS}/${FIXTURE_EVENTS} events`);
    expect(errors, "uncaught page errors during load").toEqual([]);
}

/** Clicks a view tab (Overview, Events, Diagnostics, Agents) and waits for its panel. */
export async function showView(page: Page, name: "Overview" | "Events" | "Diagnostics" | "Agents"): Promise<void> {
    const tab = page.getByRole("tab", { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(`#view-${name.toLowerCase()}`)).toBeVisible();
}

/** "12/575 events" -> 12 */
export async function visibleCount(page: Page): Promise<number> {
    const text = (await page.locator("#cursor-label").textContent()) ?? "";
    const m = /(\d+)\/(\d+) events/.exec(text);
    if (!m) {
        throw new Error(`unexpected cursor label: ${text}`);
    }
    return Number(m[1]);
}

export function cursorLine(page: Page): Locator {
    return page.locator("#timeline svg line.cursor-line");
}

export async function cursorX(page: Page): Promise<number> {
    return Number(await cursorLine(page).getAttribute("x1"));
}

/** Sets the replay scrubber (0..1000) and fires its input event. */
export async function scrubTo(page: Page, value: number): Promise<void> {
    await page.locator("#scrubber").fill(String(value));
}

/** Inspector's event_id row value. */
export function inspectorEventId(page: Page): Locator {
    return page.locator("#inspector dl.kv dt", { hasText: /^event_id$/ }).locator("xpath=following-sibling::dd[1]");
}

/**
 * Full-page screenshot attached to the test report. Also written to
 * $E2E_SHOTS_DIR (default test-results/shots) so CI can upload it as an artifact.
 */
export async function shot(page: Page, testInfo: TestInfo, name: string): Promise<string> {
    const dir = process.env.E2E_SHOTS_DIR ?? path.join(process.cwd(), "test-results", "shots");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
    await testInfo.attach(name, { path: file, contentType: "image/png" });
    return file;
}
