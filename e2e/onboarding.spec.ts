import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { startFakeLiveProducer, type FakeLiveProducer } from "../scripts/fake-live-producer.mjs";
import { FIXTURE_EVENTS } from "./helpers";

/**
 * Empty state (#onboarding): find local producers, open or drop a
 * recording, load the synthetic demo.
 */

const fixtureText = () => readFileSync(fileURLToPath(new URL("../fixtures/synthetic-session.ndjson", import.meta.url)), "utf8");

/** Dispatches a file drop on the window, as a drag from the desktop would. */
async function dropFile(page: Page, name: string, text: string): Promise<void> {
    await page.evaluate(
        ([fileName, body]) => {
            const transfer = new DataTransfer();
            transfer.items.add(new File([body!], fileName!, { type: "application/x-ndjson" }));
            for (const type of ["dragenter", "dragover"]) {
                window.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }));
            }
            window.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
        },
        [name, text],
    );
}

test.describe("onboarding", () => {
    test("shows the empty state without a source", async ({ page }) => {
        await page.goto("./?fixture=0");
        const onboarding = page.locator("#onboarding");
        await expect(onboarding).toBeVisible();
        await expect(page.locator("#analysis")).toBeHidden();
        await expect(onboarding.getByRole("button", { name: "Find local Sonder producers" })).toBeVisible();
        await expect(onboarding.getByRole("button", { name: "Open recording…" })).toBeVisible();
        await expect(onboarding.getByRole("button", { name: "Load synthetic demo" })).toBeVisible();
        await expect(onboarding.locator(".onboarding-card", { hasText: "Synthetic demo" })).toContainText("SYNTHETIC");
    });

    test("the synthetic demo is labelled synthetic", async ({ page }) => {
        await page.goto("./?fixture=0");
        await page.locator("#demo-btn").click();
        await expect(page.locator("#onboarding")).toBeHidden();
        await expect(page.locator("#source-badge")).toContainText("fixture");
        await expect(page.locator("#synthetic-badge")).toBeVisible();
        await expect(page.locator("#synthetic-banner")).toContainText("Synthetic data from sonder-observatory-synthetic-fixture");
        await expect(page.locator("#cursor-label")).toContainText(`${FIXTURE_EVENTS}/${FIXTURE_EVENTS} events`);
    });

    test("dropping a recording on the window opens it; other files are refused", async ({ page }) => {
        await page.goto("./?fixture=0");
        await dropFile(page, "notes.txt", "hello");
        await expect(page.locator("#warnings")).toContainText("notes.txt is not a recording");
        await expect(page.locator("#onboarding")).toBeVisible();
        await dropFile(page, "dropped.ndjson", fixtureText());
        await expect(page.locator("#source-badge")).toContainText("recording · dropped.ndjson");
        await expect(page.locator("#cursor-label")).toContainText(`${FIXTURE_EVENTS}/${FIXTURE_EVENTS} events`);
        await expect(page.locator("#drop-overlay")).toBeHidden();
    });

    test("Open recording loads a .sobs file", async ({ page }, testInfo) => {
        // A .sobs saved from the demo, reopened through the onboarding button.
        await page.goto("./");
        const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#save-btn").click()]);
        const saved = testInfo.outputPath("demo.sobs");
        await download.saveAs(saved);
        await page.goto("./?fixture=0");
        const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator("#onboarding-open-btn").click()]);
        await chooser.setFiles(saved);
        await expect(page.locator("#source-badge")).toContainText("recording · demo.sobs");
        await expect(page.locator("#cursor-label")).toContainText(`${FIXTURE_EVENTS}/${FIXTURE_EVENTS} events`);
    });

    test.describe("local producer discovery", () => {
        // The fake producer preset listens on the fixed port 8766.
        test.describe.configure({ mode: "serial" });
        let producer: FakeLiveProducer | null = null;

        // Playwright hooks take fixtures first; none are needed here.
        // eslint-disable-next-line no-empty-pattern
        test.beforeAll(async ({}, testInfo) => {
            try {
                producer = await startFakeLiveProducer({
                    port: 8766,
                    corsOrigins: [new URL(String(testInfo.project.use.baseURL ?? "http://127.0.0.1:4173")).origin],
                });
            } catch (error) {
                // A busy port fails the run: a silent skip would hide that discovery went untested.
                // Local runs that share the machine with another fake producer may opt out explicitly.
                if (process.env.E2E_ALLOW_BUSY_PRESET_PORT === "1" && !process.env.CI) {
                    producer = null;
                    return;
                }
                throw new Error(
                    `could not start the fake producer on the preset port 8766 (${(error as Error)?.message ?? String(error)}); ` +
                        "free the port, or set E2E_ALLOW_BUSY_PRESET_PORT=1 to skip this test in a local run",
                    { cause: error },
                );
            }
        });

        test.afterAll(async () => {
            await producer?.close();
        });

        test("lists the presets that answered, each with Connect", async ({ page }) => {
            test.skip(producer === null, "port 8766 is busy and E2E_ALLOW_BUSY_PRESET_PORT=1 is set");
            await page.goto("./?fixture=0");
            await page.locator("#discover-btn").click();
            const status = page.locator("#discover-status");
            await expect(status).toContainText("answered", { timeout: 10_000 });
            const found = page.locator('#discover-results li[data-url="http://127.0.0.1:8766/sse"]');
            await expect(found).toBeVisible();
            await expect(found).toContainText("Fake live producer (synthetic)");
            await expect(found).toContainText("SYNTHETIC");
            await found.getByRole("button", { name: "Connect to Fake live producer (synthetic)" }).click();
            await expect(page.locator("#onboarding")).toBeHidden();
            const card = page.locator("[data-testid=producer-card]").first();
            await expect(card.locator("[data-testid=producer-state]")).toHaveText("live");
            await expect(card).toHaveAttribute("data-producer", "sonder-observatory-synthetic-fixture");
        });
    });
});
