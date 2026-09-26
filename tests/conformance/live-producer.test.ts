/**
 * Live producer conformance suite (docs/TELEMETRY_PROTOCOL.md, "Live
 * producer protocol v1"). Runs only when SONDER_CONFORMANCE_URLS is set, and
 * is reported as skipped otherwise:
 *
 *   SONDER_CONFORMANCE_URLS=http://127.0.0.1:11437,http://127.0.0.1:11435 \
 *   SONDER_CONFORMANCE_ORIGIN=http://127.0.0.1:4173 \
 *   [SONDER_CONFORMANCE_TOKEN=...] npx vitest run tests/conformance
 *
 * Each URL is a producer base URL (or its discovery URL). The token, if any,
 * is sent as `Authorization: Bearer` and never printed.
 */
import { describe, expect, it } from "vitest";
import { checkProducer } from "./checks";

const urls = (process.env.SONDER_CONFORMANCE_URLS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u !== "");
const origin = process.env.SONDER_CONFORMANCE_ORIGIN?.trim() || "http://127.0.0.1:4173";
const token = process.env.SONDER_CONFORMANCE_TOKEN?.trim() || undefined;

describe.skipIf(urls.length === 0)("live producer conformance", () => {
    const targets = urls.length > 0 ? urls : ["(set SONDER_CONFORMANCE_URLS to run)"];
    for (const url of targets) {
        it(`${url} conforms to the live producer protocol v1`, async () => {
            const report = await checkProducer(url, { origin, token });
            expect(report.failures).toEqual([]);
            expect(report.discovery).not.toBeNull();
            expect(report.sse?.events.length ?? 0).toBeGreaterThan(0);
            expect(report.ndjson?.events.length ?? 0).toBeGreaterThan(0);
        }, 60_000);
    }
});
