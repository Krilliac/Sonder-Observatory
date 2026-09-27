import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { loadEvents, startFakeLiveProducer, type FakeLiveProducer } from "../scripts/fake-live-producer.mjs";
import { FIXTURE_EVENTS, showView, shot } from "./helpers";

/**
 * Multi-producer connection flow against two fake live producers started
 * from the spec (scripts/fake-live-producer.mjs, synthetic data): one in the
 * runtime role and one in the inference role. Contract sections 8.2 and 8.6.
 */

const TOKEN = "e2e-secret-token-Zq81";

/**
 * The fixture as an Inference stream linked to the Runtime stream the way
 * contract 8.4 describes: its own request ids (inf_<id>), each naming the
 * Runtime request in attributes.parent_request_id, and the same run_id. Equal
 * request ids across producers are unrelated, so the inspector's
 * cross-producer groups must come from these links.
 */
function linkedInferenceEvents(): Record<string, unknown>[] {
    return loadEvents().map((e) => {
        const requestId = e.request_id;
        if (typeof requestId !== "string" || requestId === "") {
            return e;
        }
        return { ...e, request_id: `inf_${requestId}`, attributes: { ...(e.attributes as object), parent_request_id: requestId } };
    });
}

/** A human-speed click: press, hold, release (Playwright's own click takes a few ms). */
async function slowClick(page: Page, x: number, y: number, holdMs = 150): Promise<void> {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(holdMs);
    await page.mouse.up();
}

function pageOrigin(testInfo: TestInfo): string {
    return new URL(String(testInfo.project.use.baseURL ?? "http://127.0.0.1:4173")).origin;
}

function card(page: Page, producer: string) {
    return page.locator(`[data-testid=producer-card][data-producer="${producer}"]`);
}

async function counter(page: Page, producer: string, name: string): Promise<number> {
    return Number(await card(page, producer).locator(`[data-testid=producer-counters] [data-counter="${name}"]`).textContent());
}

