import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Locator, type Page, type TestInfo } from "@playwright/test";
import { shot, showView } from "./helpers";

/**
 * Cross-repo ecosystem proof (docs/integration/ecosystem-e2e.md): a real
 * Sonder Runtime bound to a real Sonder-Inference `serve` (mock backend,
 * synthetic), both publishing live telemetry, viewed together in the
 * Observatory. It needs both producers running, so it is excluded unless
 * E2E_ECOSYSTEM=1 (playwright.config.ts); `npm run test:ecosystem` starts
 * them and runs this file.
 *
 * Env:
 *   E2E_RUNTIME_URL            Runtime base URL (default http://127.0.0.1:18435)
 *   E2E_INFERENCE_URL          Sonder-Inference base URL (default http://127.0.0.1:18437)
 *   E2E_A2A_MESSAGE_ID         messageId of the A2A turn; unique per run by default,
 *                              because SendMessage is idempotent per messageId
 *   E2E_RECORDING_PATH         where the saved .sobs is kept (default: the test output dir)
 *   E2E_RUNTIME_NO_ORIGIN_URL  a second Runtime started without the viewer's origin
 *                              (negative control 2); that test is skipped when unset
 *   E2E_SHOTS_DIR              screenshot folder (e2e/helpers.ts shot())
 *
 * Mock output is word salad: every assertion is about presence, correlation
 * and labelling, never quality (Sonder-Inference AGENTS.md).
 */

const RUNTIME = trimSlash(process.env.E2E_RUNTIME_URL ?? "http://127.0.0.1:18435");
const INFERENCE = trimSlash(process.env.E2E_INFERENCE_URL ?? "http://127.0.0.1:18437");
const NO_ORIGIN_RUNTIME = process.env.E2E_RUNTIME_NO_ORIGIN_URL ? trimSlash(process.env.E2E_RUNTIME_NO_ORIGIN_URL) : "";
const A2A_MESSAGE_ID = process.env.E2E_A2A_MESSAGE_ID?.trim() || `e2e-a2a-1-${Date.now().toString(36)}`;
/** Contract 6.2: turn ids that survive the cross-producer join. */
const TURN_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
/** Discovery, the first SSE batch and the retained-window replay on a loaded CI host. */
const LIVE_TIMEOUT = 30_000;

function trimSlash(url: string): string {
    return url.trim().replace(/\/+$/, "");
}

function card(page: Page, producer: string): Locator {
    return page.locator(`[data-testid=producer-card][data-producer="${producer}"]`);
}

async function counter(page: Page, producer: string, name: string): Promise<number> {
    return Number(await card(page, producer).locator(`[data-testid=producer-counters] [data-counter="${name}"]`).textContent());
}

