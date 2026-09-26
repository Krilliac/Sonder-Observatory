// Generates large, deterministic, seeded recordings for performance work.
//
// SYNTHETIC DATA: every event is produced by this script, not by Sonder
// Runtime or Sonder-Inference. The producer carries `synthetic: true`, so the
// UI labels these sessions as synthetic. Values are plausible shapes for
// exercising the viewer at scale, not measurements of a model.
//
// Large fixtures are never committed. The default output directory is
// artifacts/fixtures/, which .gitignore already excludes (/artifacts/).
//
// Usage:
//   node scripts/gen-large-fixture.mjs                       # 10k, 100k, 1m
//   node scripts/gen-large-fixture.mjs --sizes 100k --seed 7
//   node scripts/gen-large-fixture.mjs --sizes 1m --out /tmp/sobs
//
// The same (count, seed) always yields byte-identical output. Tests import
// generateEvents / generateNdjson directly instead of reading files.
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SEED = 20260926;
export const PRESET_SIZES = { "10k": 10_000, "100k": 100_000, "1m": 1_000_000 };

const MONO_BASE_NS = 1_000_000_000;
const WALL_BASE_MS = Date.parse("2026-09-26T08:00:00.000Z");
const TOTAL_VRAM = 24 * 1024 ** 3;
const MAX_OPEN_REQUESTS = 6;
const AGENTS = ["agt_owner", "agt_worker_1", "agt_worker_2", "agt_worker_3", "agt_critic", "agt_planner"];
const TOOLS = ["synthetic.search", "synthetic.fetch", "synthetic.read_file", "synthetic.exec"];

/** Mulberry32: tiny seeded PRNG (same as scripts/generate-fixture.mjs). */
export function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Parses "10k", "100k", "1m", "2500" into an event count. */
export function parseSize(text) {
    const key = String(text).trim().toLowerCase();
    if (key in PRESET_SIZES) {
        return PRESET_SIZES[key];
    }
    const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(key);
    if (!m) {
        throw new Error(`invalid size "${text}" (expected e.g. 10k, 100k, 1m, 2500)`);
    }
    const n = Number(m[1]) * (m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1);
    if (!Number.isInteger(n) || n < 2) {
        throw new Error(`size must be an integer >= 2, got "${text}"`);
    }
    return n;
}

/**
 * Yields exactly `count` schema-valid events in replay order (monotonic
 * mono_ns, contiguous sequence numbers). The first event is session.started
 * and the last is session.ended.
 */
export function* generateEvents(count, seed = DEFAULT_SEED) {
    if (!Number.isInteger(count) || count < 2) {
        throw new Error(`count must be an integer >= 2, got ${count}`);
    }
    const rand = rng(seed);
    const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const tag = `s${seed >>> 0}`;
    const session = `ses_large_${tag}`;
    const run = `run_large_${tag}`;
    const model = "mdl_synthetic_7b_q4";
    const producer = { name: "sonder-observatory-large-fixture", version: "0.1.0", node_id: "fixture-large", synthetic: true };
    const sampling = { level: "standard", sampled: true };

    let seq = 0;
    let ms = 0;
    let reqCounter = 0;
    let toolCounter = 0;
    const open = [];
    const pendingTools = [];

    const make = (eventType, fields, attributes) => {
        const s = seq;
        seq += 1;
        return {
            schema: "sonder.observatory.event/1",
            event_id: `evt_lg_${tag}_${String(s + 1).padStart(7, "0")}`,
            sequence: s,
            event_type: eventType,
            wall_time: new Date(WALL_BASE_MS + ms).toISOString(),
            mono_ns: MONO_BASE_NS + Math.round(ms * 1_000_000),
            session_id: session,
            run_id: fields.run_id ?? null,
            request_id: fields.request_id ?? null,
            agent_id: fields.agent_id ?? null,
            model_instance_id: fields.model_instance_id ?? null,
            device_id: fields.device_id ?? null,
            producer,
            sampling,
            attributes,
        };
    };

    yield make("session.started", {}, {
        synthetic: true,
        text_capture: "none",
        note: "Large synthetic fixture from scripts/gen-large-fixture.mjs; not model telemetry.",
        target_events: count,
        seed: seed >>> 0,
    });

    // Leave room for the closing session.ended event.
    while (seq < count - 1) {
        ms += 0.2 + rand() * 2.8;
        const roll = rand();
        if (roll < 0.05) {
            yield make("device.memory.sample", { device_id: "dev_gpu0" }, {
                used_bytes: Math.round(TOTAL_VRAM * (0.3 + 0.1 * open.length + rand() * 0.05)),
                total_bytes: TOTAL_VRAM,
                kind: "vram",
            });
        } else if (roll < 0.08) {
            yield make("device.compute.sample", { device_id: "dev_gpu0" }, {
                utilization: Math.round(Math.min(1, 0.1 + 0.15 * open.length + rand() * 0.1) * 100) / 100,
            });
        } else if (roll < 0.09) {
            const agent = pick(AGENTS);
            yield make(pick(["agent.started", "route.selected", "agent.completed"]), { run_id: run, agent_id: agent, model_instance_id: model }, { role: agent.slice(4) });
        } else if (roll < 0.1 && pendingTools.length > 0) {
            const tc = pendingTools.shift();
            const fail = rand() < 0.1;
            yield make(fail ? "tool.failed" : "tool.completed", tc.fields, { tool_call_id: tc.id, duration_ms: Math.round(ms - tc.ms), ...(fail ? { error: "synthetic timeout" } : { result: "[redacted]" }) });
        } else if (roll < 0.105) {
            yield make("kv.pressure", { device_id: "dev_gpu0" }, { occupancy: Math.round((0.85 + rand() * 0.14) * 100) / 100 });
        } else if (roll < 0.1055) {
            yield make("telemetry.dropped", { run_id: run }, { dropped_count: between(1, 5), reason: "synthetic producer queue full" });
        } else if (open.length < MAX_OPEN_REQUESTS && (open.length === 0 || roll > 0.97)) {
            reqCounter += 1;
            const req = {
                id: `req_${tag}_${String(reqCounter).padStart(6, "0")}`,
                agent: pick(AGENTS),
                stage: 0,
                tokens: between(16, 96),
                prompt: between(200, 2400),
                fail: rand() < 0.04,
                emitted: 0,
            };
            open.push(req);
            yield make("request.queued", { run_id: run, request_id: req.id, agent_id: req.agent, model_instance_id: model }, { prompt_tokens: req.prompt });
        } else if (open.length > 0) {
            const idx = Math.floor(rand() * open.length);
            const req = open[idx];
            const f = { run_id: run, request_id: req.id, agent_id: req.agent, model_instance_id: model, device_id: "dev_gpu0" };
            switch (req.stage) {
                case 0:
                    req.stage = 1;
                    yield make("request.started", f, { prompt_tokens: req.prompt });
                    break;
                case 1:
                    req.stage = 2;
                    yield make("inference.prefill.started", f, { prompt_tokens: req.prompt });
                    break;
                case 2:
                    req.stage = 3;
                    yield make("inference.prefill.completed", f, { prompt_tokens: req.prompt, prefill_ms: between(20, 300) });
                    break;
                case 3:
                    req.stage = 4;
                    yield make("inference.decode.started", f, {});
                    break;
                case 4:
                    if (req.emitted < req.tokens && !(req.fail && req.emitted > req.tokens / 2)) {
                        req.emitted += 1;
                        if (rand() < 0.01) {
                            toolCounter += 1;
                            const id = `tc_${tag}_${toolCounter}`;
                            pendingTools.push({ id, ms, fields: { run_id: run, request_id: req.id, agent_id: req.agent } });
                            yield make("tool.called", { run_id: run, request_id: req.id, agent_id: req.agent }, { tool_call_id: id, tool: pick(TOOLS), args: "[redacted]" });
                        } else {
                            yield make("inference.token.generated", f, { position: req.prompt + req.emitted, text_capture: "none", token_text: null });
                        }
                    } else {
                        req.stage = 5;
                        yield make("inference.decode.completed", f, { generated_tokens: req.emitted, stop: req.fail ? "error" : "eos" });
                    }
                    break;
                default:
                    open.splice(idx, 1);
                    yield make(req.fail ? "request.failed" : "request.completed", f, req.fail ? { error: "synthetic decode timeout", generated_tokens: req.emitted } : { generated_tokens: req.emitted });
                    break;
            }
        }
    }
    ms += 1;
    yield make("session.ended", {}, { reason: "fixture-complete", open_requests: open.length });
}