test.describe("live producers", () => {
    let runtime: FakeLiveProducer;
    let inference: FakeLiveProducer;
    let guarded: FakeLiveProducer;
    let foreign: FakeLiveProducer;
    let streaming: FakeLiveProducer;

    // Playwright hooks take fixtures first; none are needed here.
    // eslint-disable-next-line no-empty-pattern
    test.beforeAll(async ({}, testInfo) => {
        const corsOrigins = [pageOrigin(testInfo)];
        runtime = await startFakeLiveProducer({ role: "runtime", corsOrigins });
        inference = await startFakeLiveProducer({ role: "inference", corsOrigins, events: linkedInferenceEvents() });
        guarded = await startFakeLiveProducer({ role: "runtime", corsOrigins, token: TOKEN });
        // Allows some other origin only: the viewer's requests are refused (CORS).
        foreign = await startFakeLiveProducer({ role: "inference", corsOrigins: ["http://example.invalid:1"] });
        // Keeps streaming for the whole run: the panels re-render many times per second.
        streaming = await startFakeLiveProducer({ role: "inference", corsOrigins, pace: "timeline", loop: true });
    });

    test.afterAll(async () => {
        await Promise.all([runtime, inference, guarded, foreign, streaming].map((p) => p?.close()));
    });

    test("?connect= twice merges two producers into one session", async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (err) => errors.push(err.message));
        await page.goto(`./?fixture=0&connect=${encodeURIComponent(inference.urls.base)}&connect=${encodeURIComponent(runtime.urls.base)}`);

        for (const name of ["sonder-inference", "sonder-runtime"]) {
            await expect(card(page, name)).toBeVisible();
            await expect(card(page, name).locator("[data-testid=producer-state]")).toHaveText("live");
            await expect(card(page, name).locator("[data-testid=producer-counters]")).toContainText("received");
            await expect(card(page, name)).toContainText("SYNTHETIC");
            await expect(card(page, name)).toContainText("sse");
        }
        await expect(card(page, "sonder-runtime")).toContainText("runtime");
        await expect(card(page, "sonder-inference")).toContainText("inference");
        await expect(page.locator("#cursor-label")).toContainText(`${2 * FIXTURE_EVENTS}/${2 * FIXTURE_EVENTS} events`);
        expect(await counter(page, "sonder-runtime", "received")).toBe(FIXTURE_EVENTS);
        expect(await counter(page, "sonder-inference", "rejected")).toBe(0);

        // One header status and a synthetic banner naming both producers.
        await expect(page.locator("#live-status")).toHaveText("live: 2 live");
        await expect(page.locator("#synthetic-banner")).toContainText("sonder-inference and sonder-runtime");
        await expect(page.locator("#cards .per-producer li")).toHaveCount(2);

        // One table, both streams merged in replay order (same timeline, so they interleave).
        await showView(page, "Events");
        await page.locator("#filter-text").fill("request.started");
        const producers = await page.locator("#table-wrap [data-testid=event-row]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-producer")));
        expect(new Set(producers)).toEqual(new Set(["sonder-inference", "sonder-runtime"]));
        await page.locator("#filter-text").fill("sonder-runtime");
        await expect(page.locator("#table-count")).toContainText(`${FIXTURE_EVENTS} shown`);

        // Related events cross producers through parent_request_id and run_id (contract 8.4),
        // never through equal request ids alone.
        await page.locator("#filter-text").fill("request.completed");
        await page.locator("#table-wrap [data-testid=event-row][data-producer=sonder-runtime]").first().click();
        const related = page.locator("#inspector [data-testid=related-events]");
        await expect(related.locator("[data-group=children] [data-testid=related-event][data-producer=sonder-inference]").first()).toBeVisible();
        await expect(related.locator("[data-group=run] [data-testid=related-event][data-producer=sonder-inference]").first()).toBeVisible();
        await expect(related.locator("[data-group=request] [data-testid=related-event]").first()).toBeVisible();
        await expect(related.locator("[data-group=request] [data-testid=related-event][data-producer=sonder-inference]")).toHaveCount(0);
        await page.locator("#table-wrap [data-testid=event-row][data-producer=sonder-inference]").first().click();
        await expect(related.locator("[data-group=parent]")).toContainText(/Parent request req_\d+/);
        await expect(related.locator("[data-group=parent] [data-testid=related-event][data-producer=sonder-runtime]").first()).toBeVisible();
        await expect(related.locator("[data-group=request] [data-testid=related-event][data-producer=sonder-runtime]")).toHaveCount(0);

        // Disconnecting one card keeps its events and the other producer.
        await card(page, "sonder-runtime").getByRole("button", { name: "Disconnect sonder-runtime" }).click();
        await expect(card(page, "sonder-runtime").locator("[data-testid=producer-state]")).toHaveText("disconnected");
        await expect(card(page, "sonder-inference").locator("[data-testid=producer-state]")).toHaveText("live");
        await expect(page.locator("#cursor-label")).toContainText(`${2 * FIXTURE_EVENTS} events`);
        await card(page, "sonder-runtime").getByRole("button", { name: "Remove sonder-runtime" }).click();
        await expect(card(page, "sonder-runtime")).toHaveCount(0);
        expect(errors).toEqual([]);
    });

    test("a token-protected producer asks for a token, which never leaves memory", async ({ page }) => {
        const logs: string[] = [];
        page.on("console", (m) => logs.push(m.text()));
        await page.goto("./?fixture=0");
        const url = page.locator("#ws-url");
        await url.fill(guarded.urls.base);
        await page.locator("#connect-btn").click();

        const failed = page.locator("[data-testid=producer-card]").first();
        await expect(failed.locator("[data-testid=producer-state]")).toHaveText("failed");
        await expect(failed).toContainText("requires a bearer token");
        await expect(failed).toContainText("paste it into Sources > Bearer token");

        await failed.getByRole("button", { name: /^Edit in Sources/ }).click();
        await expect(page.locator("#token-input")).toBeFocused();
        await expect(url).toHaveValue(guarded.urls.base);
        await page.locator("#token-input").fill(TOKEN);
        await page.locator("#connect-btn").click();
        await expect(card(page, "sonder-runtime").locator("[data-testid=producer-state]")).toHaveText("live");
        await expect(page.locator("#token-input")).toHaveValue("");
        expect(guarded.stats.unauthorized).toBeGreaterThan(0);

        const leaks = await page.evaluate((token) => {
            const inputs = [...document.querySelectorAll("input")].map((i) => i.value).join("\n");
            let stored = "";
            for (let i = 0; i < localStorage.length; i += 1) {
                const key = localStorage.key(i)!;
                stored += `${key}=${localStorage.getItem(key)}\n`;
            }
            return {
                dom: document.documentElement.outerHTML.includes(token),
                inputs: inputs.includes(token),
                storage: stored.includes(token),
                session: JSON.stringify(sessionStorage).includes(token),
                url: location.href.includes(token),
                recentHasUrl: stored.includes("recent-endpoints"),
            };
        }, TOKEN);
        expect(leaks).toEqual({ dom: false, inputs: false, storage: false, session: false, url: false, recentHasUrl: true });
        expect(logs.some((l) => l.includes(TOKEN))).toBe(false);
    });

    test("token URL parameters are ignored with a visible warning", async ({ page }) => {
        await page.goto(`./?fixture=0&token=${TOKEN}`);
        await expect(page.locator("#warnings")).toContainText('Ignored the "token" URL parameter');
        expect(page.url()).not.toContain(TOKEN);
    });

    test("the token warning stays visible when ?connect= adds producers", async ({ page }) => {
        await page.goto(`./?fixture=0&connect=${encodeURIComponent(runtime.urls.base)}&token=${TOKEN}`);
        await expect(card(page, "sonder-runtime").locator("[data-testid=producer-state]")).toHaveText("live");
        await expect(page.locator("#warnings")).toContainText('Ignored the "token" URL parameter');
        expect(page.url()).not.toContain(TOKEN);
        expect(await page.evaluate((t) => document.documentElement.outerHTML.includes(t), TOKEN)).toBe(false);
    });

    test("credentials and token parameters inside connect URLs are removed, never shown", async ({ page }) => {
        const withToken = new URL(runtime.urls.base);
        withToken.searchParams.set("access_token", "SECRETX");
        const withUser = new URL(inference.urls.base);
        withUser.username = "u";
        withUser.password = "SECRETY";
        await page.goto(`./?fixture=0&connect=${encodeURIComponent(withToken.toString())}&connect=${encodeURIComponent(withUser.toString())}`);
        // Connected without the secrets (they are ignored, like ?token=).
        await expect(card(page, "sonder-runtime").locator("[data-testid=producer-state]")).toHaveText("live");
        await expect(card(page, "sonder-inference").locator("[data-testid=producer-state]")).toHaveText("live");
        await expect(page.locator("#warnings")).toContainText("Ignored the credentials or token parameters inside a connect URL");
        const leaks = await page.evaluate(() => ({
            url: /SECRET/.test(location.href),
            dom: /SECRET/.test(document.documentElement.outerHTML),
            input: /SECRET/.test((document.getElementById("ws-url") as HTMLInputElement).value),
        }));
        expect(leaks).toEqual({ url: false, dom: false, input: false });
        await expect(page.locator("#ws-url")).toHaveValue(new URL(runtime.urls.base).toString());
    });

    test("cards and rows take human-speed clicks while a producer streams", async ({ page }) => {
        await page.goto(`./?fixture=0&view=events&connect=${encodeURIComponent(streaming.urls.base)}`);
        const live = card(page, "sonder-inference");
        await expect(live.locator("[data-testid=producer-state]")).toHaveText("live");

        // The card element survives counter updates (patched in place, not rebuilt).
        await page.evaluate(() => {
            (window as unknown as { __card: Element | null }).__card = document.querySelector("[data-testid=producer-card]");
        });
        const before = await counter(page, "sonder-inference", "received");
        await expect.poll(() => counter(page, "sonder-inference", "received"), { timeout: 10_000 }).toBeGreaterThan(before);
        expect(await page.evaluate(() => (window as unknown as { __card: Element | null }).__card === document.querySelector("[data-testid=producer-card]"))).toBe(true);

        // A row pressed and released 150 ms later is selected, although rows keep arriving.
        // Fill the table first: without Follow latest the cursor (and so the row count) stays put,
        // while every render still repaints the table.
        await expect.poll(() => page.locator("#table-wrap tr.row").count(), { timeout: 15_000 }).toBeGreaterThan(12);
        await page.locator("#follow-check").uncheck();
        // The middle one of the rows fully inside the table's viewport.
        const target = await page.evaluate(() => {
            const wrap = document.getElementById("table-wrap")!.getBoundingClientRect();
            const rows = [...document.querySelectorAll<HTMLTableRowElement>("#table-wrap tr.row")].filter((r) => {
                const b = r.getBoundingClientRect();
                return b.top >= wrap.top + 30 && b.bottom <= wrap.bottom;
            });
            const row = rows[Math.floor(rows.length / 2)];
            if (!row) {
                return null;
            }
            const b = row.getBoundingClientRect();
            return { x: b.left + Math.min(150, b.width / 3), y: b.top + b.height / 2, seq: row.cells[0]!.textContent };
        });
        expect(target).not.toBeNull();
        await slowClick(page, target!.x, target!.y);
        const pressed = target!.seq;
        await expect(page.locator("#table-wrap tr.row.selected")).toHaveCount(1);
        await expect(page.locator("#inspector dl.kv dt", { hasText: /^sequence$/ }).locator("xpath=following-sibling::dd[1]")).toHaveText(pressed!);

        // Disconnect with the same slow click.
        const button = live.getByRole("button", { name: "Disconnect sonder-inference" });
        const box = (await button.boundingBox())!;
        await slowClick(page, box.x + box.width / 2, box.y + box.height / 2);
        await expect(live.locator("[data-testid=producer-state]")).toHaveText("disconnected");
    });

    test("Test explains discovery, missing tokens and CORS", async ({ page }) => {
        await page.goto("./?fixture=0");
        const result = page.locator("#probe-result");
        await page.locator("#ws-url").fill(inference.urls.base);
        await page.locator("#probe-btn").click();
        await expect(result).toHaveAttribute("data-tone", "ok");
        await expect(result).toContainText("Found sonder-inference");
        await expect(result).toContainText("role inference, SYNTHETIC data");
        await expect(result).toContainText("Streams: sse, ndjson, websocket");

        await page.locator("#ws-url").fill(guarded.urls.base);
        await page.locator("#probe-btn").click();
        await expect(result).toHaveAttribute("data-tone", "error");
        await expect(result).toContainText("needs a token");

        await page.locator("#ws-url").fill(foreign.urls.base);
        await page.locator("#probe-btn").click();
        await expect(result).toHaveAttribute("data-tone", "error");
        await expect(result).toContainText("SONDER_OBSERVATORY_ORIGINS");
        await expect(result).toContainText("SONDER_CORS_ORIGINS works too, but it also allows that origin to call admin routes");
        await expect(result).toContainText("--cors-origin");
    });

    test("presets and recent endpoints fill the form", async ({ page }) => {
        await page.goto("./?fixture=0");
        await page.locator("#preset-list button").nth(1).click();
        await expect(page.locator("#ws-url")).toHaveValue("http://127.0.0.1:11437");
        await page.locator("#ws-url").fill(runtime.urls.sse);
        await page.locator("#transport-select").selectOption("sse");
        await page.locator("#connect-btn").click();
        await expect(card(page, "sonder-runtime").locator("[data-testid=producer-state]")).toHaveText("live");
        await page.reload();
        const recent = page.locator("#recent-endpoints button");
        await expect(recent).toHaveCount(1);
        await expect(recent).toContainText(runtime.urls.sse);
        await page.locator("#ws-url").fill("");
        await recent.click();
        await expect(page.locator("#ws-url")).toHaveValue(runtime.urls.sse);
        await expect(page.locator("#transport-select")).toHaveValue("sse");
        await page.locator("#recent-clear").click();
        await expect(page.locator("#recent-endpoints button")).toHaveCount(0);
    });

    // Screenshots of Overview, Events and Sources in both themes and widths
    // (written to $E2E_SHOTS_DIR for review; see docs/integration/e2e.md).
    for (const theme of ["dark", "light"] as const) {
        for (const [width, height] of [
            [1440, 900],
            [420, 900],
        ] as const) {
            test(`screenshots: ${theme} ${width}x${height}`, async ({ page }, testInfo) => {
                await page.setViewportSize({ width, height });
                await page.goto(
                    `./?fixture=0&theme=${theme}&connect=${encodeURIComponent(inference.urls.base)}&connect=${encodeURIComponent(runtime.urls.base)}`,
                );
                await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
                await expect(card(page, "sonder-runtime").locator("[data-testid=producer-state]")).toHaveText("live");
                await expect(card(page, "sonder-inference").locator("[data-testid=producer-state]")).toHaveText("live");
                await expect(page.locator("#cursor-label")).toContainText(`${2 * FIXTURE_EVENTS}/${2 * FIXTURE_EVENTS} events`);
                const tag = `${theme}-${width}x${height}`;
                if (width < 900) {
                    // Narrow: the sidebar starts collapsed; the Sources shot opens it.
                    await expect(page.locator("#sidebar")).toBeHidden();
                }
                await shot(page, testInfo, `connection-overview-${tag}`);
                await showView(page, "Events");
                await page.locator("#table-wrap [data-testid=event-row]").last().click();
                await shot(page, testInfo, `connection-events-${tag}`);
                if (width < 900) {
                    await page.locator("#sidebar-toggle").click();
                }
                await expect(page.locator("#connection-panel")).toBeVisible();
                await page.locator("#connection-panel").scrollIntoViewIfNeeded();
                await shot(page, testInfo, `connection-sources-${tag}`);
                expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            });
        }
    }
});
