import { expect, test } from "@playwright/test";
import { inspectorEventId, openFixture } from "./helpers";

test.describe("keyboard navigation", () => {
    test("arrow keys in the event table move the selection", async ({ page }) => {
        await openFixture(page, "view=events");
        const wrap = page.locator("#table-wrap");
        await wrap.focus();
        await expect(wrap).toBeFocused();

        await page.keyboard.press("ArrowUp"); // nothing selected -> last row
        const rows = page.locator("#table-wrap tbody tr");
        const n = await rows.count();
        await expect(rows.nth(n - 1)).toHaveAttribute("aria-selected", "true");
        const last = await inspectorEventId(page).textContent();

        await page.keyboard.press("ArrowUp");
        await page.keyboard.press("ArrowUp");
        await expect(rows.nth(n - 3)).toHaveAttribute("aria-selected", "true");
        await expect(inspectorEventId(page)).not.toHaveText(last ?? "");

        await page.keyboard.press("ArrowDown");
        await expect(rows.nth(n - 2)).toHaveAttribute("aria-selected", "true");
        await expect(page.locator("#table-wrap tr.selected")).toHaveCount(1);
    });

    test("scrubber responds to arrow/Home/End keys", async ({ page }) => {
        await openFixture(page);
        const scrubber = page.locator("#scrubber");
        await scrubber.focus();
        await page.keyboard.press("Home");
        await expect(scrubber).toHaveValue("0");
        await expect(page.locator("#follow-check")).not.toBeChecked();
        await page.keyboard.press("ArrowRight");
        await expect(scrubber).toHaveValue("1");
        await page.keyboard.press("End");
        await expect(scrubber).toHaveValue("1000");
        await expect(page.locator("#follow-check")).toBeChecked();
    });

    test("tabs and findings are keyboard operable", async ({ page }) => {
        await openFixture(page);
        const agentsTab = page.getByRole("tab", { name: "Agents" });
        await agentsTab.focus();
        await page.keyboard.press("Enter");
        await expect(agentsTab).toHaveAttribute("aria-selected", "true");
        const diagTab = page.getByRole("tab", { name: "Diagnostics" });
        await diagTab.focus();
        await page.keyboard.press("Space");
        await expect(diagTab).toHaveAttribute("aria-selected", "true");

        const findings = page.locator("#view-diagnostics .diag-finding");
        await findings.first().focus();
        await page.keyboard.press("ArrowDown"); // nothing selected -> first
        await expect(findings.nth(0)).toHaveAttribute("aria-current", "true");
        if ((await findings.count()) > 1) {
            await page.keyboard.press("ArrowDown");
            await expect(findings.nth(1)).toHaveAttribute("aria-current", "true");
            // Focus survives the re-render and stays on the selected finding.
            await expect(findings.nth(1)).toBeFocused();
            await page.keyboard.press("ArrowUp");
            await expect(findings.nth(0)).toHaveAttribute("aria-current", "true");
        }
        await page.keyboard.press("Escape");
        await expect(page.locator("#view-diagnostics .diag-finding.selected")).toHaveCount(0);
        await expect(page.locator("#timeline rect.tick.evidence")).toHaveCount(0);
    });

    test("topology nodes: Enter selects, Escape (from inside the panel) clears", async ({ page }) => {
        await openFixture(page, "view=agents");
        const node = page.locator("#view-agents g.topology-node").first();
        await node.focus();
        await expect(node).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(page.locator("#view-agents g.topology-node").first()).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator("#view-agents .topology-side")).toContainText("Selected node");
        // Focus a control that survives the re-render (an evidence link), then Escape.
        await page.locator("#view-agents .topology-side ul.related button").first().focus();
        await page.keyboard.press("Escape");
        await expect(page.locator("#view-agents .topology-side")).not.toContainText("Selected node");
        await expect(page.locator("#view-agents g.topology-node[aria-pressed=true]")).toHaveCount(0);
    });

    // Regression test for the former "UI bugs" #1 (docs/integration/e2e.md):
    // TopologyPanel re-renders its SVG but restores focus to the same node.
    test("topology keeps focus on the node after Enter so Escape clears", async ({ page }) => {
        await openFixture(page, "view=agents");
        const first = page.locator("#view-agents g.topology-node").first();
        const id = await first.getAttribute("data-topo-id");
        await first.focus();
        await page.keyboard.press("Enter");
        const node = page.locator(`#view-agents g.topology-node[data-topo-id="${id}"]`);
        await expect(node).toHaveAttribute("aria-pressed", "true");
        await expect(node).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(page.locator("#view-agents g.topology-node[aria-pressed=true]")).toHaveCount(0);
        await expect(node).toBeFocused();
        // Focus also survives cursor-driven re-renders (scrub without moving focus).
        const before = await page.locator("#view-agents svg.topology-svg").elementHandle();
        await page.evaluate(() => {
            const scrubber = document.getElementById("scrubber") as HTMLInputElement;
            scrubber.value = "900";
            scrubber.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await expect(page.locator("#follow-check")).not.toBeChecked();
        expect(await before!.evaluate((el) => el.isConnected)).toBe(false); // SVG was replaced
        await expect(node).toBeFocused();
    });

    test("view tabs follow the WAI-ARIA tabs keyboard pattern", async ({ page }) => {
        await openFixture(page);
        const overview = page.getByRole("tab", { name: "Overview" });
        const events = page.getByRole("tab", { name: "Events" });
        const diag = page.getByRole("tab", { name: "Diagnostics" });
        const agents = page.getByRole("tab", { name: "Agents" });
        // Roving tabindex: only the active tab is a Tab stop.
        await expect(overview).toHaveAttribute("tabindex", "0");
        await expect(agents).toHaveAttribute("tabindex", "-1");
        await overview.focus();
        await page.keyboard.press("ArrowRight");
        await expect(events).toBeFocused();
        await expect(events).toHaveAttribute("aria-selected", "true");
        await expect(events).toHaveAttribute("tabindex", "0");
        await expect(overview).toHaveAttribute("tabindex", "-1");
        await expect(page.locator("#view-events")).toBeVisible();
        await page.keyboard.press("End");
        await expect(agents).toBeFocused();
        await expect(page.locator("#view-agents")).toBeVisible();
        await page.keyboard.press("ArrowRight"); // wraps
        await expect(overview).toBeFocused();
        await expect(overview).toHaveAttribute("aria-selected", "true");
        await page.keyboard.press("ArrowLeft"); // wraps back
        await expect(agents).toHaveAttribute("aria-selected", "true");
        await page.keyboard.press("ArrowLeft");
        await expect(diag).toBeFocused();
        await expect(page.locator("#view-diagnostics")).toBeVisible();
        await page.keyboard.press("Home");
        await expect(overview).toBeFocused();
        await expect(page.locator("#view-diagnostics")).toBeHidden();
        await expect(page.locator("#view-overview")).toBeVisible();
    });

    test("the inspector splitter resizes with the keyboard", async ({ page }) => {
        await openFixture(page, "view=events");
        const handle = page.locator("#split-handle");
        await expect(handle).toHaveAttribute("role", "separator");
        const before = Number(await handle.getAttribute("aria-valuenow"));
        const width = async () => (await page.locator("#inspector").boundingBox())!.width;
        const w0 = await width();
        await handle.focus();
        await page.keyboard.press("ArrowRight");
        await expect(handle).toHaveAttribute("aria-valuenow", String(before + 5));
        expect(await width()).toBeLessThan(w0);
        await page.keyboard.press("Home");
        await expect(handle).toHaveAttribute("aria-valuenow", await handle.getAttribute("aria-valuemin") ?? "");
        expect(await width()).toBeGreaterThan(w0);
    });

    test("Tab order reaches the main controls", async ({ page }) => {
        await openFixture(page, "view=events");
        const reached = new Set<string>();
        for (let i = 0; i < 60; i += 1) {
            await page.keyboard.press("Tab");
            const id = await page.evaluate(() => document.activeElement?.id ?? "");
            if (id) {
                reached.add(id);
            }
        }
        for (const id of ["sidebar-toggle", "ws-url", "transport-select", "token-input", "probe-btn", "connect-btn", "fixture-btn", "theme-toggle", "tab-events", "play-btn", "prev-error-btn", "next-error-btn", "scrubber", "filter-text", "table-wrap", "split-handle"]) {
            expect(reached, `Tab should reach #${id}`).toContain(id);
        }
    });
});
