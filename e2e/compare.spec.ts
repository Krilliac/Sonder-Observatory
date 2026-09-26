import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { build } from "vite";
import { regressFixtureText } from "../scripts/generate-fixture-regressed.mjs";
import { openFixture, shot } from "./helpers";

/**
 * Compare flow (src/compare, docs/integration/compare.md).
 *
 * "harness" tests bundle src/compare/panel.ts with Vite's build API, inject it
 * into the built app page and mount it the way ObservatoryApp mounts extra
 * panels, so the flow is covered before the host wires the Compare tab.
 * "app" tests drive the real Compare tab / panel and skip (with a reason)
 * until app.ts / main.ts register it.
 */

const ROOT = process.cwd();
const REGRESSED_NAME = "synthetic-session-regressed.ndjson";

function baseFixtureText(): string {
    let file = path.join(ROOT, "fixtures", "synthetic-session.ndjson");
    if (!existsSync(file)) {
        // E2E_BASE_URL runs skip the prebuild that generates it.
        const dir = path.join(ROOT, "test-results", "compare");
        mkdirSync(dir, { recursive: true });
        file = path.join(dir, "synthetic-session.ndjson");
        execFileSync(process.execPath, [path.join(ROOT, "scripts", "generate-fixture.mjs"), file]);
    }
    return readFileSync(file, "utf8");
}

let harness: { js: string; css: string } | null = null;

async function harnessBundle(): Promise<{ js: string; css: string }> {
    if (harness) {
        return harness;
    }
    const out = await build({
        configFile: false,
        logLevel: "silent",
        root: ROOT,
        build: {
            write: false,
            minify: false,
            sourcemap: false,
            emptyOutDir: false,
            lib: { entry: path.join(ROOT, "e2e", "compare-harness.entry.ts"), formats: ["iife"], name: "CompareHarness", fileName: () => "harness.js" },
        },
    });
    const outputs = (Array.isArray(out) ? out : [out]).flatMap((o) => ("output" in o ? o.output : []));
    let js = "";
    let css = "";
    for (const item of outputs) {
        if (item.type === "chunk") {
            js += item.code;
        } else if (item.fileName.endsWith(".css")) {
            css += typeof item.source === "string" ? item.source : Buffer.from(item.source).toString("utf8");
        }
    }
    expect(js.length, "harness bundle").toBeGreaterThan(0);
    harness = { js, css };
    return harness;
}

/** Built app with no session loaded, plus the Compare panel mounted with the base fixture as the current session. */
async function openHarness(page: Page): Promise<Locator> {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto("./?fixture=0");
    await expect(page.locator("#extra-panels")).toBeAttached();
    const { js, css } = await harnessBundle();
    if (css) {
        await page.addStyleTag({ content: css });
    }
    await page.addScriptTag({ content: js });
    await page.evaluate((text) => window.__compareHarness!.mount(text, "synthetic fixture (current session)"), baseFixtureText());
    const panel = page.locator("section.compare");
    await expect(panel).toBeVisible();
    expect(errors, "uncaught page errors").toEqual([]);
    return panel;
}

async function loadRegressed(panel: Locator, side: "a" | "b"): Promise<void> {
    await panel.locator(`#compare-file-${side}`).setInputFiles({
        name: REGRESSED_NAME,
        mimeType: "application/x-ndjson",
        buffer: Buffer.from(regressFixtureText(baseFixtureText()), "utf8"),
    });
}

function totalsRow(panel: Locator, metric: string): Locator {
    return panel.locator(`#compare-totals tr[data-metric="${metric}"]`);
}

/** Loads the regressed variant as B against the base fixture (current session) as A and checks the result. */
async function expectRegressedComparison(panel: Locator): Promise<void> {
    await expect(panel.locator(".compare-empty")).toBeVisible();
    await loadRegressed(panel, "a");
    await panel.getByRole("button", { name: "Swap A ↔ B" }).click();
    const sideA = panel.locator('.compare-side[data-side="a"]');
    const sideB = panel.locator('.compare-side[data-side="b"]');
    await expect(sideA.locator(".compare-source")).toContainText("Current session");
    await expect(sideB.locator(".compare-source")).toContainText(REGRESSED_NAME);
    await expect(sideB.locator(".badge-synthetic")).toBeVisible();

    // Session totals: latency, decode rate, retries and budget regress; cost and cache only B reports.
    await expect(totalsRow(panel, "ttftMs")).toHaveAttribute("data-verdict", "worse");
    await expect(totalsRow(panel, "decodeTokPerSec")).toHaveAttribute("data-verdict", "worse");
    await expect(totalsRow(panel, "retries").locator("td")).toHaveText(["1", "3", "+2 (+200.0%)", "worse"]);
    await expect(totalsRow(panel, "budgetPeakFraction")).toHaveAttribute("data-verdict", "worse");
    await expect(totalsRow(panel, "promptTokens")).toHaveAttribute("data-verdict", "changed");
    await expect(totalsRow(panel, "completionTokens")).toHaveAttribute("data-verdict", "same");
    await expect(totalsRow(panel, "costUsd").locator(".compare-verdict")).toHaveText("only in B");
    await expect(totalsRow(panel, "cacheHitRate").locator(".compare-verdict")).toHaveText("only in B");

    // Aligned by request (default): the variant keeps request ids.
    await expect(panel.locator("#compare-rows-heading")).toHaveText("Aligned by request");
    await expect(panel.locator(".compare-alignment")).toContainText("Matched by request id: 10 matched, 0 only in A, 0 only in B.");
    await expect(panel.locator('#compare-rows tbody tr[data-status="matched"]')).toHaveCount(10);

    // Findings: the retry storm is new in B; nothing resolved.
    const newFindings = panel.locator('#compare-findings [data-group="new"]');
    await expect(newFindings.locator("h4")).toHaveText(/^New in B \([1-9]\d*\)$/);
    await expect(newFindings).toContainText("retries scheduled");
    await expect(panel.locator('#compare-findings [data-group="resolved"] h4')).toHaveText("Resolved (only in A) (0)");

    // Call graph: search replaced by search_v2, new rerank tool.
    const graph = panel.locator("#compare-graph");
    await expect(graph.locator('[data-group="added-nodes"] li')).toHaveText(["tool synthetic.rerank", "tool synthetic.search_v2"]);
    await expect(graph.locator('[data-group="removed-nodes"] li')).toHaveText(["tool synthetic.search"]);
    await expect(graph.locator('[data-group="added-edges"] li[data-id="tool_call:agent:agt_critic->tool:synthetic.rerank"]')).toHaveCount(1);
    await expect(graph.locator('[data-group="removed-edges"] li[data-id="tool_call:agent:agt_worker_1->tool:synthetic.search"]')).toHaveCount(1);
}

