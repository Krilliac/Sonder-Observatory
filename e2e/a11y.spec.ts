import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { openFixture } from "./helpers";

/**
 * axe-core WCAG 2.x A/AA scan. Known violations (documented in
 * docs/integration/e2e.md, "UI bugs found") are allowed so the suite
 * stays green while they are fixed in their owning branches; any NEW rule
 * violation fails the test. Remove entries here as they are fixed.
 */
const KNOWN_VIOLATIONS: Record<string, { targets: RegExp; note: string }> = {
    // src/diagnostics/panel.ts: <ul role="listbox"> > <li> > <button role="option">.
    "aria-required-children": { targets: /\.diag-findings/, note: "listbox contains <li> instead of options" },
    "aria-required-parent": { targets: /diag-finding/, note: "option is not a direct child of the listbox" },
    listitem: { targets: /\.diag-findings > li/, note: "<li> whose parent has role=listbox" },
    // Muted text (#8a9ab3) on the selected-row/finding background (#1a325a) is 4.46:1 (< 4.5:1).
    "color-contrast": { targets: /(\.selected.*> \.muted|\.muted.*\.selected)/, note: "muted text on selected background" },
};

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

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