/** Whole recording as NDJSON text (one event per line, trailing newline). */
export function generateNdjson(count, seed = DEFAULT_SEED) {
    const parts = [];
    for (const event of generateEvents(count, seed)) {
        parts.push(JSON.stringify(event));
    }
    return parts.join("\n") + "\n";
}

/** Streams a fixture to disk in batches so 1M events never sit in one string. */
export async function writeFixture(path, count, seed = DEFAULT_SEED) {
    mkdirSync(dirname(path), { recursive: true });
    const out = createWriteStream(path, { encoding: "utf8" });
    let batch = [];
    let bytes = 0;
    for (const event of generateEvents(count, seed)) {
        batch.push(JSON.stringify(event));
        if (batch.length >= 5_000) {
            const chunk = batch.join("\n") + "\n";
            bytes += Buffer.byteLength(chunk);
            batch = [];
            if (!out.write(chunk)) {
                await new Promise((r) => out.once("drain", r));
            }
        }
    }
    if (batch.length > 0) {
        const chunk = batch.join("\n") + "\n";
        bytes += Buffer.byteLength(chunk);
        out.write(chunk);
    }
    await new Promise((r, j) => out.end((err) => (err ? j(err) : r())));
    return bytes;
}

function parseArgs(argv) {
    const opts = { sizes: ["10k", "100k", "1m"], seed: DEFAULT_SEED, out: null };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = () => {
            const v = argv[i + 1];
            if (v === undefined) {
                throw new Error(`${arg} needs a value`);
            }
            i += 1;
            return v;
        };
        if (arg === "--sizes") {
            opts.sizes = next().split(",").filter(Boolean);
        } else if (arg === "--seed") {
            opts.seed = Number(next());
            if (!Number.isInteger(opts.seed)) {
                throw new Error("--seed must be an integer");
            }
        } else if (arg === "--out") {
            opts.out = next();
        } else if (arg === "--help" || arg === "-h") {
            opts.help = true;
        } else {
            throw new Error(`unknown argument ${arg}`);
        }
    }
    return opts;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log("usage: node scripts/gen-large-fixture.mjs [--sizes 10k,100k,1m] [--seed N] [--out DIR]");
        return;
    }
    const here = dirname(fileURLToPath(import.meta.url));
    const outDir = opts.out ? resolve(process.cwd(), opts.out) : resolve(here, "..", "artifacts/fixtures");
    for (const size of opts.sizes) {
        const count = parseSize(size);
        const path = resolve(outDir, `large-${size.toLowerCase()}-seed${opts.seed}.ndjson`);
        const started = performance.now();
        const bytes = await writeFixture(path, count, opts.seed);
        const secs = ((performance.now() - started) / 1000).toFixed(1);
        console.log(`wrote ${count} synthetic events (${(bytes / 1024 ** 2).toFixed(1)} MiB) to ${path} in ${secs}s`);
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
