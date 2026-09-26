import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { openFixture } from "./helpers";

/**
 * axe-core WCAG 2.0/2.1/2.2 A/AA scan. The allowlist is empty: the
 * findings-list ARIA and selected-row contrast violations found in #12 were
 * fixed in feat/a11y-fixes, and the 2.2 target-size finding on `.link`
 * buttons in the launch/a11y follow-up (docs/integration/e2e.md). If a
 * violation must ever be tolerated temporarily, add it here with a target
 * pattern and a note; it is matched by rule AND by every failing element, so
 * anything new still fails.
 */
const KNOWN_VIOLATIONS: Record<string, { targets: RegExp; note: string }> = {};

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

for (const [name, query] of [
    ["diagnostics view", ""],
    ["agents view", "view=agents"],
] as const) {
    test(`axe: ${name} has no unexpected WCAG A/AA violations`, async ({ page }, testInfo) => {
        await openFixture(page, query);
        if (query === "") {
            // Include the expanded evidence list and a populated inspector in the scan.
            await page.locator("#view-diagnostics .diag-finding").first().click();
        }
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
        expect(unexpected, "new axe violations (see attachment for details)").toEqual([]);
    });
}
