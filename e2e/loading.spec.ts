import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { FIXTURE_EVENTS, openFixture, showView } from "./helpers";

/**
 * Large recordings (at or above CHUNKED_LOAD_THRESHOLD_CHARS, 2 MiB) load in
 * slices with a visible progress bar (#load-progress, role progressbar) and a
 * Cancel button (#load-cancel); cancelling keeps the previous source. Also
 * the inspector splitter's pointer drag.
 */

const LARGE_BYTES = 2 * 1024 * 1024;

/** The synthetic fixture repeated past the chunked-load threshold (duplicate ids are ignored on load). */
function largeRecording(): Buffer {
    const text = readFileSync(fileURLToPath(new URL("../fixtures/synthetic-session.ndjson", import.meta.url)), "utf8").trimEnd();
    const copies = Math.ceil(LARGE_BYTES / text.length) + 1;
    return Buffer.from(Array.from({ length: copies }, () => text).join("\n") + "\n", "utf8");
}

test.describe("large recordings", () => {
    test.beforeEach(async ({ page }) => {
        // File.stream() delivers its first chunk, then waits while window.__holdLoad is true,
        // so the load stays in progress until the test releases it (the parse itself is fast).
        await page.addInitScript(() => {
            const original = Blob.prototype.stream;
            const w = window as unknown as { __holdLoad?: boolean };
            File.prototype.stream = function heldStream(this: File) {
                const reader = original.call(this).getReader();
                let delivered = 0;
                return new ReadableStream<Uint8Array<ArrayBuffer>>({
                    async pull(controller) {
                        while (w.__holdLoad === true && delivered > 0) {
                            await new Promise((resolve) => setTimeout(resolve, 20));
                        }
                        delivered += 1;
                        const { done, value } = await reader.read();
                        if (done) {
                            controller.close();
                        } else {
                            controller.enqueue(value);
                        }
                    },
                    cancel(reason) {
                        return reader.cancel(reason);
                    },
                });
            };
        });
        await openFixture(page);
    });

    test("show progress and can be cancelled, keeping the previous source", async ({ page }) => {
        const file = { name: "big.ndjson", mimeType: "application/x-ndjson", buffer: largeRecording() };
        expect(file.buffer.length).toBeGreaterThanOrEqual(LARGE_BYTES);
        await page.evaluate(() => {
            (window as unknown as { __holdLoad?: boolean }).__holdLoad = true;
        });
        await page.locator("#file-input").setInputFiles(file);

        const status = page.locator("#load-status");
        const bar = page.getByRole("progressbar", { name: "Loading recording" });
        await expect(status).toBeVisible();
        await expect(status).toContainText("Loading big.ndjson");
        // Held after the first chunk: some progress, not finished.
        await expect(bar).toHaveAttribute("aria-valuenow", /^\d{1,2}$/);
        await expect(bar).toHaveAttribute("aria-valuetext", /^\d{1,2}%, \d+ events$/);

        await page.locator("#load-cancel").click();
        await expect(status).toBeHidden();
        await expect(page.locator("#warnings")).toContainText("Loading big.ndjson was cancelled; the previous source is still shown.");
        await expect(page.locator("#source-badge")).toContainText("fixture");
        await expect(page.locator("#cursor-label")).toContainText(`${FIXTURE_EVENTS}/${FIXTURE_EVENTS} events`);
        // The cancelled load never lands later, even once its stream is released.
        await page.evaluate(() => {
            (window as unknown as { __holdLoad?: boolean }).__holdLoad = false;
        });
        await page.waitForTimeout(1000);
        await expect(page.locator("#source-badge")).toContainText("fixture");
        await expect(status).toBeHidden();
    });

    test("finish loading when not cancelled", async ({ page }) => {
        await page.evaluate(() => {
            (window as unknown as { __holdLoad?: boolean }).__holdLoad = true;
        });
        await page.locator("#file-input").setInputFiles({ name: "big.ndjson", mimeType: "application/x-ndjson", buffer: largeRecording() });
        await expect(page.locator("#load-status")).toBeVisible();
        await page.evaluate(() => {
            (window as unknown as { __holdLoad?: boolean }).__holdLoad = false;
        });
        await expect(page.locator("#source-badge")).toContainText("recording · big.ndjson", { timeout: 20_000 });
        await expect(page.locator("#load-status")).toBeHidden();
        await expect(page.locator("#cursor-label")).toContainText(`${FIXTURE_EVENTS}/${FIXTURE_EVENTS} events`);
        await expect(page.locator("#warnings")).toContainText("duplicate event id(s) ignored");
    });
});

test.describe("inspector splitter", () => {
    test("drags with the pointer and remembers the position", async ({ page }) => {
        await openFixture(page);
        await showView(page, "Events");
        const handle = page.getByRole("separator");
        await expect(handle).toHaveAttribute("aria-valuenow", "64");
        const split = (await page.locator("#split").boundingBox())!;
        const box = (await handle.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(split.x + split.width * 0.45, box.y + box.height / 2, { steps: 5 });
        await page.mouse.up();
        await expect(handle).toHaveAttribute("aria-valuenow", "45");
        const main = await page.locator("#split").evaluate((el) => getComputedStyle(el).getPropertyValue("--split").trim());
        expect(main).toBe("45%");
        // Clamped at the limits.
        const moved = (await handle.boundingBox())!;
        await page.mouse.move(moved.x + moved.width / 2, moved.y + moved.height / 2);
        await page.mouse.down();
        await page.mouse.move(split.x + 5, box.y + box.height / 2, { steps: 5 });
        await page.mouse.up();
        await expect(handle).toHaveAttribute("aria-valuenow", "35");
        await page.reload();
        await expect(page.getByRole("separator")).toHaveAttribute("aria-valuenow", "35");
    });
});
