import { statSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { generateEvents, writeFixture } from "../scripts/gen-large-fixture.mjs";
import { startFakeLiveProducer } from "../scripts/fake-live-producer.mjs";
import { FIXTURE_EVENTS, inspectorEventId, openFixture, scrubTo, showView } from "./helpers";

interface FileControl {
    hold: boolean;
    waiting: boolean;
    releasedRead: boolean;
    release: () => void;
}
const pageErrors = new WeakMap<Page, string[]>();
declare global {
    interface Window { __replacementFile?: FileControl; }
}

/** Distinct, content-free synthetic events with controlled origin and duration. */
function recording(name: string, count = 20, stepNs = 1_000_000_000, originNs = 1_000_000_000): Buffer {
    const base = generateEvents(2, 19).next().value!;
    return Buffer.from(Array.from({ length: count }, (_, index) => JSON.stringify({
        ...base, event_id: `${name}_${index}`, sequence: index,
        mono_ns: originNs + index * stepNs, session_id: `synthetic_${name}`,
        attributes: { synthetic: true, text_capture: "none" },
    })).join("\n") + "\n");
}

async function loadFile(page: Page, name: string, buffer = recording(name)): Promise<void> {
    await page.locator("#file-input").setInputFiles({ name: `${name}.ndjson`, mimeType: "application/x-ndjson", buffer });
    await expect(page.locator("#source-badge")).toContainText(`recording · ${name}.ndjson`);
}

async function expectEnd(page: Page, count: number): Promise<void> {
    await expect(page.locator("#follow-check")).toBeChecked();
    await expect(page.locator("#scrubber")).toHaveValue("1000");
    await expect(page.locator("#cursor-label")).toContainText(`${count}/${count} events`);
    await expect(page.locator("#play-btn")).toHaveText("Play");
    if (count > 0) { await expect(page.locator("#mode-chip")).toContainText("at end"); }
    else { await expect(page.locator("#mode-chip")).toHaveText(""); }
}

/** Let any already scheduled replay callback observe the committed state. */
async function frames(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
}

async function fileControls(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const original = Blob.prototype.stream;
        const originalText = Blob.prototype.text;
        const state: FileControl = { hold: false, waiting: false, releasedRead: false, release: () => undefined };
        window.__replacementFile = state;
        File.prototype.text = function () {
            return this.name === "failed-read.ndjson" ? Promise.reject(new Error("synthetic read failure")) : originalText.call(this);
        };
        File.prototype.stream = function () {
            if (this.name === "failed-stream.ndjson") {
                return new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) {
                    controller.error(new Error("synthetic stream failure"));
                } });
            }
            const reader = original.call(this).getReader();
            let delivered = 0;
            let cancelled = false;
            state.releasedRead = false;
            state.waiting = false;
            return new ReadableStream<Uint8Array<ArrayBuffer>>({
                async pull(controller) {
                    const held = state.hold && delivered > 0;
                    if (held) {
                        state.waiting = true;
                        await new Promise<void>((resolve) => { state.release = resolve; });
                        state.waiting = false;
                    }
                    if (cancelled) { state.releasedRead = true; return; }
                    delivered += 1;
                    const { done, value } = await reader.read();
                    if (held) { state.releasedRead = true; }
                    if (done) { controller.close(); }
                    else { controller.enqueue(value); }
                },
                cancel(reason) { cancelled = true; return reader.cancel(reason); },
            });
        };
    });
}

function streamedRecording(name: string): Buffer {
    // A distinct-event stream beyond the 2 MiB cooperative loader threshold.
    const buffer = recording(name, 5_000, 10_000_000);
    expect(buffer.length).toBeGreaterThanOrEqual(2 * 1024 * 1024);
    return buffer;
}

test.beforeEach(async ({ page }) => {
    const errors: string[] = [];
    pageErrors.set(page, errors);
    page.on("pageerror", (error) => errors.push(error.message));
    await fileControls(page);
});

test.afterEach(async ({ page }, testInfo) => {
    const errors = pageErrors.get(page) ?? [];
    await testInfo.attach("browser-errors", { body: JSON.stringify(errors), contentType: "application/json" });
    expect(errors).toEqual([]);
});

