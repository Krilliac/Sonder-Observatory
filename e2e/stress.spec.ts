import { statSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { generateNdjson, writeFixture } from "../scripts/gen-large-fixture.mjs";
import { inspectorEventId, openFixture, scrubTo, showView } from "./helpers";

/** End-to-end scale coverage uses generated, distinct events rather than repeated duplicate ids. */
test("100k distinct events stay accessible through virtual scrolling, scrubbing and source replacement", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const count = 100_000;
    const seed = 7;
    const firstId = "evt_lg_s7_0000001";
    const lastId = "evt_lg_s7_0100000";
    const recording = testInfo.outputPath("stress-100k.ndjson");
    await writeFixture(recording, count, seed);
    const bytes = statSync(recording).size;
    await openFixture(page);
    const start = Date.now();
    await page.locator("#file-input").setInputFiles(recording);
    await expect(page.locator("#source-badge")).toContainText("recording · stress-100k.ndjson", { timeout: 60_000 });
    await expect(page.locator("#cursor-label")).toContainText(`${count}/${count} events`);
    await expect(page.locator("#synthetic-badge")).toBeVisible();
    await showView(page, "Events");
    const rows = page.locator("#table-wrap tbody tr.row");
    await expect.poll(() => rows.count()).toBeGreaterThan(0);
    expect(await rows.count()).toBeLessThan(100);
    const table = page.locator("#table-wrap");
    await table.evaluate((element) => { element.scrollTop = 0; });
    await expect(rows.first()).toContainText("session.started");
    await rows.first().click();
    await expect(inspectorEventId(page)).toHaveText(firstId);
    await table.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(rows.last()).toContainText("session.ended");
    await rows.last().click();
    await expect(inspectorEventId(page)).toHaveText(lastId);
    for (const cursor of [250, 750, 500, 1000]) {
        await scrubTo(page, cursor);
        expect(await rows.count()).toBeLessThan(100);
    }
    await expect(page.locator("#cursor-label")).toContainText(`${count}/${count} events`);
    await page.locator("#file-input").setInputFiles({ name: "small.ndjson", mimeType: "application/x-ndjson", buffer: Buffer.from(generateNdjson(100, seed)) });
    await expect(page.locator("#cursor-label")).toContainText("100/100 events");
    expect(await rows.count()).toBeLessThan(100);
    expect(errors).toEqual([]);
    await testInfo.attach("stress-summary", {
        body: JSON.stringify({ synthetic: true, events: count, bytes, elapsedMs: Date.now() - start }),
        contentType: "application/json",
    });
});
