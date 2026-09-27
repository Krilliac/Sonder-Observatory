import { expect, test, type Page } from "@playwright/test";
import { openFixture, scrubTo, showView, shot } from "./helpers";

async function graphCounts(page: Page): Promise<{ nodes: number; edges: number }> {
    const svg = page.locator("#view-agents svg.topology-svg");
    if ((await svg.count()) === 0) {
        return { nodes: 0, edges: 0 };
    }
    const label = (await svg.getAttribute("aria-label")) ?? "";
    const m = /(\d+) nodes, (\d+) edges/.exec(label);
    expect(m, `topology aria-label: ${label}`).not.toBeNull();
    return { nodes: Number(m![1]), edges: Number(m![2]) };
}

test.describe("Agents (topology) tab", () => {
    test("?view=agents renders nodes and edges", async ({ page }, testInfo) => {
        await openFixture(page, "view=agents");
        await expect(page.getByRole("tab", { name: "Agents" })).toHaveAttribute("aria-selected", "true");
        await expect(page.locator("#view-agents")).toBeVisible();
        await expect(page.locator("#view-diagnostics")).toBeHidden();
        const nodes = page.locator("#view-agents g.topology-node");
        const edges = page.locator("#view-agents g.topology-edge");
        expect(await nodes.count()).toBeGreaterThan(1);
        expect(await edges.count()).toBeGreaterThan(0);
        const counts = await graphCounts(page);
        expect(counts.nodes).toBe(await nodes.count());
        expect(counts.edges).toBe(await edges.count());
        expect(await page.locator("#view-agents .topology-legend-item").count()).toBeGreaterThan(0);
        await page.locator("#view-agents").scrollIntoViewIfNeeded();
        await shot(page, testInfo, "tab-agents");
    });

    test("tab switch from Diagnostics shows the graph", async ({ page }) => {
        await openFixture(page);
        await page.getByRole("tab", { name: "Agents" }).click();
        await expect(page.locator("#view-agents g.topology-node").first()).toBeVisible();
        await page.getByRole("tab", { name: "Diagnostics" }).click();
        await expect(page.locator("#view-diagnostics .diag-finding").first()).toBeVisible();
        await expect(page.locator("#view-agents")).toBeHidden();
    });

    test("graph follows the replay cursor", async ({ page }) => {
        await openFixture(page, "view=agents");
        const full = await graphCounts(page);
        await scrubTo(page, 30);
        const early = await graphCounts(page);
        expect(early.nodes + early.edges).toBeLessThan(full.nodes + full.edges);
        await scrubTo(page, 500);
        const mid = await graphCounts(page);
        expect(mid.nodes + mid.edges).toBeGreaterThanOrEqual(early.nodes + early.edges);
        expect(mid.nodes + mid.edges).toBeLessThanOrEqual(full.nodes + full.edges);
        await scrubTo(page, 1000);
        expect(await graphCounts(page)).toEqual(full);
    });

    test("selecting a node lists evidence and highlights it", async ({ page }) => {
        await openFixture(page, "view=agents");
        const node = page.locator("#view-agents g.topology-node").first();
        await node.click();
        await expect(node).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator("#view-agents .topology-side h3").first()).toContainText("Selected node");
        // Evidence link inspects the event and moves the cursor.
        const evidence = page.locator("#view-agents .topology-side ul.related").first().locator("button").first();
        const label = ((await evidence.textContent()) ?? "").trim();
        const eventId = label.split(/\s+/).pop()!;
        await evidence.click();
        await expect(page.locator("#inspector dl.kv dd").first()).toHaveText(eventId);
        await expect(page.locator("#follow-check")).not.toBeChecked();
        // The node's evidence stays highlighted on the Overview timeline.
        await showView(page, "Overview");
        expect(await page.locator("#timeline rect.tick.evidence").count()).toBeGreaterThan(0);
    });
});
