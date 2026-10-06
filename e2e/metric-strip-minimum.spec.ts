import { createHash } from "node:crypto";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { expect, test, type Page } from "@playwright/test";
import type { ObservatoryEvent } from "../src/protocol/events";
import { scrubTo } from "./helpers";

const REQUESTS = 131072;
const SPACING_NS = 100_000_000;
const ORIGIN_NS = 1000;
const MAX_FIXTURE_BYTES = 160 * 1024 * 1024;

/** Numeric lifecycle-only recording; no text, content, credentials, or captured output. */
function writeFixture(file: string, count: number, prefix: string): { sha256: string; bytes: number } {
    const fd = openSync(file, "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    try {
        for (let from = 0; from < count; from += 256) {
            const lines: string[] = [];
            for (let i = from; i < Math.min(count, from + 256); i += 1) {
                for (const terminal of [false, true]) {
                    const sequence = 2 * i + Number(terminal);
                    const event: ObservatoryEvent = {
                        schema: "sonder.observatory.event/1",
                        event_id: `${prefix}_event_${sequence}`,
                        sequence,
                        event_type: terminal ? "request.completed" : "request.started",
                        wall_time: "2026-10-06T00:00:00.000Z",
                        mono_ns: ORIGIN_NS + i * SPACING_NS + (terminal ? ((i % 11) + 1) * 1_000_000 : 0),
                        session_id: `${prefix}_session`,
                        run_id: `${prefix}_run`,
                        request_id: `${prefix}_request_${i}`,
                        agent_id: null,
                        task_id: null,
                        model_instance_id: null,
                        producer: { name: "metric-strip-synthetic", version: "1", node_id: "synthetic-node", instance_id: prefix, role: "fixture", synthetic: true },
                        attributes: {},
                    };
                    lines.push(JSON.stringify(event));
                }
            }
            const chunk = lines.join("\n") + "\n";
            bytes += Buffer.byteLength(chunk);
            if (bytes > MAX_FIXTURE_BYTES) throw new Error("Metric-strip fixture exceeds160MiB");
            writeFileSync(fd, chunk);
            hash.update(chunk);
        }
    } finally {
        closeSync(fd);
    }
    return { sha256: hash.digest("hex"), bytes };
}

interface LatencyPaths {
    count: number;
    p50: string;
    p95: string;
}

/** Independent nearest-rank oracle: count frequencies instead of importing/sorting app windows. */
function expectedPaths(count: number): LatencyPaths {
    const frequencies = new Array<number>(12).fill(0);
    const p50: number[] = [], p95: number[] = [];
    const rankedValue = (rank: number): number => {
        let seen = 0;
        for (let value = 1; value <= 11; value += 1) {
            seen += frequencies[value]!;
            if (seen >= rank) return value;
        }
        throw new Error("Oracle rank outside its complete frequency window");
    };
    for (let i = 0; i < count; i += 1) {
        frequencies[(i % 11) + 1]! += 1;
        if (i >= 8) frequencies[((i - 8) % 11) + 1]! -= 1;
        const window = Math.min(i + 1, 8);
        p50.push(rankedValue(Math.ceil(window * 0.5)));
        p95.push(rankedValue(Math.ceil(window * 0.95)));
    }
    // Native extrema operate on at most1024 values per call, independent of cardinality.
    const path = (points: readonly number[]): string => {
        let max = -Infinity, min = 0;
        for (let from = 0; from < points.length; from += 1024) {
            const chunk = points.slice(from, from + 1024);
            max = Math.max(max, Math.max(...chunk));
            min = Math.min(min, Math.min(0, ...chunk));
        }
        const range = max - min || 1;
        const step = 96 / (points.length - 1);
        // Keep the documented coordinate arithmetic order so binary rounding does not change toFixed ties.
        return points.map((value, i) => `${(i * step).toFixed(1)},${(24 - ((value - min) / range) * 22).toFixed(1)}`).join(" ");
    };
    return { count, p50: path(p50), p95: path(p95) };
}

async function endAndPause(page: Page): Promise<void> {
    await scrubTo(page, 1000);
    await expect(page.locator("#scrubber")).toHaveValue("1000");
    await expect(page.locator("#mode-chip")).toHaveText("Replay · at end");
    await expect(page.locator("#follow-check")).toBeChecked();
    await page.locator("#follow-check").uncheck();
    await expect(page.locator("#follow-check")).not.toBeChecked();
    await expect(page.locator("#mode-chip")).toHaveText("Replay · paused at cursor");
}

