import { expect, test } from "@playwright/test";
import { at } from "../tests/helpers";
import { inspectorEventId } from "./helpers";

test("output selection resolves original lifecycle parent evidence across producers", async ({ page }) => {
    const runtime = { name: "sonder-runtime", version: "1", node_id: "n", instance_id: "rt", role: "runtime", synthetic: true };
    const inference = { ...runtime, name: "sonder-inference", instance_id: "inf", role: "inference" };
    const parent = at(1, "request.started", { request_id: "R", run_id: "run", producer: runtime });
    const queued = at(2, "request.queued", { request_id: "child", run_id: "run", producer: inference, attributes: { parent_request_id: "R" } });
    const token = at(3, "inference.token.generated", { request_id: "child", run_id: "run", producer: inference, attributes: { unit: "token" } });
    await page.goto("./?fixture=0&view=events");
    await page.locator("#file-input").setInputFiles({ name: "synthetic-lineage.ndjson", mimeType: "application/x-ndjson", buffer: Buffer.from([parent, queued, token].map(e => JSON.stringify(e)).join("\n") + "\n") });
    await expect(page.locator("#source-badge")).toContainText("synthetic-lineage.ndjson");
    await expect(page.locator("#synthetic-badge")).toBeVisible();
    await page.locator('#table-wrap [data-event-type="inference.token.generated"]').click();
    await expect(inspectorEventId(page)).toHaveText(token.event_id);
    await expect(page.locator("#inspector pre.json")).not.toContainText("parent_request_id");
    const group = page.locator("#inspector [data-group=parent]");
    await expect(group).toContainText("Parent request R");
    await expect(group.locator('[data-testid=related-event][data-producer="sonder-runtime"]')).toHaveCount(1);
    await group.getByRole("button").click();
    await expect(inspectorEventId(page)).toHaveText(parent.event_id);
});
