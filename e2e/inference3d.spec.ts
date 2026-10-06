import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { deepSyntheticFixture, ollamaPoolFixture, toNdjson } from "../src/inference3d/fixtures";
import { inspectorEventId, openFixture, scrubTo, shot } from "./helpers";

/**
 * 3D Inference tab (src/inference3d). Two recordings are uploaded as files:
 * - a SYNTHETIC deep producer that emits the reserved backend.layer.* /
 *   backend.operator.* events and token candidates (proposed shapes), so the
 *   full visualization is exercised;
 * - a live-like Ollama pool (Runtime + two Inference nodes, qwen3:14b and
 *   deepseek-r1:14b), marked synthetic here because it is hand-built, where
 *   every model-internal panel must say "not available" with the reason.
 * `window.__observatory3d` (read-only) gives entity ids and their projected
 * screen positions so picking goes through the real raycaster.
 */

interface Hook {
    webgl: boolean;
    animating(): boolean;
    reducedMotion(): boolean;
    entities(): { id: string; kind: string; label: string }[];
    screenPoint(id: string): { x: number; y: number } | null;
    selected(): string | null;
    frameStats(): { calls: number; triangles: number; frames: number } | null;
}

declare global {
    interface Window {
        __observatory3d?: Hook;
    }
}

async function openRecording(page: Page, name: string, text: string, query = ""): Promise<void> {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto(`./?fixture=0&view=3d${query ? `&${query}` : ""}`);
    await page.locator("#file-input").setInputFiles({ name, mimeType: "application/x-ndjson", buffer: Buffer.from(text) });
    await expect(page.locator("#source-badge")).toContainText(name);
    await expect(page.locator("#view-3d .i3d")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__observatory3d?.entities().length ?? 0)).toBeGreaterThan(0);
    expect(errors, "uncaught page errors").toEqual([]);
}

