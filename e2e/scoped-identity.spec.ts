import { expect, test, type Page } from "@playwright/test";
import type { ObservatoryEvent } from "../src/protocol/events";
import { at } from "../tests/helpers";
import { inspectorEventId, scrubTo } from "./helpers";

const a = { name: "x", node_id: "y\u0000z", instance_id: "i", version: "test", role: "inference", synthetic: true };
const b = { ...a, name: "x\u0000y", node_id: "z" };
const event = (ms: number, type: string, producer: ObservatoryEvent["producer"] = a, extra: Partial<ObservatoryEvent> = {}) => at(ms, type, { producer, request_id: "child", ...extra });

async function load(page: Page, name: string, events: readonly ObservatoryEvent[]): Promise<void> {
    await page.locator("#file-input").setInputFiles({
        name, mimeType: "application/x-ndjson", buffer: Buffer.from(events.map(e => JSON.stringify(e)).join("\n") + "\n"),
    });
    await expect(page.locator("#source-badge")).toContainText(name);
    await expect(page.locator("#synthetic-badge")).toBeVisible();
    await scrubTo(page, 1000);
    await page.locator("#follow-check").uncheck();
}

test("Inspector separates delimiter-colliding streams and preserves lifecycle links across replacement", async ({ page }) => {
    const root = event(1, "request.started", { ...a, name: "sonder-runtime", instance_id: "rt", role: "runtime" }, { request_id: "R", run_id: "run" });
    const queued = event(2, "request.queued", a, { run_id: "run", attributes: { parent_request_id: "R" } });
    const foreign = event(3, "request.queued", b, { run_id: "run", attributes: { parent_request_id: "wrong" } });
    const selected = event(4, "inference.token.generated", a, { run_id: "run" });
    const foreignOutput = event(5, "inference.token.generated", b, { run_id: "run" });
    const tail = event(6, "inference.token.generated", a, { run_id: "run" });
    await page.goto("./?fixture=0&view=events");
    await load(page, "synthetic-scoped-identity.ndjson", [root, queued, foreign, selected, foreignOutput, tail]);
    await page.locator('#table-wrap tr.row[data-pos="3"]').click();
    await expect(inspectorEventId(page)).toHaveText(selected.event_id);
    await expect(page.locator('#inspector [data-group="request"] [data-testid="related-event"]')).toHaveCount(2);
    const parent = page.locator('#inspector [data-group="parent"]');
    await expect(parent.getByRole("button")).toHaveCount(1);
    await parent.getByRole("button").click();
    await expect(inspectorEventId(page)).toHaveText(root.event_id);
    // Related navigation moves the cursor; restore it explicitly before selecting again.
    await scrubTo(page, 1000);
    await page.locator('#table-wrap tr.row[data-pos="3"]').click();
    await expect(page.locator('#inspector [data-group="request"] [data-testid="related-event"]')).toHaveCount(2);
    await load(page, "synthetic-scoped-replacement.ndjson", [root, selected]);
    await page.locator('#table-wrap tr.row[data-pos="1"]').click();
    await expect(inspectorEventId(page)).toHaveText(selected.event_id);
    await expect(page.locator('#inspector [data-group="parent"]')).toHaveCount(0);
    await expect(page.locator('#inspector [data-group="request"]')).toHaveCount(0);
});

test("3D detail labels keep omitted source IDs and policy text remains scoped", async ({ page }) => {
    const events = [
        event(1, "request.started", a, { request_id: "old|original" }),
        event(2, "inference.token.generated", a, { request_id: "old|original", attributes: { probability: 0.9 } }),
        event(3, "request.completed", a, { request_id: "old|original" }),
    ];
    for (let i = 0; i < 120; i++) {
        events.push(event(4 + 2 * i, "request.started", a, { request_id: `r${i}` }));
        events.push(event(5 + 2 * i, "request.completed", a, { request_id: `r${i}` }));
    }
    await page.goto("./?fixture=0&view=3d");
    await load(page, "synthetic-omitted-source-label.ndjson", events);
    const rows = page.locator(".i3d-table tbody tr");
    const output = rows.filter({ has: page.getByRole("cell", { name: "output", exact: true }) });
    const token = rows.filter({ has: page.getByRole("cell", { name: "token", exact: true }) });
    await expect(output).toHaveCount(1);
    await expect(output.locator("td").nth(2)).toHaveText("old|original");
    await expect(token.locator("td").nth(2)).toHaveText("old|original");
    await expect(page.locator(".i3d-summary")).toContainText("1 older finished request(s)");
    await expect(page.locator(".i3d-table")).not.toContainText("obs-key/1:");

    const pa = { ...a, name: "n", node_id: "n", instance_id: "i|s" };
    const pb = { ...pa, instance_id: "i" };
    await load(page, "synthetic-scoped-policies.ndjson", [
        event(1, "session.created", pa, { session_id: "t", attributes: { text_capture: "off" } }),
        event(2, "session.created", pb, { session_id: "s|t", attributes: { text_capture: "full" } }),
        event(3, "inference.decode.started", pa, { session_id: "t", request_id: "off" }),
        event(4, "inference.decode.started", pb, { session_id: "s|t", request_id: "full" }),
        event(5, "inference.token.generated", pa, { session_id: "t", request_id: "off", attributes: { text: "synthetic-off-content", index: 0, probability: 0.9 } }),
        event(6, "inference.token.generated", pb, { session_id: "s|t", request_id: "full", attributes: { text: "synthetic-full-content", index: 0, probability: 0.9 } }),
    ]);
    await expect(page.locator(".i3d-output")).toContainText("synthetic-full-content");
    await expect(page.locator(".i3d-output")).not.toContainText("synthetic-off-content");
    await expect(page.locator(".i3d-output")).toContainText("text capture policy does not allow it");
});