test("successful recording replacement synchronizes Follow and the scrubbed cursor", async ({ page }, testInfo) => {
    await openFixture(page);
    await loadFile(page, "before");
    await showView(page, "Events");
    await page.locator("#table-wrap tbody tr.row").first().click();
    await expect(inspectorEventId(page)).toHaveText("before_0");
    await scrubTo(page, 250);
    await expect(page.locator("#follow-check")).not.toBeChecked();
    await loadFile(page, "after", recording("after", 20, 1_000_000_000, 100_000_000_000));
    await testInfo.attach("replacement-state", { contentType: "application/json", body: JSON.stringify({
        synthetic: true, follow: await page.locator("#follow-check").isChecked(),
        scrubber: await page.locator("#scrubber").inputValue(), cursor: await page.locator("#cursor-label").textContent(),
    }) });
    await expectEnd(page, 20);
    await expect(page.locator("#inspector")).toContainText("Select an event");
    await expect(page.locator("#table-wrap tbody tr.row").last()).toContainText("session.started");
    await page.locator("#table-wrap tbody tr.row").last().click();
    await expect(inspectorEventId(page)).toHaveText("after_19");
});

test("shorter, longer, empty and zero-duration replacements end coherently over 20 transitions", async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openFixture(page);
    const cases = [{ count: 20, step: 100_000_000 }, { count: 25, step: 5_000_000_000 },
        { count: 0, step: 0 }, { count: 10, step: 0 }, { count: 2, step: 10_000_000_000 }];
    for (let index = 0; index < 20; index += 1) {
        // Restore an old source with a nonzero duration even after an empty/tied source.
        await loadFile(page, `old_${index}`);
        await scrubTo(page, 250);
        if (index % 2 === 1) {
            await page.locator("#play-btn").click();
            await expect(page.locator("#play-btn")).toHaveText("Pause");
        }
        const next = cases[index % cases.length]!;
        const name = `transition_${index}`;
        await loadFile(page, name, recording(name, next.count, next.step, 100_000_000_000 + index * 1_000_000_000));
        await expectEnd(page, next.count);
        await frames(page);
        await expectEnd(page, next.count);
    }
    await scrubTo(page, 200);
    await page.locator("#fixture-btn").click();
    await expect(page.locator("#source-badge")).toContainText("fixture");
    await expectEnd(page, FIXTURE_EVENTS);
    expect(errors).toEqual([]);
    await testInfo.attach("transition-stability", { contentType: "application/json",
        body: JSON.stringify({ synthetic: true, successfulReplacements: 20, playingReplacements: 10,
            fixtureReplacement: true, browserErrors: errors }) });
});

test("streamed replacement stops playback before queued frames can move the new cursor", async ({ page }) => {
    await openFixture(page);
    await loadFile(page, "playing", recording("playing", 20, 10_000_000_000));
    await scrubTo(page, 250);
    await page.locator("#play-btn").click();
    await expect(page.locator("#play-btn")).toHaveText("Pause");
    await page.evaluate(() => { window.__replacementFile!.hold = true; });
    await page.locator("#file-input").setInputFiles({ name: "streamed.ndjson", mimeType: "application/x-ndjson", buffer: streamedRecording("streamed") });
    await expect.poll(() => page.evaluate(() => window.__replacementFile!.waiting)).toBe(true);
    await expect(page.locator("#load-status")).toBeVisible();
    await expect(page.locator("#play-btn")).toHaveText("Pause");
    await page.evaluate(() => { window.__replacementFile!.hold = false; window.__replacementFile!.release(); });
    await expect(page.locator("#source-badge")).toContainText("recording · streamed.ndjson");
    await expectEnd(page, 5_000);
    await frames(page);
    await expectEnd(page, 5_000);
});

