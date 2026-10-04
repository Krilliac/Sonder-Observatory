import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { build } from "vite";
import { generateEvents } from "../scripts/gen-large-fixture.mjs";
import type { ObservatoryEvent } from "../src/protocol/events";
import { inspectorEventId, openFixture, scrubTo } from "./helpers";

test("Agents bounds evidence and diagnostic lists while retaining final events", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const count = Number(process.env.TOPOLOGY_STRESS_EVENTS ?? 5_000);
    if (!Number.isInteger(count) || count < 100 || count > 100_000 || count % 50 !== 0) {
        throw new Error("synthetic event count must be a multiple of 50 from 100 to 100000");
    }
    const base = generateEvents(2, 7).next().value!;
    const lines = Array.from({ length: count }, (_, index) => JSON.stringify({
        ...base, event_id: `evt_topo_page_${index}`, sequence: index,
        mono_ns: base.mono_ns + index * 1_000_000,
        event_type: "guard.budget_pressure", agent_id: "agent_topology_page",
        attributes: { budget: "synthetic-context", used_fraction: 0.97 },
    }));
    const buffer = Buffer.from(lines.join("\n") + "\n");
    await openFixture(page, "view=agents");
    await page.locator("#file-input").setInputFiles({ name: "topology-pages.ndjson", mimeType: "application/x-ndjson", buffer });
    await expect(page.locator("#cursor-label")).toContainText(`${count}/${count} events`, { timeout: 60_000 });
    await expect(page.locator("#synthetic-badge")).toBeVisible();
    const node = page.locator("#view-agents g.topology-node");
    await expect(node).toHaveCount(1);
    await node.click();
    const lists = page.locator("#view-agents .topology-side ul.related");
    await expect(lists).toHaveCount(2);
    const evidence = lists.nth(0).locator("li");
    const diagnostics = lists.nth(1).locator("li");
    await testInfo.attach("topology-side-dom", { contentType: "application/json",
        body: JSON.stringify({ synthetic: true, events: count, graphNodes: await node.count(),
            evidenceRows: await evidence.count(), diagnosticRows: await diagnostics.count(),
            sideNodes: await page.locator("#view-agents .topology-side *").count(), bytes: buffer.length }) });
    expect(await evidence.count()).toBeLessThanOrEqual(50);
    expect(await diagnostics.count()).toBeLessThanOrEqual(50);
    await page.getByRole("button", { name: "Next topology evidence page", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(evidence.first()).toContainText("evt_topo_page_50");
    await expect(page.getByRole("button", { name: "Next topology evidence page", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Previous topology evidence page", exact: true }).click();
    await expect(evidence.first()).toContainText("evt_topo_page_0");
    await page.getByRole("button", { name: "Last topology evidence page", exact: true }).click();
    await expect(evidence.last()).toContainText(`evt_topo_page_${count - 1}`);
    await evidence.last().locator("button").click();
    await expect(inspectorEventId(page)).toHaveText(`evt_topo_page_${count - 1}`);
    expect(await page.locator("#view-agents .topology-side *").count()).toBeLessThan(300);
    const accessibility = await new AxeBuilder({ page }).include("#view-agents")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(accessibility.violations).toEqual([]);
    await page.getByRole("button", { name: "Last topology diagnostics page", exact: true }).click();
    await diagnostics.last().locator("button").click();
    await expect(inspectorEventId(page)).toHaveText(`evt_topo_page_${count - 1}`);
    await scrubTo(page, 1);
    const earlyCount = Math.floor((count - 1) / 1_000) + 1;
    await expect(evidence).toHaveCount(Math.min(50, earlyCount % 50 || 50));
    await expect(diagnostics).toHaveCount(Math.min(50, earlyCount % 50 || 50));
    await expect(page.locator("#view-agents .topology-pagination")).toHaveCount(earlyCount > 50 ? 2 : 0);
    await page.locator("#file-input").setInputFiles({ name: "topology-small.ndjson", mimeType: "application/x-ndjson",
        buffer: Buffer.from(lines.slice(0, 20).join("\n") + "\n") });
    await expect(page.locator("#cursor-label")).toContainText("/20 events");
    await scrubTo(page, 1_000);
    await expect(page.locator("#cursor-label")).toContainText("20/20 events");
    await expect(lists).toHaveCount(2);
    await expect(evidence).toHaveCount(20);
    await expect(diagnostics).toHaveCount(20);
    expect(errors).toEqual([]);
});

test("topology edge evidence pages reset when changing graph selection", async ({ page }) => {
    const base = generateEvents(2, 11).next().value!;
    const events = Array.from({ length: 120 }, (_, index) => ({
        ...base, event_id: `evt_topo_edge_${index}`, sequence: index,
        mono_ns: base.mono_ns + index * 1_000_000,
        event_type: index === 0 ? "agent.spawned" : "agent.message",
        agent_id: index === 0 ? "page_receiver" : "page_sender",
        attributes: index === 0 ? { parent: "page_sender" } : { to_agent_id: "page_receiver" },
    }));
    await openFixture(page, "view=agents");
    await page.locator("#file-input").setInputFiles({ name: "edge-pages.ndjson", mimeType: "application/x-ndjson",
        buffer: Buffer.from(events.map((event) => JSON.stringify(event)).join("\n") + "\n") });
    await expect(page.locator("#cursor-label")).toContainText("120/120 events");
    // Horizontal SVG paths may have a zero-height group bounding box; use the
    // supported keyboard selection rather than inventing a mouse hit area.
    await page.locator("#view-agents g.topology-edge[data-topo-id^='message:']").focus();
    await page.keyboard.press("Enter");
    const rows = page.locator("#view-agents ul[aria-label='Topology evidence'] li");
    await expect(rows).toHaveCount(50);
    await page.getByRole("button", { name: "Last topology evidence page", exact: true }).click();
    await expect(rows).toHaveCount(19);
    await expect(rows.last()).toContainText("evt_topo_edge_119");
    await rows.last().locator("button").click();
    await expect(inspectorEventId(page)).toHaveText("evt_topo_edge_119");
    await page.locator("#view-agents g.topology-node").first().click();
    await expect(rows).toHaveCount(50);
    await expect(rows.first()).toContainText("evt_topo_edge_0");
    await page.locator("#view-agents g.topology-node").first().press("Escape");
    await expect(rows).toHaveCount(0);
});

test("both topology pages survive actual Store live appends and reset on retention or replacement", async ({ page }) => {
    const base = generateEvents(2, 13).next().value!;
    const events = (start: number, count: number) => Array.from({ length: count }, (_, offset) => ({
        ...base, event_id: `evt_topo_live_${start + offset}`, sequence: start + offset,
        mono_ns: base.mono_ns + (start + offset) * 1_000_000,
        event_type: "guard.budget_pressure", agent_id: "page_live", attributes: { used_fraction: 0.97 },
    } as ObservatoryEvent));
    await openFixture(page, "view=agents");
    const bundle = await build({ configFile: false, logLevel: "silent",
        build: { write: false, minify: false, sourcemap: false, emptyOutDir: false,
            lib: { entry: "e2e/topology-pagination-harness.entry.ts", formats: ["iife"], name: "TopologyPaginationHarness" } } });
    const code = (Array.isArray(bundle) ? bundle : [bundle]).flatMap((output) => "output" in output ? output.output : [])
        .filter((item) => item.type === "chunk").map((item) => item.code).join("\n");
    expect(code.length).toBeGreaterThan(0);
    await page.addScriptTag({ content: code });
    await page.evaluate((input) => window.__topologyPagination!.mount(input), events(0, 120));
    const panel = page.locator("#topology-append-harness");
    await panel.locator("g.topology-node").click();
    expect(await page.evaluate(() => window.__topologyPagination!.selectionEvidence().length)).toBe(120);
    for (const kind of ["evidence", "diagnostics"]) {
        await panel.getByRole("button", { name: `Next topology ${kind} page`, exact: true }).click();
        await expect(panel.locator(`.topology-${kind}-page`)).toContainText("51–100 of 120");
    }
    for (let index = 120; index < 123; index += 1) {
        await page.evaluate((input) => window.__topologyPagination!.append(input), events(index, 1));
        for (const kind of ["evidence", "diagnostics"]) {
            await expect(panel.locator(`.topology-${kind}-page`)).toContainText(`51–100 of ${index + 1}`);
            await expect(panel.locator(`ul[aria-label='Topology ${kind}'] li`)).toHaveCount(50);
        }
    }
    // Store retention evicts to 90% of its 200-event ceiling; this is a new
    // history, so both pages reset against the retained 180 events.
    await page.evaluate((input) => window.__topologyPagination!.append(input), events(123, 200));
    for (const kind of ["evidence", "diagnostics"]) {
        await expect(panel.locator(`.topology-${kind}-page`)).toContainText("1–50 of 180");
        await panel.getByRole("button", { name: `Next topology ${kind} page`, exact: true }).click();
    }
    await page.evaluate((input) => window.__topologyPagination!.replace(input), events(0, 120));
    for (const kind of ["evidence", "diagnostics"]) {
        await expect(panel.locator(`.topology-${kind}-page`)).toContainText("1–50 of 120");
    }
});
