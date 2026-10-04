import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { generateEvents } from "../scripts/gen-large-fixture.mjs";
import { inspectorEventId, openFixture } from "./helpers";

/** Distinct synthetic events exercise real derivation and DOM, not duplicate fixture ids. */
test("diagnostics bounds finding and evidence DOM while retaining the final items", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const base = generateEvents(2, 7).next().value!;
    const findings = Number(process.env.DIAGNOSTICS_STRESS_FINDINGS ?? 5_000);
    const evidence = Number(process.env.DIAGNOSTICS_STRESS_EVIDENCE ?? 3_000);
    if (!Number.isInteger(findings) || findings < 100 || findings > 100_000 || findings % 50 !== 0
        || !Number.isInteger(evidence) || evidence < 50 || evidence > 100_000 || evidence % 50 !== 0) {
        throw new Error("synthetic counts must be multiples of 50 within the documented 100k ceilings");
    }
    const lines: string[] = [];
    for (let index = 0; index < findings + evidence; index += 1) {
        const sample = index >= findings;
        lines.push(JSON.stringify({
            ...base,
            event_id: `evt_diag_bound_${index}`,
            sequence: index,
            mono_ns: base.mono_ns + index * 1_000_000,
            event_type: sample ? "context.appended" : "guard.budget_pressure",
            attributes: sample
                ? { context_id: "ctx_diag_bound", used_tokens: 9_000, limit_tokens: 10_000 }
                : { budget: "synthetic-context", used_fraction: 0.97 },
        }));
    }
    const buffer = Buffer.from(lines.join("\n") + "\n");
    await openFixture(page, "view=diagnostics");
    const start = Date.now();
    await page.locator("#file-input").setInputFiles({ name: "diagnostics-bound.ndjson", mimeType: "application/x-ndjson", buffer });
    await expect(page.locator("#cursor-label")).toContainText(`${findings + evidence}/${findings + evidence} events`, { timeout: 60_000 });
    await expect(page.locator("#synthetic-badge")).toBeVisible();
    const rows = page.locator("#view-diagnostics .diag-finding");
    await expect.poll(() => rows.count()).toBeGreaterThan(0);
    await testInfo.attach("diagnostics-initial-dom", {
        body: JSON.stringify({ synthetic: true, events: findings + evidence, expectedFindings: findings + 1,
            mountedFindings: await rows.count(), nodes: await page.locator("#view-diagnostics *").count(),
            bytes: buffer.length, loadMs: Date.now() - start }),
        contentType: "application/json",
    });
    expect(await rows.count()).toBeLessThanOrEqual(50);
    await expect(page.locator(".diag-findings-page")).toContainText(String(findings + 1));
    await page.getByRole("button", { name: "Last findings page", exact: true }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(`${evidence} evidence events`);
    await rows.first().click();
    const evidenceRows = page.locator("#view-diagnostics ul.diag-evidence > li > button");
    await expect(evidenceRows).toHaveCount(50);
    await expect(inspectorEventId(page)).toHaveText(`evt_diag_bound_${findings}`);
    await page.getByRole("button", { name: "Last evidence page", exact: true }).click();
    await expect(evidenceRows.last()).toHaveText(`evt_diag_bound_${findings + evidence - 1}`);
    await evidenceRows.last().click();
    await expect(inspectorEventId(page)).toHaveText(`evt_diag_bound_${findings + evidence - 1}`);
    expect(await page.locator("#view-diagnostics *").count()).toBeLessThan(1_000);
    const accessibility = await new AxeBuilder({ page }).include("#view-diagnostics")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(accessibility.violations).toEqual([]);
    await page.getByRole("button", { name: "First findings page", exact: true }).click();
    await expect(rows).toHaveCount(50);
    await rows.last().click();
    await rows.last().press("ArrowDown");
    await expect(rows.first()).toHaveClass(/selected/);
    await expect(rows.first()).toBeFocused();
    await expect(inspectorEventId(page)).toHaveText("evt_diag_bound_50");
    expect(errors).toEqual([]);
    await testInfo.attach("diagnostics-pagination-summary", {
        body: JSON.stringify({ synthetic: true, events: findings + evidence, findings: findings + 1,
            evidence, findingRows: await rows.count(), nodes: await page.locator("#view-diagnostics *").count(),
            elapsedMs: Date.now() - start }),
        contentType: "application/json",
    });
    // A replacement source drops stale selection and clamps both page states.
    await page.locator("#file-input").setInputFiles({ name: "diagnostics-small.ndjson", mimeType: "application/x-ndjson",
        buffer: Buffer.from(lines.slice(0, 20).join("\n") + "\n") });
    await expect(page.locator("#cursor-label")).toContainText("20/20 events");
    await expect(rows).toHaveCount(20);
    await expect(page.locator(".diag-pagination")).toHaveCount(0);
    await expect(page.locator("#view-diagnostics .diag-evidence")).toHaveCount(0);
    expect(errors).toEqual([]);
});