test("cancelled, failed and superseded loads preserve the scrubbed source until a winning commit", async ({ page }) => {
    await openFixture(page);
    await loadFile(page, "kept");
    await showView(page, "Events");
    await page.locator("#table-wrap tbody tr.row").first().click();
    await scrubTo(page, 250);
    const cursor = await page.locator("#cursor-label").textContent();
    const assertKept = async () => {
        await expect(page.locator("#source-badge")).toContainText("recording · kept.ndjson");
        await expect(page.locator("#cursor-label")).toHaveText(cursor!);
        await expect(page.locator("#follow-check")).not.toBeChecked();
        await expect(inspectorEventId(page)).toHaveText("kept_0");
    };
    for (const name of ["failed-read", "failed-stream"]) {
        await page.locator("#file-input").setInputFiles({ name: `${name}.ndjson`, mimeType: "application/x-ndjson",
            buffer: name === "failed-read" ? recording(name) : streamedRecording(name) });
        await expect(page.locator("#warnings")).toContainText(/synthetic (read|stream) failure/);
        await assertKept();
    }
    await page.evaluate(() => { window.__replacementFile!.hold = true; });
    await page.locator("#file-input").setInputFiles({ name: "cancel.ndjson", mimeType: "application/x-ndjson", buffer: streamedRecording("cancel") });
    await expect.poll(() => page.evaluate(() => window.__replacementFile!.waiting)).toBe(true);
    await page.locator("#load-cancel").click();
    await assertKept();
    await page.evaluate(() => { window.__replacementFile!.hold = false; window.__replacementFile!.release(); });
    await expect.poll(() => page.evaluate(() => window.__replacementFile!.releasedRead)).toBe(true);
    await frames(page);
    await assertKept();
    await page.evaluate(() => { window.__replacementFile!.hold = true; });
    await page.locator("#file-input").setInputFiles({ name: "superseded.ndjson", mimeType: "application/x-ndjson", buffer: streamedRecording("superseded") });
    await expect.poll(() => page.evaluate(() => window.__replacementFile!.waiting)).toBe(true);
    await loadFile(page, "winner");
    await expectEnd(page, 20);
    await page.evaluate(() => { window.__replacementFile!.hold = false; window.__replacementFile!.release(); });
    await expect.poll(() => page.evaluate(() => window.__replacementFile!.releasedRead)).toBe(true);
    await frames(page);
    await expect(page.locator("#source-badge")).toContainText("recording · winner.ndjson");
    await expectEnd(page, 20);
    await expect(page.locator("#inspector")).toContainText("Select an event");
});

test("a 100k streamed disk recording replaces a paused source with bounded table DOM and final-event access", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const file = testInfo.outputPath("replacement-100k.ndjson");
    await writeFixture(file, 100_000, 31);
    await openFixture(page);
    await scrubTo(page, 250);
    await page.locator("#file-input").setInputFiles(file);
    await expect(page.locator("#source-badge")).toContainText("recording · replacement-100k.ndjson", { timeout: 60_000 });
    await expectEnd(page, 100_000);
    await showView(page, "Events");
    const rows = page.locator("#table-wrap tbody tr.row");
    const renderedRows = await rows.count();
    expect(renderedRows).toBeGreaterThan(0);
    expect(renderedRows).toBeLessThan(100);
    await page.locator("#table-wrap").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(rows.last()).toContainText("session.ended");
    await rows.last().click();
    await expect(inspectorEventId(page)).toHaveText("evt_lg_s31_0100000");
    await scrubTo(page, 250);
    await loadFile(page, "after-scale", recording("after-scale", 0));
    await expectEnd(page, 0);
    await expect(rows).toHaveCount(0);
    await expect(page.locator("#inspector")).toContainText("Select an event");
    expect(errors).toEqual([]);
    await testInfo.attach("recording-replacement-scale", { contentType: "application/json",
        body: JSON.stringify({ synthetic: true, events: 100_000, bytes: statSync(file).size,
            renderedRows, browserErrors: errors, finalEventSelected: "evt_lg_s31_0100000" }) });
});

test("paused live appends retain UI time; Follow resumes before recording replacement drains the producer", async ({ page }, testInfo) => {
    const events = recording("live", 20, 250_000_000).toString().trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const origin = new URL(String(testInfo.project.use.baseURL)).origin;
    const producer = await startFakeLiveProducer({ role: "runtime", events, corsOrigins: [origin], pace: "timeline" });
    try {
        await page.goto(`./?fixture=0&connect=${encodeURIComponent(producer.urls.base)}`);
        const total = async () => Number(/\/(\d+) events/.exec(await page.locator("#cursor-label").innerText())?.[1] ?? 0);
        await expect.poll(total).toBeGreaterThanOrEqual(3);
        await scrubTo(page, 250);
        await expect(page.locator("#follow-check")).not.toBeChecked();
        const position = (await page.locator("#cursor-label").innerText()).split(" / ")[0];
        const before = await total();
        await expect.poll(total).toBeGreaterThan(before);
        await expect(page.locator("#cursor-label")).toContainText(`${position} / `);
        await expect(page.locator("#follow-check")).not.toBeChecked();
        await page.locator("#follow-check").check();
        await expect.poll(async () => {
            const label = await page.locator("#cursor-label").innerText();
            const counts = /(\d+)\/(\d+) events/.exec(label);
            return counts?.[1] === counts?.[2];
        }).toBe(true);
        await loadFile(page, "after-live");
        await expectEnd(page, 20);
        await frames(page);
        await expectEnd(page, 20);
        await expect(page.locator("[data-testid=producer-card]")).toHaveCount(0);
        expect(producer.stats.connections).toBeGreaterThan(0);
    } finally {
        await producer.close();
    }
});