test.describe("3D Inference", () => {
    test("?view=3d opens the tab with a WebGL canvas, a legend and the stage rail", async ({ page }, testInfo) => {
        await openFixture(page, "view=3d");
        const tab = page.getByRole("tab", { name: "3D Inference" });
        await expect(tab).toHaveAttribute("aria-selected", "true");
        const canvas = page.locator("#view-3d canvas.i3d-canvas");
        await expect(canvas).toBeVisible();
        expect(await page.evaluate(() => window.__observatory3d?.webgl)).toBe(true);
        // WebGL really drew the scene: draw calls and triangles of the last frame (three.js renderer.info).
        await expect.poll(() => page.evaluate(() => window.__observatory3d!.frameStats()?.triangles ?? 0)).toBeGreaterThan(100);
        expect((await page.evaluate(() => window.__observatory3d!.frameStats()))!.calls).toBeGreaterThan(5);
        const legend = page.getByRole("list", { name: "3D scene legend" });
        await expect(legend).toBeVisible();
        await expect(legend).toContainText("Depth, left to right: Route → Queue → Prefill → Decode → Output");
        await expect(legend).toContainText("Sphere size: backend-reported tokens");
        const rail = page.getByRole("list", { name: "Pipeline stages" });
        await expect(rail.locator("[data-stage]")).toHaveCount(5);
        await expect(rail).toContainText("Layers: not reported");
        await canvas.scrollIntoViewIfNeeded();
        await shot(page, testInfo, "3d-synthetic-fixture-dark");
    });

    test("deep synthetic producer: layer planes, operators, token probabilities and the synthetic badge", async ({ page }, testInfo) => {
        await openRecording(page, "deep-synthetic.ndjson", toNdjson(deepSyntheticFixture()));
        await expect(page.locator("#synthetic-badge")).toBeVisible();
        const rail = page.getByRole("list", { name: "Pipeline stages" });
        await expect(rail.locator("[data-stage]")).toHaveCount(6);
        await expect(page.getByRole("list", { name: "Layers" }).getByRole("button")).toHaveCount(8);
        await expect(page.locator('[data-notice="layers"]')).toHaveCount(0);
        const caps = page.locator('.i3d-caps-row[data-producer="sonder-observatory-deep-fixture@fixture"]');
        for (const panel of ["layers", "operators", "probabilities", "alternatives", "kv", "output-text"]) {
            await expect(caps.locator(`.i3d-chip[data-panel="${panel}"]`)).toHaveAttribute("data-status", "available");
        }
        await expect(page.getByRole("list", { name: "Top alternatives" }).getByRole("listitem")).toHaveCount(5);
        await expect(page.getByTestId("prob-sampled")).toBeVisible();
        await expect(page.getByRole("list", { name: "3D scene legend" })).toContainText("Thin planes L0…Ln");
        const kinds = await page.evaluate(() => [...new Set(window.__observatory3d!.entities().map((e) => e.kind))].sort());
        expect(kinds).toEqual(expect.arrayContaining(["layer", "operator", "request", "token", "KV pool", "output", "stage"]));
        await page.locator("#view-3d canvas").scrollIntoViewIfNeeded();
        await shot(page, testInfo, "3d-deep-synthetic-dark");
    });

    test("Ollama pool: lanes per model and node; model internals are not available, with the reason", async ({ page }, testInfo) => {
        await openRecording(page, "ollama-pool.ndjson", toNdjson(ollamaPoolFixture({ synthetic: true })));
        await expect(page.locator("#synthetic-badge")).toBeVisible();
        const notice = page.locator('[data-notice="layers"]');
        await expect(notice).toContainText("Layer internals: not available");
        await expect(notice).toContainText("backend ollama does not expose layer telemetry");
        await expect(page.locator('.i3d-probs [data-panel="probabilities"]')).toContainText("backend ollama does not expose token logits");
        const ws = page.locator('.i3d-caps-row[data-producer="sonder-inference@workstation"]');
        await expect(ws.locator('.i3d-chip[data-panel="layers"]')).toHaveAttribute("data-status", "unavailable");
        await expect(ws.locator('.i3d-chip[data-panel="kv"]')).toHaveAttribute("data-status", "available");
        await expect(page.locator('.i3d-caps-row[data-producer="sonder-runtime@workstation"] .i3d-chip[data-panel="layers"]')).toHaveAttribute(
            "data-status",
            "not-applicable",
        );
        const table = page.getByRole("region", { name: "Scene entities (text alternative)" });
        await expect(table).toContainText("qwen3:14b @ node1");
        await expect(table).toContainText("deepseek-r1:14b @ workstation");
        await expect(table).toContainText("463 completion tokens (backend)");
        // Chunks are sizes and timing only: text capture is off.
        await expect(page.locator(".i3d-output")).toContainText("text capture policy does not allow it");
        await page.locator("#view-3d canvas").scrollIntoViewIfNeeded();
        await shot(page, testInfo, "3d-ollama-pool-dark");
    });

    test("clicking an entity in the scene opens its evidence in the Inspector", async ({ page }) => {
        await openRecording(page, "deep-synthetic.ndjson", toNdjson(deepSyntheticFixture()));
        const canvas = page.locator("#view-3d canvas");
        await canvas.scrollIntoViewIfNeeded();
        const target = await page.evaluate(() => {
            const hook = window.__observatory3d!;
            const r = hook.entities().find((e) => e.kind === "request" && e.label === "req-syn-2")!;
            return { id: r.id, point: hook.screenPoint(r.id) };
        });
        expect(target.point).not.toBeNull();
        await page.mouse.click(target.point!.x, target.point!.y);
        await expect.poll(() => page.evaluate(() => window.__observatory3d!.selected())).toBe(target.id);
        const requestRow = page.locator("#inspector dl.kv dt", { hasText: /^request_id$/ }).locator("xpath=following-sibling::dd[1]");
        await expect(requestRow).toHaveText("req-syn-2");
        await expect(page.locator(".i3d-selection")).toContainText("Selected request req-syn-2");
        // Escape clears the selection.
        await page.locator(".i3d-selection button").first().focus();
        await page.keyboard.press("Escape");
        await expect.poll(() => page.evaluate(() => window.__observatory3d!.selected())).toBeNull();
    });

    test("the entity table is a keyboard path to the same evidence", async ({ page }) => {
        await openRecording(page, "ollama-pool.ndjson", toNdjson(ollamaPoolFixture({ synthetic: true })));
        const button = page.locator(".i3d-table tbody tr").filter({ has: page.getByRole("cell", { name: "KV pool", exact: true }) }).first().getByRole("button");
        await button.focus();
        await page.keyboard.press("Enter");
        await expect(button).toHaveAttribute("aria-pressed", "true");
        const id = await inspectorEventId(page).textContent();
        expect(id).toMatch(/^tel-/);
        await expect(page.locator("#inspector")).toContainText("kv.");
        // A stage in the rail selects the stage and opens its newest event.
        await page.locator('.i3d-stage-btn[data-entity="stage:decode"]').click();
        await expect(page.locator('.i3d-stage-btn[data-entity="stage:decode"]')).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator("#inspector")).toContainText("inference.");
    });

    test("the scene follows the replay cursor", async ({ page }) => {
        await openRecording(page, "ollama-pool.ndjson", toNdjson(ollamaPoolFixture({ synthetic: true })));
        const output = page.locator('.i3d-stage-btn[data-entity="stage:output"]');
        await expect(output).toContainText("4 finished");
        await scrubTo(page, 0);
        await expect(output).toContainText("0 finished");
        await expect(page.locator('.i3d-stage-btn[data-entity="stage:decode"]')).toContainText("0 in flight");
        await scrubTo(page, 1000);
        await expect(output).toContainText("4 finished");
    });

    test("reduced motion stops the animation loop", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await openFixture(page, "view=3d");
        await expect(page.locator(".i3d-motion")).toContainText("Motion paused (reduced motion)");
        expect(await page.evaluate(() => [window.__observatory3d!.reducedMotion(), window.__observatory3d!.animating()])).toEqual([true, false]);
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await expect.poll(() => page.evaluate(() => window.__observatory3d!.animating())).toBe(true);
        // Leaving the tab stops rendering.
        await page.getByRole("tab", { name: "Overview", exact: true }).click();
        await expect.poll(() => page.evaluate(() => window.__observatory3d!.animating())).toBe(false);
    });

    test("without WebGL 2 the tab shows a 2D summary and the entity table", async ({ page }) => {
        await page.addInitScript(() => {
            const original = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
                if (type === "webgl2" || type === "webgl") {
                    return null;
                }
                return (original as (...a: unknown[]) => RenderingContext | null).call(this, type, ...args);
            } as typeof HTMLCanvasElement.prototype.getContext;
        });
        await openFixture(page, "view=3d");
        await expect(page.locator('[data-notice="webgl"]')).toContainText("WebGL 2 is unavailable");
        await expect(page.locator("#view-3d canvas")).toBeHidden();
        await expect(page.locator(".i3d-fallback-table")).toContainText("Requests per lane and stage");
        await expect(page.getByRole("region", { name: "Scene entities (text alternative)" }).locator("tbody tr").first()).toBeVisible();
        expect(await page.evaluate(() => window.__observatory3d!.webgl)).toBe(false);
    });

    test("metric strip and header status chips", async ({ page }, testInfo) => {
        await openFixture(page);
        const strip = page.getByRole("region", { name: "Key metrics at the replay cursor" });
        await expect(strip.locator(".strip-card")).toHaveCount(6);
        await expect(strip.locator('[data-metric="tokens"] h3')).toHaveText("Tokens / sec");
        await expect(strip.locator('[data-metric="tokens"] svg.spark')).toHaveCount(1);
        await expect(strip.locator('[data-metric="model"] .strip-value')).toHaveText("synthetic-7b");
        await expect(page.locator("#conn-chip")).toHaveText("Offline · recording");
        await expect(page.locator("#mode-chip")).toHaveText("Replay · at end");
        await scrubTo(page, 300);
        await expect(page.locator("#mode-chip")).toHaveText("Replay · paused at cursor");
        await scrubTo(page, 1000);
        await shot(page, testInfo, "overview-dark");
    });
});

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