/** Read-only DOM inspection; expected strings originate in the native test process. */
async function assertPaths(page: Page, expected: LatencyPaths): Promise<void> {
    await expect(page.locator('#metric-strip [data-metric="latency-p50"] .strip-sub')).toHaveText(`${expected.count} finished requests`);
    const actual = await page.locator("#metric-strip").evaluate((strip, oracle) => {
        return (["p50", "p95"] as const).map((id) => {
            const card = strip.querySelector(`[data-metric="latency-${id}"]`);
            const spark = card?.querySelector("svg.spark");
            const line = spark?.querySelector("polyline.spark-line")?.getAttribute("points") ?? "";
            const area = spark?.querySelector("polyline.spark-area")?.getAttribute("points") ?? "";
            return {
                id,
                svgCount: card?.querySelectorAll("svg.spark").length ?? 0,
                viewBox: spark?.getAttribute("viewBox") ?? null,
                linePoints: line ? line.trim().split(/\s+/).length : 0,
                areaPoints: area ? area.trim().split(/\s+/).length : 0,
                exactLine: line === oracle[id],
                exactArea: area === `0,26 ${oracle[id]} 96,26`,
                finiteCoordinates: line.length > 0 && !/NaN|Infinity/.test(line),
            };
        });
    }, expected);
    expect(actual).toEqual((["p50", "p95"] as const).map((id) => ({ id, svgCount: 1, viewBox: "0 0 96 26", linePoints: expected.count, areaPoints: expected.count + 2, exactLine: true, exactArea: true, finiteCoordinates: true })));
}

test("real metric strip keeps every large latency point through cursor changes and source replacement", async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const started = performance.now();
    const fixture = testInfo.outputPath("metric-strip-131072.ndjson");
    const replacement = testInfo.outputPath("metric-strip-two.ndjson");
    const input = writeFixture(fixture, REQUESTS, "large");
    const smallInput = writeFixture(replacement, 2, "replacement");
    const full = expectedPaths(REQUESTS), prefix = expectedPaths(REQUESTS / 2), small = expectedPaths(2);
    const pathHashes = (paths: LatencyPaths) => ({ p50: createHash("sha256").update(paths.p50).digest("hex"), p95: createHash("sha256").update(paths.p95).digest("hex") });
    let phase = "prepared", completed = false;
    let primaryFailed = false, primaryError: unknown;
    try {
        // Events view avoids unrelated Overview timeline work; the real metric strip is shared by every view.
        await page.goto("./?fixture=0&view=events");
        phase = "loading large recording";
        await page.locator("#file-input").setInputFiles(fixture);
        await expect(page.locator("#source-badge")).toContainText("metric-strip-131072.ndjson");
        await expect(page.locator("#cursor-label")).toContainText(`${2 * REQUESTS}/${2 * REQUESTS} events`);
        await expect(page.locator("#synthetic-badge")).toBeVisible();
        await expect(page.locator("#synthetic-banner")).toBeVisible();
        // Exact2N request lifecycle events contain no session policy event: do not invent a consumer declaration.
        await expect(page.locator("#capture-badge")).toHaveText("text capture: unspecified");
        await expect(page.locator("#warnings .warning")).toHaveCount(0);
        await endAndPause(page);
        phase = "full paths";
        await assertPaths(page, full);
        await scrubTo(page, 500);
        await expect(page.locator("#cursor-label")).toContainText(`${REQUESTS}/${2 * REQUESTS} events`);
        await expect(page.locator("#follow-check")).not.toBeChecked();
        phase = "prefix paths";
        await assertPaths(page, prefix);
        await scrubTo(page, 500);
        await assertPaths(page, prefix);
        await endAndPause(page);
        phase = "returned full paths";
        await assertPaths(page, full);
        await endAndPause(page);
        await assertPaths(page, full);
        phase = "replacing recording";
        await page.locator("#file-input").setInputFiles(replacement);
        await expect(page.locator("#source-badge")).toContainText("metric-strip-two.ndjson");
        await expect(page.locator("#cursor-label")).toContainText("4/4 events");
        await expect(page.locator("#synthetic-badge")).toBeVisible();
        await expect(page.locator("#synthetic-banner")).toBeVisible();
        await expect(page.locator("#capture-badge")).toHaveText("text capture: unspecified");
        await endAndPause(page);
        await assertPaths(page, small);
        await expect(page.locator("#warnings .warning")).toHaveCount(0);
        expect(errors, "uncaught page errors across load, cursor changes and replacement").toEqual([]);
        phase = "complete";
        completed = true;
    } catch (error) {
        primaryFailed = true;
        primaryError = error;
    }
    let reportingFailed = false, reportingError: unknown;
    try {
        const evidence = JSON.stringify({ schema: "sonder.metric-strip-browser-evidence/1", synthetic: true, content_free: true, captured_content_fields: 0, capture_policy_in_consumer: "unspecified: no session metadata added", input_requests: REQUESTS, input_events: 2 * REQUESTS, fixture: input, replacement_fixture: smallInput, prefix_requests: REQUESTS / 2, replacement_requests: 2, full_expected_path_sha256: pathHashes(full), prefix_expected_path_sha256: pathHashes(prefix), replacement_expected_path_sha256: pathHashes(small), completed, phase, page_errors: errors, elapsed_ms: performance.now() - started, test_timeout_override: false, expect_timeout_override: false }) + "\n";
        if (Buffer.byteLength(evidence) > 65536) throw new Error("Metric-strip evidence exceeds64KiB");
        const output = testInfo.outputPath("metric-strip-measurement.json");
        writeFileSync(output, evidence, { flag: "wx", mode: 0o600 });
        await testInfo.attach("metric-strip-measurement", { path: output, contentType: "application/json" });
    } catch (error) {
        reportingFailed = true;
        reportingError = error;
    }
    // A reporting failure must not replace an original test-body failure, including a falsy thrown value.
    if (primaryFailed) throw primaryError;
    if (reportingFailed) throw reportingError;
});