test.describe("Compare panel (harness)", () => {
    test("baseline fixture vs regressed variant: deltas, findings and graph diff", async ({ page }, testInfo) => {
        const panel = await openHarness(page);
        await expectRegressedComparison(panel);
        await panel.scrollIntoViewIfNeeded();
        await shot(page, testInfo, "compare-regressed");
    });

    test("alignment by run and turn", async ({ page }) => {
        const panel = await openHarness(page);
        await loadRegressed(panel, "b");
        await panel.locator('.compare-side[data-side="a"]').getByRole("button", { name: "Use current session" }).click();
        await panel.getByRole("radio", { name: "Run" }).check();
        await expect(panel.locator("#compare-rows-heading")).toHaveText("Aligned by run");
        // Run ids differ between the recordings, so runs pair by position.
        await expect(panel.locator(".compare-alignment")).toContainText("Matched by position (no shared run ids): 1 matched");
        await expect(panel.locator("#compare-rows tbody tr")).toHaveCount(1);
        await expect(panel.locator("#compare-rows tbody th")).toHaveText("run_synthetic_0001 ↔ run_synthetic_0002");

        await panel.getByRole("radio", { name: "Turn" }).check();
        await expect(panel.locator("#compare-rows-heading")).toHaveText("Aligned by turn");
        await expect(panel.locator(".compare-alignment")).toContainText("turns inferred from request start order");
        await expect(panel.locator("#compare-rows tbody tr")).toHaveCount(10);

        await panel.getByRole("radio", { name: "Request" }).check();
        await expect(panel.locator("#compare-rows tbody tr")).toHaveCount(10);
    });

    test("recording vs a growing live session updates B", async ({ page }) => {
        const panel = await openHarness(page);
        const base = baseFixtureText().split("\n").filter(Boolean);
        // Restart the current session with the first 100 events, then stream the rest in.
        await page.evaluate((text) => window.__compareHarness!.mount(text, "live: ws://127.0.0.1:7878"), base.slice(0, 100).join("\n"));
        const live = page.locator("section.compare").last();
        await loadRegressed(live, "a");
        const sideB = live.locator('.compare-side[data-side="b"] .compare-source');
        await expect(sideB).toContainText("live: ws://127.0.0.1:7878");
        await expect(sideB).toContainText("100 events");
        await page.evaluate((text) => window.__compareHarness!.append(text), base.slice(100).join("\n"));
        await expect(sideB).toContainText(`${base.length} events`);
        await expect(live.locator('#compare-rows tbody tr[data-status="matched"]')).toHaveCount(10);
        void panel;
    });

    test("an unreadable recording shows an error and keeps the side empty", async ({ page }) => {
        const panel = await openHarness(page);
        await panel.locator("#compare-file-a").setInputFiles({ name: "broken.ndjson", mimeType: "text/plain", buffer: Buffer.from("not json\n") });
        const error = panel.locator('.compare-side[data-side="a"] .compare-error');
        await expect(error).toBeVisible();
        await expect(error).toContainText("No events could be read from broken.ndjson");
        await expect(panel.locator(".compare-empty")).toBeVisible();
    });

    test("axe: compare panel has no WCAG A/AA violations", async ({ page }) => {
        const panel = await openHarness(page);
        await loadRegressed(panel, "b");
        await panel.locator('.compare-side[data-side="a"]').getByRole("button", { name: "Use current session" }).click();
        await expect(panel.locator("#compare-totals")).toBeVisible();
        const results = await new AxeBuilder({ page })
            .include("section.compare")
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
            .analyze();
        const summary = results.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target.join(" ")) }));
        expect(summary).toEqual([]);
    });
});

test.describe("Compare tab (app)", () => {
    test("compares the fixture with the regressed variant", async ({ page }, testInfo) => {
        await openFixture(page);
        const tab = page.getByRole("tab", { name: "Compare" });
        const wired = (await tab.count()) > 0 || (await page.locator("#panel-compare").count()) > 0;
        test.skip(!wired, "Compare is not registered in app.ts / main.ts yet (docs/integration/compare.md)");
        if ((await tab.count()) > 0) {
            await tab.click();
            await expect(tab).toHaveAttribute("aria-selected", "true");
        }
        const panel = page.locator("section.compare");
        await expect(panel).toBeVisible();
        await expectRegressedComparison(panel);
        await shot(page, testInfo, "tab-compare");
    });
});
