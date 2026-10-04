import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { FIXTURE_EVENTS, openFixture } from "./helpers";

/**
 * Export menu (header "Export…" → #export-dialog) and Save, wired to
 * src/export through exportWithConfirmation: formats, "Current view" range,
 * keyboard handling, and the sensitive-data warning (never skipped).
 */
const fixtureText = () => readFileSync(fileURLToPath(new URL("../fixtures/synthetic-session.ndjson", import.meta.url)), "utf8");

/** The synthetic fixture with its session declaring full text capture (a sensitive export). */
function fullCaptureText(): string {
    const text = fixtureText();
    const out = text.replace('"text_capture":"none"', '"text_capture":"full"');
    expect(out).not.toBe(text);
    return out;
}

/** Synthetic fixture with one canonical Inference chat queue envelope. */
function inferenceMessagesText(messages: unknown): string {
    const events = fixtureText().trim().split("\n").map((line) => JSON.parse(line) as {
        event_type: string; producer: Record<string, unknown>; attributes: Record<string, unknown>;
    });
    const queued = events.find((event) => event.event_type === "request.started");
    if (!queued) throw new Error("fixture needs a request event");
    queued.event_type = "request.queued";
    queued.producer = { name: "sonder-inference", version: "0.1.0", node_id: "mock-node", role: "inference", synthetic: true };
    queued.attributes = { kind: "chat", messages };
    return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

async function openRecording(page: Page, name: string, text: string): Promise<void> {
    await page.goto("./?fixture=0");
    await page.locator("#file-input").setInputFiles({ name, mimeType: "application/x-ndjson", buffer: Buffer.from(text) });
    await expect(page.locator("#source-badge")).toContainText(`recording · ${name}`);
    await expect(page.locator("#cursor-label")).toContainText(`${FIXTURE_EVENTS}/${FIXTURE_EVENTS} events`);
}

async function downloadText(page: Page, action: () => Promise<void>): Promise<{ name: string; text: string }> {
    const [download] = await Promise.all([page.waitForEvent("download"), action()]);
    const file = await download.path();
    return { name: download.suggestedFilename(), text: readFileSync(file, "utf8") };
}

test.describe("export", () => {
    test("Inference chat counters export without a plaintext warning", async ({ page }) => {
        await openRecording(page, "inference-count.ndjson", inferenceMessagesText(1));
        await expect(page.locator("#synthetic-badge")).toBeVisible();
        await page.locator("#export-btn").click();
        await page.getByRole("radio", { name: "Observatory recording (.sobs)" }).check();
        const { text } = await downloadText(page, () => page.getByRole("button", { name: "Export", exact: true }).click());
        await expect(page.getByRole("dialog", { name: "This export may contain sensitive data" })).toBeHidden();
        const queued = text.trim().split("\n").map((line) => JSON.parse(line) as { event_type?: string; attributes?: Record<string, unknown> })
            .find((event) => event.event_type === "request.queued" && event.attributes?.kind === "chat");
        expect(queued?.attributes?.messages).toBe(1);
    });

    test("Inference chat payloads still require explicit sensitive export acknowledgement", async ({ page }) => {
        const canary = "synthetic private chat canary";
        await openRecording(page, "inference-payload.ndjson", inferenceMessagesText([{ role: "user", content: canary }]));
        let downloads = 0;
        page.on("download", () => { downloads += 1; });
        await page.locator("#export-btn").click();
        await page.getByRole("radio", { name: "Observatory recording (.sobs)" }).check();
        await page.getByRole("button", { name: "Export", exact: true }).click();
        const warning = page.getByRole("dialog", { name: "This export may contain sensitive data" });
        await expect(warning).toBeVisible();
        await warning.getByRole("button", { name: "Cancel" }).click();
        expect(downloads).toBe(0);
        await page.locator("#export-btn").click();
        await page.getByRole("button", { name: "Export", exact: true }).click();
        const { text } = await downloadText(page, () => warning.getByRole("button", { name: "Export anyway" }).click());
        expect(text).toContain(canary);
    });

    test("the dialog is keyboard operable and returns focus", async ({ page }) => {
        await openFixture(page);
        const button = page.locator("#export-btn");
        await button.focus();
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog", { name: "Export" });
        await expect(dialog).toBeVisible();
        await expect(page.locator("#export-format-html")).toBeFocused();
        await expect(page.locator("#export-scope-view-help")).toContainText("all events");
        // Single-key shortcuts stay off while the dialog is open (J would select an event).
        await page.keyboard.press("j");
        await expect(page.locator("#inspector")).not.toContainText("event_id");
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(button).toBeFocused();
    });

    test("Markdown summary of the whole session downloads", async ({ page }) => {
        await openFixture(page);
        await page.locator("#export-btn").click();
        await page.getByRole("radio", { name: "Markdown summary" }).check();
        const { name, text } = await downloadText(page, () => page.getByRole("button", { name: "Export", exact: true }).click());
        expect(name).toMatch(/^observatory-ses_synthetic_0001-.*-summary\.md$/);
        expect(text).toContain("| Tokens (decode rate) | 334 derived");
        await expect(page.locator("#warnings")).toContainText(`Exported Markdown summary: ${name}`);
    });

    test("HTML report is self-contained", async ({ page }) => {
        await openFixture(page);
        await page.locator("#export-btn").click();
        const { name, text } = await downloadText(page, () => page.getByRole("button", { name: "Export", exact: true }).click());
        expect(name).toMatch(/-report\.html$/);
        expect(text).toContain("Content-Security-Policy");
        expect(text).not.toMatch(/<script/i);
    });

    test("Current view exports the filtered range as a .sobs recording", async ({ page }) => {
        await openFixture(page, "view=events");
        await page.locator("#filter-class").selectOption("error");
        await page.locator("#export-btn").click();
        await expect(page.locator("#export-scope-view-help")).toContainText("class=error");
        await page.getByRole("radio", { name: "Observatory recording (.sobs)" }).check();
        await page.getByRole("radio", { name: "Current view" }).check();
        const { name, text } = await downloadText(page, () => page.getByRole("button", { name: "Export", exact: true }).click());
        expect(name).toMatch(/\.sobs$/);
        const lines = text.trim().split("\n").map((l) => JSON.parse(l) as { event_type?: string; kind?: string });
        const events = lines.slice(1);
        expect(events.length).toBeGreaterThan(0);
        expect(events.length).toBeLessThan(FIXTURE_EVENTS);
        expect(events.every((e) => /failed|retry|guard/.test(e.event_type ?? ""))).toBe(true);
    });

    test("a sensitive session asks first; Cancel writes nothing, Export anyway downloads", async ({ page }) => {
        await openRecording(page, "full-capture.ndjson", fullCaptureText());
        let downloads = 0;
        page.on("download", () => {
            downloads += 1;
        });
        await page.locator("#export-btn").click();
        await page.getByRole("button", { name: "Export", exact: true }).click();
        const warning = page.getByRole("dialog", { name: "This export may contain sensitive data" });
        await expect(warning).toBeVisible();
        await expect(warning.getByRole("button", { name: "Cancel" })).toBeFocused();
        await warning.getByRole("button", { name: "Cancel" }).click();
        await expect(warning).toBeHidden();
        await expect(page.locator("#warnings")).toContainText("HTML report export cancelled; nothing was written.");
        expect(downloads).toBe(0);

        await page.locator("#export-btn").click();
        await page.getByRole("button", { name: "Export", exact: true }).click();
        const { name } = await downloadText(page, () => warning.getByRole("button", { name: "Export anyway" }).click());
        expect(name).toMatch(/-report\.html$/);
    });

    test("single-key shortcuts stay off while the sensitive-export warning is open", async ({ page }) => {
        await openRecording(page, "full-capture.ndjson", fullCaptureText());
        await page.locator("#export-btn").click();
        await page.getByRole("button", { name: "Export", exact: true }).click();
        const warning = page.getByRole("dialog", { name: "This export may contain sensitive data" });
        await expect(warning).toBeVisible();
        await expect(page.locator("#export-dialog")).toBeHidden();

        await page.keyboard.press("t");
        await page.keyboard.press("?");
        await page.keyboard.press("j");
        await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
        await expect(page.locator("#shortcuts-dialog")).toBeHidden();
        await expect(page.locator("#inspector")).not.toContainText("event_id");
        await expect(warning).toBeVisible();
    });

    test("Save with declared capture off and actual plaintext waits for explicit consent", async ({ page }) => {
        const lines = fixtureText().trimEnd().split("\n").map((line) => JSON.parse(line) as { event_type: string; attributes: Record<string, unknown> });
        const token = lines.find((event) => event.event_type === "inference.token.generated")!;
        token.attributes.token_text = "synthetic plaintext";
        await openRecording(page, "plaintext.ndjson", lines.map((event) => JSON.stringify(event)).join("\n") + "\n");
        let downloads = 0;
        page.on("download", () => { downloads += 1; });
        await page.locator("#save-btn").click();
        const warning = page.getByRole("dialog", { name: "This export may contain sensitive data" });
        await expect(warning).toContainText('declares text capture "none", but events contain plaintext');
        await expect(warning.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
        expect(downloads).toBe(0);
        const { text } = await downloadText(page, () => warning.getByRole("button", { name: "Export anyway", exact: true }).click());
        expect(text).toContain("synthetic plaintext");
        expect(downloads).toBe(1);
    });

    test("Save asks before writing a sensitive session too", async ({ page }) => {
        await openRecording(page, "full-capture.ndjson", fullCaptureText());
        await page.locator("#save-btn").click();
        const warning = page.getByRole("dialog", { name: "This export may contain sensitive data" });
        await expect(warning).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(warning).toBeHidden();
        await expect(page.locator("#warnings")).toContainText("export cancelled; nothing was written.");
    });
});
