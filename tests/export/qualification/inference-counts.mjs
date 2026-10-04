/** Bounded, offline sensitivity-scan qualification; no provider/model benchmark. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import process from "node:process";
import console from "node:console";
import { createServer } from "vite";

const options = new Map(process.argv.slice(2).map((arg) => arg.split("=")));
for (const key of options.keys()) assert(["--events", "--rounds"].includes(key), `unknown option: ${key}`);
const eventLimit = Number(options.get("--events") ?? 100_000);
const rounds = Number(options.get("--rounds") ?? 5);
assert(Number.isSafeInteger(eventLimit) && eventLimit >= 1 && eventLimit <= 100_000, "events must be 1..100000");
assert(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 20, "rounds must be 1..20");
const server = await createServer({
    root: process.cwd(), logLevel: "silent", optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true }, appType: "custom",
});
try {
    const { assessExportSensitivity } = await server.ssrLoadModule("/src/export/sensitivity.ts");
    const sizes = [...new Set([Math.min(1_000, eventLimit), Math.min(10_000, eventLimit), eventLimit])];
    const cohorts = [];
    for (const size of sizes) {
        const events = Array.from({ length: size }, (_, index) => ({
            schema_version: "1.0", event_id: `synthetic-count:${index}`, mono_ns: index,
            wall_time: "2026-10-04T00:00:00Z", event_type: "request.queued",
            producer: { name: "sonder-inference", version: "qualification", node_id: "offline", role: "inference", synthetic: true },
            attributes: { kind: "chat", messages: index % 1025 },
        }));
        const last = events.at(-1);
        const originalAttributes = last.attributes;
        const originalProducer = last.producer;
        // Warm up separately; retain every timed cohort instead of claiming a speedup.
        assert.equal(assessExportSensitivity(events).sensitive, false);
        for (let round = 0; round < rounds; round++) {
            const started = performance.now();
            assert.equal(assessExportSensitivity(events).sensitive, false);
            const milliseconds = performance.now() - started;
            last.attributes = { kind: "chat", messages: [{ role: "user", content: "synthetic privacy canary" }] };
            assert.equal(assessExportSensitivity(events).fullText, true);
            last.attributes = originalAttributes;
            last.producer = { ...originalProducer, name: "unknown-producer" };
            assert.equal(assessExportSensitivity(events).fullText, true);
            last.producer = originalProducer;
            last.event_type = "tool.completed";
            last.attributes = { result: 1 };
            assert.equal(assessExportSensitivity(events).toolPayloadEvents, 1);
            last.event_type = "session.created";
            last.attributes = { text_capture: "on" };
            assert.equal(assessExportSensitivity(events, { toNs: -1 }).fullText, true);
            last.event_type = "request.queued";
            last.attributes = originalAttributes;
            assert.equal(assessExportSensitivity(events).sensitive, false);
            cohorts.push({ events: size, round, milliseconds, privacy_controls_passed: 4 });
        }
    }
    console.log(JSON.stringify({
        status: "passed", synthetic: true, workload: "offline structural export sensitivity scan",
        head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        source_dirty: !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
        node: process.version, event_limit: eventLimit, rounds, cohorts,
        provider_calls: 0, provider_or_model_quality_measured: false,
    }, null, 2));
} finally {
    await server.close();
}
