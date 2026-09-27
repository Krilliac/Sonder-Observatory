import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { startFakeLiveProducer, type FakeLiveProducer } from "../scripts/fake-live-producer.mjs";
import { openFixture } from "./helpers";

/**
 * axe-core WCAG 2.0/2.1/2.2 A/AA scan (including color-contrast and 2.2
 * target-size) of every view, the Sources panel with producer cards, the
 * onboarding empty state, the shortcuts dialog, the Compare tab, the export
 * dialog and the sensitive-export warning, in both themes. The
 * allowlist is empty; if a violation
 * must ever be tolerated temporarily, add it here with a target pattern and a
 * note: it is matched by rule AND by every failing element, so anything new
 * still fails.
 */
const KNOWN_VIOLATIONS: Record<string, { targets: RegExp; note: string }> = {};

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function scan(page: Page, testInfo: TestInfo, name: string): Promise<void> {
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    const summary = results.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.length,
        targets: v.nodes.map((n) => n.target.join(" ")),
    }));
    await testInfo.attach(`axe-${name.replace(/\s+/g, "-")}.json`, {
        body: JSON.stringify(summary, null, 2),
        contentType: "application/json",
    });
    // A violation is "known" only if its rule is listed AND every failing node matches the documented targets.
    const unexpected = summary.filter((v) => {
        const known = KNOWN_VIOLATIONS[v.id];
        return !known || !v.targets.every((t) => known.targets.test(t));
    });
    const known = summary.filter((v) => !unexpected.includes(v));
    if (known.length > 0) {
        testInfo.annotations.push({ type: "known-a11y", description: known.map((v) => `${v.id} (${v.nodes})`).join(", ") });
    }
    expect(unexpected, `new axe violations in ${name} (see attachment for details)`).toEqual([]);
}

for (const theme of ["dark", "light"] as const) {
    test.describe(`axe (${theme} theme)`, () => {
        test("overview with a selected event", async ({ page }, testInfo) => {
            await openFixture(page, `theme=${theme}`);
            await page.locator("#timeline").focus();
            await page.keyboard.press("End");
            await scan(page, testInfo, `overview-${theme}`);
        });

        test("events with the inspector and related groups", async ({ page }, testInfo) => {
            await openFixture(page, `theme=${theme}&view=events`);
            await page.locator("#filter-text").fill("request.completed");
            await page.locator("#table-wrap [data-testid=event-row]").first().click();
            await expect(page.locator("#inspector [data-testid=related-events]")).toBeVisible();
            await scan(page, testInfo, `events-${theme}`);
        });

        test("diagnostics with a finding selected", async ({ page }, testInfo) => {
            await openFixture(page, `theme=${theme}&view=diagnostics`);
            await page.locator("#view-diagnostics .diag-finding").first().click();
            await scan(page, testInfo, `diagnostics-${theme}`);
        });

        test("agents", async ({ page }, testInfo) => {
            await openFixture(page, `theme=${theme}&view=agents`);
            await page.locator("#view-agents g.topology-node").first().click();
            await scan(page, testInfo, `agents-${theme}`);
        });

        test("shortcuts dialog", async ({ page }, testInfo) => {
            await openFixture(page, `theme=${theme}`);
            await page.locator("#shortcuts-btn").click();
            await expect(page.locator("#shortcuts-dialog")).toBeVisible();
            await scan(page, testInfo, `dialog-${theme}`);
        });

        test("compare with both sides loaded", async ({ page }, testInfo) => {
            await openFixture(page, `theme=${theme}&view=compare`);
            const panel = page.locator("#view-compare section.compare");
            await expect(panel).toBeVisible();
            // B starts as the current session; use it for A too so the full result renders.
            await panel.locator('.compare-side[data-side="a"]').getByRole("button", { name: "Use current session" }).click();
            await expect(panel.locator("#compare-totals")).toBeVisible();
            await scan(page, testInfo, `compare-${theme}`);
        });

        test("export dialog", async ({ page }, testInfo) => {
            await openFixture(page, `theme=${theme}`);
            await page.locator("#export-btn").click();
            await expect(page.locator("#export-dialog")).toBeVisible();
            await scan(page, testInfo, `export-${theme}`);
        });

        test("sensitive export warning", async ({ page }, testInfo) => {
            const text = readFileSync(fileURLToPath(new URL("../fixtures/synthetic-session.ndjson", import.meta.url)), "utf8").replace(
                '"text_capture":"none"',
                '"text_capture":"full"',
            );
            await page.goto(`./?fixture=0&theme=${theme}`);
            await page.locator("#file-input").setInputFiles({ name: "full-capture.ndjson", mimeType: "application/x-ndjson", buffer: Buffer.from(text) });
            await expect(page.locator("#source-badge")).toContainText("full-capture.ndjson");
            await page.locator("#export-btn").click();
            await page.getByRole("button", { name: "Export", exact: true }).click();
            await expect(page.getByRole("dialog", { name: "This export may contain sensitive data" })).toBeVisible();
            await scan(page, testInfo, `export-warning-${theme}`);
        });

        test("onboarding empty state", async ({ page }, testInfo) => {
            await page.goto(`./?fixture=0&theme=${theme}`);
            await expect(page.locator("#onboarding")).toBeVisible();
            await scan(page, testInfo, `onboarding-${theme}`);
        });

        test.describe("sources with producers", () => {
            let live: FakeLiveProducer;
            let failing: FakeLiveProducer;
            // Playwright hooks take fixtures first; none are needed here.
            // eslint-disable-next-line no-empty-pattern
            test.beforeAll(async ({}, testInfo) => {
                const corsOrigins = [new URL(String(testInfo.project.use.baseURL ?? "http://127.0.0.1:4173")).origin];
                live = await startFakeLiveProducer({ role: "inference", corsOrigins });
                failing = await startFakeLiveProducer({ role: "runtime", corsOrigins, token: "a11y-token" });
            });
            test.afterAll(async () => {
                await Promise.all([live?.close(), failing?.close()]);
            });

            test("live, failed and disconnected cards and a probe result", async ({ page }, testInfo) => {
                await page.goto(`./?fixture=0&theme=${theme}&connect=${encodeURIComponent(live.urls.base)}&connect=${encodeURIComponent(failing.urls.base)}`);
                const cards = page.locator("[data-testid=producer-card]");
                await expect(cards.locator("[data-testid=producer-state]", { hasText: "live" })).toHaveCount(1);
                await expect(cards.locator("[data-testid=producer-state]", { hasText: "failed" })).toHaveCount(1);
                await page.locator("#ws-url").fill(failing.urls.base);
                await page.locator("#probe-btn").click();
                await expect(page.locator("#probe-result")).toHaveAttribute("data-tone", "error");
                await scan(page, testInfo, `sources-${theme}`);
                await page.getByRole("button", { name: "Disconnect sonder-inference" }).click();
                await expect(cards.locator("[data-testid=producer-state]", { hasText: "disconnected" })).toHaveCount(1);
                await scan(page, testInfo, `sources-disconnected-${theme}`);
            });
        });
    });
}
