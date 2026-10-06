import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { expect, test, type Page } from "@playwright/test";
import { scrubTo } from "./helpers";

function fixtureText(count: number): string {
    const lines = new Array<string>(count);
    for (let i = 0; i < count; i += 1) {
        lines[i] = JSON.stringify({ schema: "sonder.observatory.event/1", event_id: `compare_min_evt_${String(i).padStart(6, "0")}`, sequence: i, event_type: "request.started", wall_time: "2026-10-06T00:00:00.000Z", mono_ns: 1000 + i, session_id: "compare_min_session", run_id: "compare_min_run", agent_id: null, task_id: null, request_id: `compare_min_req_${String(i).padStart(6, "0")}`, parent_request_id: null, model_instance_id: null, producer: { name: "compare-minimum-synthetic", version: "1", node_id: "synthetic-node", instance_id: "fixed-instance", synthetic: true }, attributes: { turn_id: "compare_min_turn" } });
    }
    return lines.join("\n") + "\n";
}

async function endAndPause(page: Page): Promise<void> {
    await scrubTo(page, 1000);
    await expect(page.locator("#scrubber")).toHaveValue("1000");
    await expect(page.locator("#mode-chip")).toHaveText("Replay · at end");
    await expect(page.locator("#follow-check")).toBeChecked();
    await page.locator("#follow-check").uncheck();
    await expect(page.locator("#follow-check")).not.toBeChecked();
    await expect(page.locator("#scrubber")).toHaveValue("1000");
    await expect(page.locator("#mode-chip")).toHaveText("Replay · paused at cursor");
}

test("real Compare tab retains complete large totals while bounding rendered rows and replacing its source", async ({ page }, testInfo) => {
    const count = 131072, errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const text = fixtureText(count), fixture = testInfo.outputPath("compare-minimum-131072.ndjson");
    writeFileSync(fixture, text, { flag: "wx", mode: 0o600 });
    const hash = createHash("sha256").update(text).digest("hex");
    if (process.env.COMPARE_MINIMUM_REFERENCE_FIXTURE) {
        expect(createHash("sha256").update(readFileSync(process.env.COMPARE_MINIMUM_REFERENCE_FIXTURE)).digest("hex")).toBe(hash);
    }
    const started = performance.now();
    await page.goto("./?fixture=0&view=overview");
    await page.locator("#file-input").setInputFiles(fixture);
    await expect(page.locator("#source-badge")).toContainText("compare-minimum-131072.ndjson");
    await expect(page.locator("#cursor-label")).toContainText(`${count}/${count} events`);
    await expect(page.locator("#synthetic-badge")).toBeVisible();
    await endAndPause(page);
    const tab = page.getByRole("tab", { name: "Compare", exact: true });
    await expect(tab).toBeVisible();
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    const panel = page.locator("section.compare");
    await expect(panel).toBeVisible();
    await panel.locator("#compare-file-a").setInputFiles(fixture);
    await expect(panel.locator('.compare-side[data-side="a"]')).toContainText(`${count} events`);
    await expect(panel.locator('.compare-side[data-side="b"]')).toContainText(`${count} events`);
    await expect(panel.locator('.compare-side[data-side="a"] .badge-synthetic')).toBeVisible();
    await expect(panel.locator('.compare-side[data-side="b"] .badge-synthetic')).toBeVisible();
    const requests = panel.locator('#compare-totals tr[data-metric="requests"] td');
    await expect(requests).toHaveText(["131,072", "131,072", "±0", "same"]);
    await expect(panel.locator(".compare-alignment")).toHaveText(`Matched by request id: ${count} matched, 0 only in A, 0 only in B.`);
    await expect(panel.locator("#compare-rows tbody tr")).toHaveCount(200);
    await expect(panel).toContainText(`Showing the first 200 of ${count} requests.`);
    for (const key of ["ttftMs", "ttftP95Ms", "decodeTokPerSec", "promptTokens", "completionTokens", "costUsd", "cacheHitRate"]) {
        // renderTotals excludes n/a rows; the native analysis oracle separately proves null values.
        await expect(panel.locator(`#compare-totals tr[data-metric="${key}"]`)).toHaveCount(0);
    }
    await panel.getByRole("radio", { name: "Run", exact: true }).check();
    await expect(panel.locator(".compare-alignment")).toHaveText("Matched by run id: 1 matched, 0 only in A, 0 only in B.");
    await expect(panel.locator("#compare-rows tbody tr")).toHaveCount(1);
    await panel.getByRole("radio", { name: "Turn", exact: true }).check();
    await expect(panel.locator(".compare-alignment")).toHaveText("Matched by turn id: 1 matched, 0 only in A, 0 only in B.");
    await expect(panel.locator("#compare-rows tbody tr")).toHaveCount(1);
    await panel.getByRole("radio", { name: "Request", exact: true }).check();
    await expect(panel.locator("#compare-rows tbody tr")).toHaveCount(200);
    await page.locator("#file-input").setInputFiles({ name: "compare-minimum-small.ndjson", mimeType: "application/x-ndjson", buffer: Buffer.from(fixtureText(2)) });
    await expect(page.locator("#cursor-label")).toContainText("2/2 events");
    await expect(page.locator("#synthetic-badge")).toBeVisible();
    await endAndPause(page);
    await expect(requests).toHaveText(["131,072", "2", "−131,070 (−100.0%)", "changed"]);
    await expect(panel.locator(".compare-alignment")).toHaveText(`Matched by request id: 2 matched, ${count - 2} only in A, 0 only in B.`);
    expect(errors).toEqual([]);
    const evidence = JSON.stringify({ schema: "sonder.compare-minimum-browser-evidence/1", synthetic: true, fixture_sha256: hash, input_events: count, exact_full_totals: true, rendered_rows: 200, run_units: 1, turn_units: 1, replacement_events: 2, follow_unchecked: true, cursor_end: true, page_errors: errors, elapsed_ms: performance.now() - started, whole_test_timeout_unchanged_ms: 30000 }) + "\n";
    if (Buffer.byteLength(evidence) > 65536) throw new Error("Browser evidence exceeds64KiB");
    const evidencePath = testInfo.outputPath("compare-minimum-measurement.json");
    writeFileSync(evidencePath, evidence, { flag: "wx", mode: 0o600 });
    await testInfo.attach("compare-minimum-measurement", { path: evidencePath, contentType: "application/json" });
});