/** Every card's title, state and error text, for failure messages. */
async function describeCards(page: Page): Promise<string> {
    const cards = await page.locator("[data-testid=producer-card]").evaluateAll((nodes) =>
        nodes.map((n) => ({
            producer: n.getAttribute("data-producer") ?? "",
            state: n.querySelector("[data-testid=producer-state]")?.textContent ?? "",
            text: (n.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
        })),
    );
    return JSON.stringify(cards, null, 1);
}

/** Waits for the named producer's card to be live; fails with every card's state otherwise. */
async function expectLive(page: Page, producer: string, url: string): Promise<void> {
    try {
        await expect(card(page, producer).locator("[data-testid=producer-state]")).toHaveText("live", { timeout: LIVE_TIMEOUT });
    } catch (error) {
        throw new Error(`the ${producer} producer at ${url} never reached "live"; cards: ${await describeCards(page)}`, { cause: error });
    }
}

/** "0:12.3 / 0:15.0 · 40/812 events" -> [40, 812] */
async function cursorCounts(page: Page): Promise<[number, number]> {
    const text = (await page.locator("#cursor-label").textContent()) ?? "";
    const m = /(\d+)\/(\d+) events/.exec(text);
    if (!m) {
        throw new Error(`unexpected cursor label: ${text}`);
    }
    return [Number(m[1]), Number(m[2])];
}

/** Event types of the table rows of one producer (the filtered set fits the viewport). */
async function rowTypes(page: Page, producer: string): Promise<string[]> {
    return page
        .locator(`#table-wrap [data-testid=event-row][data-producer="${producer}"]`)
        .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-event-type") ?? ""));
}

/** Sets the text and class filters and waits for the table to settle on the new filter. */
async function filterRows(page: Page, text: string, cls: string): Promise<void> {
    await page.locator("#filter-class").selectOption(cls);
    await page.locator("#filter-text").fill(text);
    await expect(page.locator("#table-count")).toContainText("shown");
}

/** Turn (a): the legacy HTTP chat route, routed through the gateway to sonder_inference. */
async function chatTurn(request: APIRequestContext): Promise<{ turnId: string; content: string; body: Record<string, unknown> }> {
    const response = await request.post(`${RUNTIME}/v1/chat/completions`, {
        data: { model: "sonder", messages: [{ role: "user", content: "e2e ping" }] },
        timeout: 60_000,
    });
    const text = await response.text();
    expect(response.status(), `POST /v1/chat/completions answered ${response.status()}: ${text.slice(0, 500)}`).toBe(200);
    const body = JSON.parse(text) as Record<string, unknown>;
    const choices = body.choices as { message?: { content?: string } }[] | undefined;
    const content = choices?.[0]?.message?.content ?? "";
    expect(content.trim().length, "assistant content").toBeGreaterThan(0);
    const turnId = response.headers()["x-sonder-correlation-id"] ?? "";
    expect(turnId, "X-Sonder-Correlation-Id").toMatch(TURN_ID);
    return { turnId, content, body };
}

/** Turn (b): the ChatService path, JSON-RPC SendMessage on /a2a. */
async function a2aTurn(request: APIRequestContext, messageId: string): Promise<string> {
    const response = await request.post(`${RUNTIME}/a2a`, {
        data: {
            jsonrpc: "2.0",
            id: 1,
            method: "SendMessage",
            params: { message: { messageId, role: "ROLE_USER", parts: [{ text: "e2e a2a ping" }] } },
        },
        timeout: 60_000,
    });
    const text = await response.text();
    expect(response.status(), `POST /a2a answered ${response.status()}: ${text.slice(0, 500)}`).toBe(200);
    const body = JSON.parse(text) as { result?: { task?: { status?: { state?: string }; artifacts?: { parts?: { text?: string }[] }[] } }; error?: unknown };
    expect(body.error, `SendMessage error: ${text.slice(0, 500)}`).toBeUndefined();
    const task = body.result?.task;
    expect(task?.status?.state).toBe("TASK_STATE_COMPLETED");
    const answer = task?.artifacts?.[0]?.parts?.[0]?.text ?? "";
    expect(answer.trim().length, "A2A artifact text").toBeGreaterThan(0);
    return answer;
}

async function axeClean(page: Page, testInfo: TestInfo, name: string): Promise<void> {
    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    const summary = results.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        targets: v.nodes.map((n) => n.target.join(" ")),
    }));
    await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
    expect(summary, `axe WCAG A/AA violations in ${name}`).toEqual([]);
}