for (const theme of ["dark", "light"] as const) {
    test(`axe: 3D Inference tab is clean (${theme} theme)`, async ({ page }, testInfo) => {
        await openRecording(page, "deep-synthetic.ndjson", toNdjson(deepSyntheticFixture()), `theme=${theme}`);
        // Every panel is available for this producer, so there is no reasons list to open.
        await expect(page.locator(".i3d-reasons")).toHaveCount(0);
        const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        expect(results.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target.join(" ")) }))).toEqual([]);
        if (theme === "light") {
            await page.locator("#view-3d canvas").scrollIntoViewIfNeeded();
            await shot(page, testInfo, "3d-deep-synthetic-light");
        }
    });

    test(`axe: Ollama pool 3D tab with reasons open is clean (${theme} theme)`, async ({ page }, testInfo) => {
        await openRecording(page, "ollama-pool.ndjson", toNdjson(ollamaPoolFixture({ synthetic: true })), `theme=${theme}`);
        for (const summary of await page.locator(".i3d-reasons summary").all()) {
            await summary.click();
        }
        const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        expect(results.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target.join(" ")) }))).toEqual([]);
        if (theme === "light") {
            await page.getByRole("tab", { name: "Overview", exact: true }).click();
            await shot(page, testInfo, "overview-light-ollama-pool");
        }
    });
}