test.describe("Sonder ecosystem (live Runtime + Sonder-Inference)", () => {
    test.describe.configure({ mode: "serial" });

    test("connected ecosystem: two live producers, one correlated turn, replayable recording", async ({ page, request }, testInfo) => {
        test.setTimeout(180_000);
        const pageErrors: string[] = [];
        page.on("pageerror", (err) => pageErrors.push(err.message));

        // 1-2. Both producers through discovery plus SSE.
        await page.goto(`./?fixture=0&connect=${encodeURIComponent(RUNTIME)}&connect=${encodeURIComponent(INFERENCE)}`);
        await expectLive(page, "sonder-runtime", RUNTIME);
        await expectLive(page, "sonder-inference", INFERENCE);
        await expect(card(page, "sonder-runtime")).toContainText("runtime");
        await expect(card(page, "sonder-inference")).toContainText("inference");
        await expect(card(page, "sonder-runtime")).toContainText("sse");
        await expect(card(page, "sonder-inference")).toContainText("sse");

        // 3. Turn (a) after connecting, so its events arrive live; R is the turn id.
        const chat = await chatTurn(request);
        const R = chat.turnId;
        testInfo.annotations.push({ type: "turn-id", description: R });
        // Turn (b), with a messageId unique to this run.
        await a2aTurn(request, A2A_MESSAGE_ID);
        testInfo.annotations.push({ type: "a2a-message-id", description: A2A_MESSAGE_ID });

        // 4. The turn in the merged table, filtered by R.
        await showView(page, "Events");
        await filterRows(page, R, "request");
        await expect
            .poll(() => rowTypes(page, "sonder-runtime"), { timeout: LIVE_TIMEOUT, message: `Runtime request rows for ${R}` })
            .toEqual(expect.arrayContaining(["request.started", "request.completed"]));
        await expect
            .poll(() => rowTypes(page, "sonder-inference"), { timeout: LIVE_TIMEOUT, message: `Inference request rows with run_id ${R}` })
            .toEqual(expect.arrayContaining(["request.queued", "request.started", "request.completed"]));
        // request.queued.kind is 'chat' (contract 2.6: every request runs through Session::chat).
        await expect(page.locator('#table-wrap [data-testid=event-row][data-producer="sonder-inference"][data-event-type="request.queued"]')).toContainText(
            "kind=chat",
        );

        await filterRows(page, R, "agent");
        const route = page.locator('#table-wrap [data-testid=event-row][data-producer="sonder-runtime"][data-event-type="route.selected"]');
        await expect(route).toHaveCount(1);
        await expect(route).toContainText("provider=sonder_inference");

        await filterRows(page, R, "inference");
        await expect(
            page.locator('#table-wrap [data-testid=event-row][data-producer="sonder-inference"][data-event-type="inference.token.generated"]').first(),
        ).toBeVisible();

        // Parent/child link: the Runtime request.completed row relates to Inference events
        // through parent_request_id and run_id (contract 6.2 and 8.4).
        await filterRows(page, R, "request");
        await page.locator('#table-wrap [data-testid=event-row][data-producer="sonder-runtime"][data-event-type="request.completed"]').click();
        const related = page.locator("#inspector [data-testid=related-events]");
        await expect(related.locator('[data-testid=related-event][data-producer="sonder-inference"]').first()).toBeVisible();
        await expect(related.locator('[data-group=children] [data-testid=related-event][data-producer="sonder-inference"]').first()).toBeVisible();
        await expect(related.locator('[data-group=run] [data-testid=related-event][data-producer="sonder-inference"]').first()).toBeVisible();
        await shot(page, testInfo, "e2e-inspector");

        // Synthetic labelling: the mock backend marks every Inference envelope.
        await expect(page.locator("#synthetic-badge")).toBeVisible();
        await expect(page.locator("#synthetic-banner")).toBeVisible();
        await expect(page.locator("#synthetic-banner")).toContainText("sonder-inference");
        await expect(page.locator("#synthetic-banner")).not.toContainText("sonder-runtime");
        await expect(card(page, "sonder-inference")).toContainText("SYNTHETIC");

        // The /a2a turn: Runtime turn events keyed by the messageId, and Inference events under it.
        await filterRows(page, A2A_MESSAGE_ID, "request");
        await expect
            .poll(() => rowTypes(page, "sonder-runtime"), { timeout: LIVE_TIMEOUT, message: `Runtime rows for ${A2A_MESSAGE_ID}` })
            .toEqual(expect.arrayContaining(["request.started", "request.completed"]));
        await expect
            .poll(() => rowTypes(page, "sonder-inference"), { timeout: LIVE_TIMEOUT, message: `Inference rows with run_id ${A2A_MESSAGE_ID}` })
            .toEqual(expect.arrayContaining(["request.queued", "request.completed"]));

        // Counters: both producers delivered events and none was rejected.
        for (const producer of ["sonder-runtime", "sonder-inference"]) {
            expect(await counter(page, producer, "received"), `${producer} received`).toBeGreaterThan(0);
            expect(await counter(page, producer, "rejected"), `${producer} rejected`).toBe(0);
        }

        // 6. Accessibility of the connected view (Events with the inspector, then Overview).
        await filterRows(page, R, "all");
        await axeClean(page, testInfo, "connected-events");
        await shot(page, testInfo, "e2e-connected-events");
        await showView(page, "Overview");
        await axeClean(page, testInfo, "connected-overview");
        await shot(page, testInfo, "e2e-connected-overview");
        await page.locator("#connection-panel").scrollIntoViewIfNeeded();
        await shot(page, testInfo, "e2e-producers");

        // 5. Freeze the session (Disconnect keeps the events), save, reopen through the replay path.
        await card(page, "sonder-inference").getByRole("button", { name: "Disconnect sonder-inference" }).click();
        await card(page, "sonder-runtime").getByRole("button", { name: "Disconnect sonder-runtime" }).click();
        await expect(card(page, "sonder-inference").locator("[data-testid=producer-state]")).toHaveText("disconnected");
        await expect(card(page, "sonder-runtime").locator("[data-testid=producer-state]")).toHaveText("disconnected");
        const [, total] = await cursorCounts(page);
        expect(total).toBeGreaterThan(0);
        const downloadReady = page.waitForEvent("download");
        await page.locator("#save-btn").click();
        // The ordinary mock turn carries response text even when the producers
        // declare capture off. Saving must still require explicit fixture consent.
        const warning = page.getByRole("dialog", { name: "This export may contain sensitive data" });
        await expect(warning).toBeVisible();
        await expect(warning.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
        await warning.getByRole("button", { name: "Export anyway", exact: true }).click();
        const download = await downloadReady;
        const saved = process.env.E2E_RECORDING_PATH?.trim() || testInfo.outputPath("ecosystem.sobs");
        await download.saveAs(saved);
        const lines = readFileSync(saved, "utf8").split("\n").filter((l) => l.trim() !== "");
        const manifest = JSON.parse(lines[0]!) as { format: string; event_count: number; producers: { name: string; role: string | null; synthetic?: boolean }[] };
        expect(manifest.format).toBe("sonder.observatory.recording/1");
        expect(manifest.event_count).toBe(total);
        expect(lines.length - 1).toBe(total);
        const roles = Object.fromEntries(manifest.producers.map((p) => [p.name, p.role]));
        expect(roles).toMatchObject({ "sonder-runtime": "runtime", "sonder-inference": "inference" });

        await page.locator("#file-input").setInputFiles(saved);
        await expect(page.locator("#source-badge")).toContainText("recording");
        await expect(page.locator("#cursor-label")).toContainText(`${total}/${total} events`);
        await expect(page.locator("#synthetic-banner")).toContainText("sonder-inference");
        await shot(page, testInfo, "e2e-replay");

        expect(pageErrors, "uncaught page errors").toEqual([]);
    });

    test("negative control: a Runtime without the viewer's origin fails with CORS advice", async ({ page }, testInfo) => {
        test.skip(NO_ORIGIN_RUNTIME === "", "E2E_RUNTIME_NO_ORIGIN_URL is not set");
        await page.goto(`./?fixture=0&connect=${encodeURIComponent(NO_ORIGIN_RUNTIME)}`);
        const failed = page.locator("[data-testid=producer-card]").first();
        await expect(failed.locator("[data-testid=producer-state]")).toHaveText("failed", { timeout: LIVE_TIMEOUT });
        await expect(failed).toContainText("SONDER_OBSERVATORY_ORIGINS");
        await expect(failed).toContainText("SONDER_CORS_ORIGINS");
        await shot(page, testInfo, "e2e-negative-cors");
    });
});
