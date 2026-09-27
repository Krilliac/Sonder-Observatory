#!/usr/bin/env node
/**
 * Cross-repo ecosystem end-to-end proof (docs/integration/ecosystem-e2e.md).
 *
 * Builds Sonder-Inference offline (mock backend, no weights, no network),
 * starts `sonder-infer serve`, starts a Sonder Runtime bound to it with
 * isolated state and no Ollama, checks both producers (health, discovery,
 * ecosystem, doctor, real chat and A2A turns, producer conformance), runs
 * e2e/ecosystem.spec.ts in Playwright, lets the Flutter app parse the live
 * ecosystem payload, runs the negative controls, and tears everything down.
 *
 * Zero dependencies beyond this repository's own devDependencies. Linux and
 * macOS (POSIX process groups). Only loopback traffic: proxy variables are
 * removed from every child's environment.
 *
 * Usage: node scripts/ecosystem-e2e.mjs [--skip-build] [--keep-running] [--no-flutter]
 *        node scripts/ecosystem-e2e.mjs --stop        (stops a --keep-running stack)
 *
 * Env (see the doc for details): SONDER_INFERENCE_DIR, SONDER_RUNTIME_DIR,
 * SONDER_RUNTIME_PYTHON, E2E_WORKDIR, E2E_INFERENCE_PORT, E2E_RUNTIME_PORT,
 * E2E_RUNTIME_ALT_PORT, E2E_PORT, E2E_CHROMIUM_PATH, E2E_INFERENCE_BIN,
 * FLUTTER_BIN, E2E_RUNTIME_MIN_FREE_DISK_BYTES, E2E_GUARD_PATHS.
 *
 * Writes logs, the Playwright report, screenshots and summary.json to the
 * work dir and exits non-zero when any gate fails.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    closeSync,
    createWriteStream,
    existsSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OBS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `usage: node scripts/ecosystem-e2e.mjs [--skip-build] [--keep-running] [--no-flutter]
       node scripts/ecosystem-e2e.mjs --stop

  --skip-build    reuse the Inference build in $E2E_WORKDIR/inf (or $E2E_INFERENCE_BIN)
                  and the Observatory dist/ from an earlier run
  --keep-running  leave Inference and Runtime running after the checks (no teardown
                  gates); stop them later with --stop and the same E2E_WORKDIR
  --no-flutter    skip the Flutter parse of the live ecosystem payload
  --stop          stop a stack left by --keep-running in E2E_WORKDIR, then exit

See docs/integration/ecosystem-e2e.md.`;

// ---------------------------------------------------------------- options

const FLAGS = new Set(["--skip-build", "--keep-running", "--no-flutter", "--stop", "--help", "-h"]);
const argv = process.argv.slice(2);
for (const arg of argv) {
    if (!FLAGS.has(arg)) {
        console.error(`ecosystem-e2e: unknown argument ${arg}\n\n${USAGE}`);
        process.exit(2);
    }
}
if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
}
const opts = {
    skipBuild: argv.includes("--skip-build"),
    keepRunning: argv.includes("--keep-running"),
    noFlutter: argv.includes("--no-flutter"),
    stop: argv.includes("--stop"),
};

function envInt(name, fallback) {
    const raw = process.env[name]?.trim();
    if (!raw) {
        return fallback;
    }
    if (!/^\d+$/.test(raw)) {
        console.error(`ecosystem-e2e: ${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
        process.exit(2);
    }
    return Number(raw);
}

/** A sibling checkout of this repository, or the directory named by `envName`. */
function resolveRepo(envName, siblingNames, marker) {
    const explicit = process.env[envName]?.trim();
    const candidates = explicit ? [path.resolve(explicit)] : siblingNames.map((n) => path.resolve(OBS_DIR, "..", n));
    for (const dir of candidates) {
        if (existsSync(path.join(dir, marker))) {
            return dir;
        }
    }
    const tried = candidates.join(", ");
    console.error(
        `ecosystem-e2e: ${explicit ? `${envName}=${explicit} is not a checkout` : `no sibling checkout found (${tried})`}; ` +
            `set ${envName} to the repository directory`,
    );
    process.exit(2);
}

if (opts.stop && !process.env.E2E_WORKDIR?.trim()) {
    console.error("ecosystem-e2e: --stop needs E2E_WORKDIR (the work dir of the --keep-running run)");
    process.exit(2);
}
const WORKDIR = process.env.E2E_WORKDIR?.trim()
    ? path.resolve(process.env.E2E_WORKDIR.trim())
    : mkdtempSync(path.join(os.tmpdir(), "sonder-ecosystem-e2e-"));
const STACK_FILE = path.join(WORKDIR, "stack.json");

if (opts.stop) {
    await stopKeptStack();
    process.exit(0);
}

const INFERENCE_DIR = resolveRepo("SONDER_INFERENCE_DIR", ["sonder-inference", "Sonder-Inference", "Sonder-inference"], "CMakeLists.txt");
const RUNTIME_DIR = resolveRepo("SONDER_RUNTIME_DIR", ["Sonder-runtime", "sonder-runtime", "Sonder-Runtime"], "sonder_runtime");
const PYTHON =
    process.env.SONDER_RUNTIME_PYTHON?.trim() ||
    [".venv/bin/python", "venv/bin/python"].map((p) => path.join(RUNTIME_DIR, p)).find((p) => existsSync(p)) ||
    "python3";
const PORTS = {
    inference: envInt("E2E_INFERENCE_PORT", 18437),
    runtime: envInt("E2E_RUNTIME_PORT", 18435),
    runtimeAlt: envInt("E2E_RUNTIME_ALT_PORT", 18436),
    viewer: envInt("E2E_PORT", 4173),
};
const VIEWER_ORIGIN = `http://127.0.0.1:${PORTS.viewer}`;
const INFERENCE_URL = `http://127.0.0.1:${PORTS.inference}`;
const RUNTIME_URL = `http://127.0.0.1:${PORTS.runtime}`;
const RUNTIME_ALT_URL = `http://127.0.0.1:${PORTS.runtimeAlt}`;
const CLOSED_URL = "http://127.0.0.1:1";
const MIN_FREE_DISK = envInt("E2E_RUNTIME_MIN_FREE_DISK_BYTES", 512 * 1024 * 1024);
const FLUTTER = process.env.FLUTTER_BIN?.trim() || "flutter";
const CHROMIUM = process.env.E2E_CHROMIUM_PATH?.trim() || "";
const GUARD_PATHS = [path.join(os.homedir(), ".sonder"), ...(process.env.E2E_GUARD_PATHS ?? "").split(path.delimiter).filter((p) => p.trim() !== "")];
const RUN_ID = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + Math.random().toString(36).slice(2, 6);
const BIN = (name) => path.join(OBS_DIR, "node_modules", ".bin", name);

// ---------------------------------------------------------------- reporting

const startedAt = new Date();
const gates = [];
const artifacts = {};
const turns = {};
let aborting = false;

function log(message) {
    const t = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1).padStart(6);
    console.log(`[ecosystem-e2e ${t}s] ${message}`);
}

function gate(name, ok, detail = "", extra = {}) {
    gates.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 2000), ...extra });
    log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${String(detail).slice(0, 300)}` : ""}`);
    return Boolean(ok);
}

function skip(name, why) {
    gates.push({ name, ok: true, skipped: true, detail: why });
    log(`SKIP ${name} - ${why}`);
}

/** Runs one step; a thrown error becomes a failed gate named after the step. */
async function step(name, fn) {
    if (aborting) {
        skip(name, "an earlier required step failed");
        return undefined;
    }
    const t0 = Date.now();
    try {
        return await fn();
    } catch (error) {
        gate(name, false, error instanceof Error ? error.message : String(error), { ms: Date.now() - t0 });
        return undefined;
    }
}

/** Marks the run as unable to continue (later steps are skipped, teardown still runs). */
function requireOk(ok, why) {
    if (!ok) {
        aborting = true;
        log(`cannot continue: ${why}`);
    }
    return ok;
}

function artifact(name, file) {
    artifacts[name] = path.relative(WORKDIR, file) || ".";
}

// ---------------------------------------------------------------- processes

/** Child environment: no proxies (loopback only), no inherited SONDER_ or OLLAMA_ settings. */
function childEnv(extra = {}, { keepSonder = false } = {}) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (/^(https?_proxy|all_proxy|ftp_proxy)$/i.test(k)) {
            continue;
        }
        if (!keepSonder && /^(SONDER_|OLLAMA_)/.test(k)) {
            continue;
        }
        env[k] = v;
    }
    return { ...env, NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1", ...extra };
}

const procs = new Map();

/** Starts a long-lived child in its own process group, output appended to `logFile`. */
function startProcess(name, cmd, args, { cwd, env, logFile }) {
    const fd = openSync(logFile, "a");
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    const entry = { name, child, pid: child.pid, exit: null, logFile };
    child.on("exit", (code, signal) => {
        entry.exit = { code, signal };
    });
    child.on("error", (error) => {
        entry.exit = { code: null, signal: null, error: error.message };
    });
    procs.set(name, entry);
    log(`started ${name} (pid ${child.pid}): ${cmd} ${args.join(" ")}`);
    return entry;
}

function groupAlive(pgid) {
    try {
        process.kill(-pgid, 0);
        return true;
    } catch {
        return false;
    }
}

function signalGroup(pgid, signal) {
    try {
        process.kill(-pgid, signal);
    } catch {
        // already gone
    }
}

async function waitFor(check, { timeoutMs, intervalMs = 200, what }) {
    const deadline = Date.now() + timeoutMs;
    let last;
    for (;;) {
        try {
            last = await check();
            if (last) {
                return last;
            }
        } catch (error) {
            last = error;
        }
        if (Date.now() > deadline) {
            const why = last instanceof Error ? `: ${last.message}` : "";
            throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${why}`);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

/** Signals the group, waits for the leader, then clears any member left behind. */
async function stopProcess(name, { signal = "SIGINT", graceMs = 20_000 } = {}) {
    const entry = procs.get(name);
    if (!entry || entry.stopped) {
        return entry?.exit ?? null;
    }
    entry.stopped = true;
    if (!entry.exit) {
        signalGroup(entry.pid, signal);
        try {
            await waitFor(() => entry.exit, { timeoutMs: graceMs, what: `${name} to exit` });
        } catch {
            log(`${name} ignored ${signal} for ${graceMs} ms; sending SIGTERM`);
            signalGroup(entry.pid, "SIGTERM");
            try {
                await waitFor(() => entry.exit, { timeoutMs: 5_000, what: `${name} to exit` });
            } catch {
                signalGroup(entry.pid, "SIGKILL");
                await waitFor(() => entry.exit, { timeoutMs: 5_000, what: `${name} to exit` }).catch(() => undefined);
                entry.killed = true;
            }
        }
    }
    if (groupAlive(entry.pid)) {
        await new Promise((r) => setTimeout(r, 500));
        if (groupAlive(entry.pid)) {
            entry.orphans = true;
            signalGroup(entry.pid, "SIGKILL");
        }
    }
    log(`stopped ${name}: ${JSON.stringify(entry.exit)}`);
    return entry.exit;
}

/** Runs a command to completion; output goes to `logFile`. */
function runLogged(cmd, args, { cwd, env, logFile, timeoutMs = 600_000 }) {
    return new Promise((resolve) => {
        const fd = openSync(logFile, "a");
        const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
        closeSync(fd);
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            signalGroup(child.pid, "SIGKILL");
        }, timeoutMs);
        const entry = { name: `${path.basename(cmd)}#${child.pid}`, child, pid: child.pid, exit: null };
        procs.set(entry.name, entry);
        child.on("error", (error) => {
            clearTimeout(timer);
            entry.exit = { code: null, error: error.message };
            entry.stopped = true;
            resolve({ code: null, error: error.message, timedOut });
        });
        child.on("exit", (code, signal) => {
            clearTimeout(timer);
            entry.exit = { code, signal };
            entry.stopped = true;
            if (groupAlive(child.pid)) {
                signalGroup(child.pid, "SIGKILL");
            }
            resolve({ code, signal, timedOut });
        });
    });
}

function tail(file, lines = 25) {
    try {
        return readFileSync(file, "utf8").split("\n").slice(-lines).join("\n");
    } catch {
        return "";
    }
}

// ---------------------------------------------------------------- HTTP

async function httpJson(url, { method = "GET", body, headers = {}, timeoutMs = 15_000 } = {}) {
    const t0 = Date.now();
    const response = await fetch(url, {
        method,
        headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual",
    });
    const text = await response.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        // not JSON
    }
    return { status: response.status, headers: response.headers, text, json, ms: Date.now() - t0 };
}

async function portAnswers(port) {
    return new Promise((resolve) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1_000 }, (res) => {
            res.resume();
            resolve(true);
        });
        req.on("timeout", () => {
            req.destroy();
            resolve(true);
        });
        req.on("error", () => resolve(false));
    });
}

/** Records an NDJSON telemetry stream to `file` and keeps the parsed envelopes. */
function recordStream(name, url, file) {
    const out = createWriteStream(file);
    const state = { name, url, events: [], invalid: 0, ended: false, status: null, error: null, close: () => undefined };
    const req = http.get(url, { headers: { Accept: "application/x-ndjson", "Cache-Control": "no-store" } }, (res) => {
        state.status = res.statusCode;
        if (res.statusCode !== 200) {
            state.error = `HTTP ${res.statusCode}`;
            res.resume();
            return;
        }
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
            out.write(chunk);
            buffer += chunk;
            let i;
            while ((i = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, i).trim();
                buffer = buffer.slice(i + 1);
                if (line !== "") {
                    try {
                        state.events.push(JSON.parse(line));
                    } catch {
                        state.invalid += 1;
                    }
                }
            }
        });
        res.on("end", () => {
            state.ended = true;
            out.end();
        });
        res.on("error", (error) => {
            state.error = error.message;
        });
    });
    req.on("error", (error) => {
        state.error = state.error ?? error.message;
        state.ended = true;
        out.end();
    });
    state.close = () => {
        req.destroy();
        out.end();
    };
    artifact(`${name}_stream`, file);
    return state;
}

// ---------------------------------------------------------------- hygiene

function gitStatus(dir) {
    const r = spawnSync("git", ["-C", dir, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" });
    return r.status === 0 ? r.stdout : `git status failed: ${r.stderr}`;
}

function gitHead(dir) {
    const head = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const branch = spawnSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).stdout.trim();
    return { dir, head, branch };
}

/** Names, sizes and modification times under `root` (bounded walk), hashed. */
function fingerprint(root) {
    if (!existsSync(root)) {
        return "absent";
    }
    const hash = createHash("sha256");
    let count = 0;
    const walk = (dir, depth) => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        } catch {
            return;
        }
        for (const e of entries) {
            if (count >= 20_000) {
                return;
            }
            count += 1;
            const p = path.join(dir, e.name);
            try {
                const st = statSync(p);
                hash.update(`${path.relative(root, p)}\0${st.size}\0${st.mtimeMs}\n`);
            } catch {
                hash.update(`${path.relative(root, p)}\0gone\n`);
            }
            if (e.isDirectory() && depth < 8) {
                walk(p, depth + 1);
            }
        }
    };
    walk(root, 0);
    return `${count}:${hash.digest("hex").slice(0, 16)}`;
}

// ---------------------------------------------------------------- steps

function prepareWorkdir() {
    mkdirSync(WORKDIR, { recursive: true });
    if (existsSync(path.join(WORKDIR, "summary.json"))) {
        // Keep the earlier run's results; state and logs of this run start fresh.
        const previous = path.join(WORKDIR, `previous-run-${statSync(path.join(WORKDIR, "summary.json")).mtimeMs.toFixed(0)}`);
        mkdirSync(previous, { recursive: true });
        for (const name of readdirSync(WORKDIR)) {
            if (name === "inf" || name.startsWith("previous-run-")) {
                continue;
            }
            renameSync(path.join(WORKDIR, name), path.join(previous, name));
        }
        log(`moved the previous run's files to ${previous}`);
    }
}

async function buildInference() {
    const explicit = process.env.E2E_INFERENCE_BIN?.trim();
    if (explicit) {
        return path.resolve(explicit);
    }
    const buildDir = path.join(WORKDIR, "inf");
    const binary = path.join(buildDir, "sonder-infer");
    if (opts.skipBuild) {
        if (!existsSync(binary)) {
            throw new Error(`--skip-build: ${binary} does not exist (run once without --skip-build, or set E2E_INFERENCE_BIN)`);
        }
        return binary;
    }
    const logFile = path.join(WORKDIR, "inference-build.log");
    artifact("inference_build_log", logFile);
    const ninja = spawnSync("ninja", ["--version"], { encoding: "utf8" }).status === 0;
    // Tests off: FetchContent never runs, so the build needs no network; the mock backend needs no weights.
    const configure = await runLogged(
        "cmake",
        [
            "-S",
            INFERENCE_DIR,
            "-B",
            buildDir,
            ...(ninja ? ["-G", "Ninja"] : []),
            "-DCMAKE_BUILD_TYPE=Release",
            "-DSONDER_BUILD_TESTS=OFF",
            "-DSONDER_BUILD_CLI=ON",
            "-DSONDER_WITH_LLAMA_CPP=OFF",
            "-DSONDER_WITH_TLS=OFF",
        ],
        { cwd: INFERENCE_DIR, env: childEnv(), logFile, timeoutMs: 300_000 },
    );
    if (configure.code !== 0) {
        throw new Error(`cmake configure failed (exit ${configure.code}); see ${logFile}:\n${tail(logFile)}`);
    }
    const build = await runLogged("cmake", ["--build", buildDir, "--target", "sonder-infer", "--parallel"], {
        cwd: INFERENCE_DIR,
        env: childEnv(),
        logFile,
        timeoutMs: 900_000,
    });
    if (build.code !== 0) {
        throw new Error(`cmake build failed (exit ${build.code}); see ${logFile}:\n${tail(logFile)}`);
    }
    return binary;
}

async function buildObservatory() {
    const logFile = path.join(WORKDIR, "observatory-build.log");
    artifact("observatory_build_log", logFile);
    if (opts.skipBuild && existsSync(path.join(OBS_DIR, "dist", "index.html"))) {
        return;
    }
    const r = await runLogged("npm", ["run", "build"], { cwd: OBS_DIR, env: childEnv(), logFile, timeoutMs: 600_000 });
    if (r.code !== 0) {
        throw new Error(`npm run build failed (exit ${r.code}); see ${logFile}:\n${tail(logFile)}`);
    }
}

/** An isolated Runtime state: home, config and secrets files in the work dir, private modes. */
function runtimeState(label) {
    const home = path.join(WORKDIR, label);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    chmodSync(home, 0o700);
    const config = path.join(WORKDIR, `${label}.sonder.toml`);
    const secrets = path.join(WORKDIR, `${label}.sonder.env`);
    // The e2e state is a few megabytes; the default 5 GiB free-disk preflight would
    // refuse to start on a busy CI or container disk for no benefit here.
    writeFileSync(config, `[state]\nminimum_free_disk_bytes = ${MIN_FREE_DISK}\n`, { mode: 0o600 });
    writeFileSync(secrets, "", { mode: 0o600 });
    chmodSync(config, 0o600);
    chmodSync(secrets, 0o600);
    return {
        SONDER_HOME: home,
        SONDER_CONFIG: config,
        SONDER_SECRETS: secrets,
        SONDER_DB: path.join(home, "memory.db"),
        SONDER_FLEET_DB: path.join(home, "fleet.db"),
        SONDER_FLEET_PRINCIPAL_FILE: path.join(home, "fleet-principal.json"),
        SONDER_LIVE_RELOAD: "0",
        SONDER_ALLOW_CLOUD: "0",
        PYTHONUNBUFFERED: "1",
        PYTHONDONTWRITEBYTECODE: "1",
    };
}

function runtimeBinding(extra = {}) {
    return {
        SONDER_MODEL_BACKEND: "sonder-inference",
        SONDER_EMBEDDING_PROVIDER: "ollama",
        SONDER_INFERENCE_BASE_URL: INFERENCE_URL,
        SONDER_INFERENCE_MODEL: "mock:tiny",
        ...extra,
    };
}

async function migrate(label, state) {
    const logFile = path.join(WORKDIR, `${label}.migrate.log`);
    const r = await runLogged(PYTHON, ["-m", "sonder_runtime", "migrate", "--adopt-epoch2"], {
        cwd: RUNTIME_DIR,
        env: childEnv(state),
        logFile,
        timeoutMs: 120_000,
    });
    if (r.code !== 0) {
        throw new Error(`migrate --adopt-epoch2 (${label}) failed (exit ${r.code}):\n${tail(logFile)}`);
    }
}

async function startRuntime(name, port, env, logFile) {
    const entry = startProcess(name, PYTHON, ["-m", "sonder_runtime", "serve", "--skip-ollama", String(port)], {
        cwd: RUNTIME_DIR,
        env: childEnv(env),
        logFile,
    });
    await waitFor(
        async () => {
            if (entry.exit) {
                throw new Error(`${name} exited ${JSON.stringify(entry.exit)}:\n${tail(logFile)}`);
            }
            const r = await httpJson(`http://127.0.0.1:${port}/v1/models`, { timeoutMs: 3_000 }).catch(() => null);
            return r?.status === 200;
        },
        { timeoutMs: 180_000, intervalMs: 500, what: `${name} GET /v1/models 200` },
    );
    return entry;
}

/** Flattened Playwright JSON results: one entry per test with its final status and annotations. */
function playwrightTests(jsonFile) {
    if (!existsSync(jsonFile)) {
        return { stats: {}, tests: [] };
    }
    const report = JSON.parse(readFileSync(jsonFile, "utf8"));
    const tests = [];
    const visit = (suite) => {
        for (const spec of suite.specs ?? []) {
            for (const t of spec.tests ?? []) {
                tests.push({ title: spec.title, status: t.status, annotations: t.annotations ?? [] });
            }
        }
        for (const child of suite.suites ?? []) {
            visit(child);
        }
    };
    for (const suite of report.suites ?? []) {
        visit(suite);
    }
    return { stats: report.stats ?? {}, tests };
}

function eventsFor(stream, predicate) {
    return stream.events.filter(predicate);
}

async function chatTurn(baseUrl, timeoutMs = 120_000) {
    const r = await httpJson(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        body: { model: "sonder", messages: [{ role: "user", content: "e2e ping" }] },
        timeoutMs,
    });
    return { ...r, turnId: r.headers.get("x-sonder-correlation-id") ?? "" };
}

// ---------------------------------------------------------------- kept stacks

async function stopKeptStack() {
    if (!existsSync(STACK_FILE)) {
        console.error(`ecosystem-e2e: no ${STACK_FILE}; nothing to stop`);
        process.exit(1);
    }
    const stack = JSON.parse(readFileSync(STACK_FILE, "utf8"));
    for (const p of stack.processes ?? []) {
        if (!groupAlive(p.pgid)) {
            console.log(`${p.name} (pgid ${p.pgid}) is not running`);
            continue;
        }
        signalGroup(p.pgid, "SIGINT");
        const deadline = Date.now() + 30_000;
        while (groupAlive(p.pgid) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 200));
        }
        if (groupAlive(p.pgid)) {
            signalGroup(p.pgid, "SIGKILL");
        }
        console.log(`stopped ${p.name} (pgid ${p.pgid})`);
    }
    rmSync(STACK_FILE, { force: true });
}

// ---------------------------------------------------------------- main

async function main() {
    prepareWorkdir();
    log(`work dir ${WORKDIR}`);
    log(`inference ${INFERENCE_DIR}; runtime ${RUNTIME_DIR} (python ${PYTHON}); observatory ${OBS_DIR}`);
    const repos = { observatory: gitHead(OBS_DIR), inference: gitHead(INFERENCE_DIR), runtime: gitHead(RUNTIME_DIR) };
    const statusBefore = Object.fromEntries(Object.entries(repos).map(([k, r]) => [k, gitStatus(r.dir)]));
    const guardBefore = Object.fromEntries(GUARD_PATHS.map((p) => [p, fingerprint(p)]));
    const summaryBase = { repos, ports: PORTS, options: opts, workdir: WORKDIR, run_id: RUN_ID };

    // Ports must be free, and nothing may answer as Ollama (the controls rely on its absence).
    await step("ports.free", async () => {
        const busy = [];
        for (const [name, port] of Object.entries(PORTS)) {
            if (await portAnswers(port)) {
                busy.push(`${name}:${port}`);
            }
        }
        requireOk(gate("ports.free", busy.length === 0, busy.length ? `in use: ${busy.join(", ")}` : Object.values(PORTS).join(", ")), "ports busy");
        gate("ollama.absent", !(await portAnswers(11434)), "nothing answers on 127.0.0.1:11434");
    });

    // Step 1: builds.
    const inferBin = await step("inference.build", async () => {
        const t0 = Date.now();
        const bin = await buildInference();
        const v = spawnSync(bin, ["version", "--json"], { encoding: "utf8" });
        const version = JSON.parse(v.stdout);
        writeFileSync(path.join(WORKDIR, "inference-version.json"), v.stdout);
        gate("inference.build", v.status === 0 && version.api_version === 1, `api_version ${version.api_version}, commit ${version.commit}`, { ms: Date.now() - t0 });
        return bin;
    });
    requireOk(Boolean(inferBin), "no sonder-infer binary");
    await step("observatory.build", async () => {
        const t0 = Date.now();
        await buildObservatory();
        requireOk(gate("observatory.build", existsSync(path.join(OBS_DIR, "dist", "index.html")), "dist/index.html", { ms: Date.now() - t0 }), "no Observatory build");
    });

    // The viewer: vite preview of the production build on the pinned origin.
    await step("viewer.start", async () => {
        const logFile = path.join(WORKDIR, "viewer.log");
        artifact("viewer_log", logFile);
        startProcess("viewer", BIN("vite"), ["preview", "--host", "127.0.0.1", "--port", String(PORTS.viewer), "--strictPort"], {
            cwd: OBS_DIR,
            env: childEnv(),
            logFile,
        });
        await waitFor(async () => (await httpJson(`${VIEWER_ORIGIN}/`, { timeoutMs: 2_000 }).catch(() => null))?.status === 200, {
            timeoutMs: 60_000,
            what: "vite preview",
        });
        gate("viewer.start", true, VIEWER_ORIGIN);
    });

    // Step 2: Inference serve (mock, synthetic).
    let infStream = null;
    await step("inference.start", async () => {
        const logFile = path.join(WORKDIR, "inference.log");
        const readyFile = path.join(WORKDIR, "inf.ready.json");
        artifact("inference_log", logFile);
        const entry = startProcess(
            "inference",
            inferBin,
            [
                "serve",
                "--host",
                "127.0.0.1",
                "--port",
                String(PORTS.inference),
                "--backend",
                "mock",
                "--model",
                "mock:tiny",
                "--cors-origin",
                VIEWER_ORIGIN,
                "--telemetry-level",
                "standard",
                "--ready-file",
                readyFile,
            ],
            { cwd: WORKDIR, env: childEnv(), logFile },
        );
        await waitFor(
            () => {
                if (entry.exit) {
                    throw new Error(`sonder-infer exited ${JSON.stringify(entry.exit)}:\n${tail(logFile)}`);
                }
                return existsSync(readyFile);
            },
            { timeoutMs: 30_000, what: "the --ready-file" },
        );
        writeFileSync(path.join(WORKDIR, "inf.ready.copy.json"), readFileSync(readyFile));
        const health = await waitFor(
            async () => {
                const r = await httpJson(`${INFERENCE_URL}/v1/sonder/health`, { timeoutMs: 3_000 });
                return r.status === 200 && r.json?.status === "ready" ? r.json : null;
            },
            { timeoutMs: 60_000, what: "health 200 ready" },
        );
        writeFileSync(path.join(WORKDIR, "inference-health.json"), JSON.stringify(health, null, 2));
        requireOk(
            gate("inference.health", health.status === "ready" && health.synthetic === true && health.api_version === 1, `status ${health.status}, synthetic ${health.synthetic}`),
            "Inference not ready",
        );
        const discovery = (await httpJson(`${INFERENCE_URL}/.well-known/sonder-telemetry`)).json;
        writeFileSync(path.join(WORKDIR, "inference-discovery.json"), JSON.stringify(discovery, null, 2));
        gate(
            "inference.discovery",
            discovery?.producer?.name === "sonder-inference" && discovery?.producer?.role === "inference" && discovery?.producer?.synthetic === true,
            `producer ${JSON.stringify(discovery?.producer)}`,
        );
        const identity = (await httpJson(`${INFERENCE_URL}/v1/sonder/identity`)).json;
        writeFileSync(path.join(WORKDIR, "inference-identity.json"), JSON.stringify(identity, null, 2));
        gate(
            "inference.identity",
            identity?.backend_identity?.backend === "mock" && identity?.synthetic === true,
            `backend ${identity?.backend_identity?.backend}, synthetic ${identity?.synthetic}`,
        );
        infStream = recordStream("inference", `${INFERENCE_URL}/v1/telemetry/ndjson`, path.join(WORKDIR, "inference-stream.ndjson"));
    });

    // Step 3-6: Runtime with isolated state, bound to Inference, no Ollama.
    const mainState = runtimeState("home");
    const noOriginState = runtimeState("home-noorigin");
    const fallbackState = runtimeState("home-fallback");
    let rtStream = null;
    await step("runtime.migrate", async () => {
        await migrate("home", mainState);
        await migrate("home-noorigin", noOriginState);
        await migrate("home-fallback", fallbackState);
        gate("runtime.migrate", true, "migrate --adopt-epoch2 on three isolated homes");
    });
    await step("runtime.start", async () => {
        const logFile = path.join(WORKDIR, "runtime.log");
        artifact("runtime_log", logFile);
        const t0 = Date.now();
        await startRuntime("runtime", PORTS.runtime, { ...mainState, ...runtimeBinding({ SONDER_OBSERVATORY_ORIGINS: VIEWER_ORIGIN }) }, logFile);
        requireOk(gate("runtime.start", true, `${RUNTIME_URL} answered /v1/models 200`, { ms: Date.now() - t0 }), "Runtime not up");
        rtStream = recordStream("runtime", `${RUNTIME_URL}/v1/observability/events?format=ndjson`, path.join(WORKDIR, "runtime-stream.ndjson"));
        // Negative control 2 needs a Runtime that does not list the viewer's origin.
        const altLog = path.join(WORKDIR, "runtime-noorigin.log");
        artifact("runtime_noorigin_log", altLog);
        await startRuntime("runtime-noorigin", PORTS.runtimeAlt, { ...noOriginState, ...runtimeBinding() }, altLog);
        gate("runtime-noorigin.start", true, `${RUNTIME_ALT_URL} without SONDER_OBSERVATORY_ORIGINS or SONDER_CORS_ORIGINS`);
    });

    // Ecosystem document (contract section 9).
    await step("runtime.ecosystem", async () => {
        const r = await httpJson(`${RUNTIME_URL}/v1/sonder/ecosystem`);
        const file = path.join(WORKDIR, "ecosystem.json");
        writeFileSync(file, r.text);
        artifact("ecosystem", file);
        const eco = r.json ?? {};
        const status = eco.providers?.status?.sonder_inference ?? {};
        const obs = eco.observatory ?? {};
        const connect = obs.connect_urls ?? [];
        const problems = [];
        if (r.status !== 200) problems.push(`HTTP ${r.status}`);
        if (eco.schema !== "sonder.runtime.ecosystem/1") problems.push(`schema ${eco.schema}`);
        if (status.state !== "ready") problems.push(`sonder_inference state ${status.state}`);
        if (status.identity?.backend !== "mock") problems.push(`identity.backend ${status.identity?.backend}`);
        if (status.synthetic !== true) problems.push(`synthetic ${status.synthetic}`);
        if (!status.telemetry?.discovery_url || !status.telemetry?.sse_url || !status.telemetry?.ndjson_url) problems.push("telemetry URLs missing");
        if (obs.export_enabled !== true) problems.push("export_enabled is not true");
        for (const u of [RUNTIME_URL, INFERENCE_URL]) {
            if (!connect.includes(u)) problems.push(`connect_urls lacks ${u}`);
        }
        gate("runtime.ecosystem", problems.length === 0, problems.join("; ") || `sonder_inference ready (mock, synthetic); connect_urls ${connect.join(" ")}`);
    });

    await step("runtime.doctor", async () => {
        const logFile = path.join(WORKDIR, "doctor.log");
        const out = path.join(WORKDIR, "doctor.json");
        const r = spawnSync(PYTHON, ["-m", "sonder_runtime", "doctor", "--skip-ollama", "--json"], {
            cwd: RUNTIME_DIR,
            env: childEnv({ ...mainState, ...runtimeBinding() }),
            encoding: "utf8",
            timeout: 180_000,
        });
        writeFileSync(out, r.stdout ?? "");
        writeFileSync(logFile, r.stderr ?? "");
        artifact("doctor", out);
        const doc = JSON.parse(r.stdout);
        const check = (doc.checks ?? []).find((c) => c.name === "sonder_inference");
        const verdict = String(check?.status ?? "missing").toLowerCase();
        gate("runtime.doctor", verdict === "ok" || verdict === "warn", `sonder_inference ${verdict}: ${check?.detail ?? ""}`);
    });

    // Step 5 at the API level: both chat paths, Ollama absent, correlated across producers.
    await step("turns.api", async () => {
        const chat = await chatTurn(RUNTIME_URL);
        const content = chat.json?.choices?.[0]?.message?.content ?? "";
        turns.api_chat_turn_id = chat.turnId;
        writeFileSync(path.join(WORKDIR, "chat-response.json"), chat.text);
        gate("turn.chat", chat.status === 200 && content.trim() !== "" && /^[A-Za-z0-9._:-]{1,128}$/.test(chat.turnId), `HTTP ${chat.status} in ${chat.ms} ms, R=${chat.turnId}`);
        const messageId = `e2e-a2a-api-${RUN_ID}`;
        turns.api_a2a_message_id = messageId;
        const a2a = await httpJson(`${RUNTIME_URL}/a2a`, {
            method: "POST",
            body: { jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { messageId, role: "ROLE_USER", parts: [{ text: "e2e a2a ping" }] } } },
            timeoutMs: 120_000,
        });
        writeFileSync(path.join(WORKDIR, "a2a-response.json"), a2a.text);
        const task = a2a.json?.result?.task;
        gate(
            "turn.a2a",
            a2a.status === 200 && task?.status?.state === "TASK_STATE_COMPLETED" && (task?.artifacts?.[0]?.parts?.[0]?.text ?? "").trim() !== "",
            `HTTP ${a2a.status}, state ${task?.status?.state}, messageId ${messageId}`,
        );
        const R = chat.turnId;
        await waitFor(
            () => {
                const rt = eventsFor(rtStream, (e) => e.request_id === R).map((e) => e.event_type);
                const inf = eventsFor(infStream, (e) => e.run_id === R).map((e) => e.event_type);
                return rt.includes("request.completed") && inf.includes("request.completed");
            },
            { timeoutMs: 20_000, what: `both streams to carry turn ${R}` },
        ).catch(() => undefined);
        const rtEvents = eventsFor(rtStream, (e) => e.request_id === R);
        const route = rtEvents.find((e) => e.event_type === "route.selected");
        const infEvents = eventsFor(infStream, (e) => e.run_id === R);
        const queued = infEvents.find((e) => e.event_type === "request.queued");
        const problems = [];
        for (const t of ["request.started", "route.selected", "request.completed"]) {
            if (!rtEvents.some((e) => e.event_type === t)) problems.push(`runtime ${t} missing`);
        }
        if (route?.attributes?.provider !== "sonder_inference") problems.push(`route.selected provider ${route?.attributes?.provider}`);
        if (queued?.attributes?.kind !== "chat") problems.push(`inference request.queued kind ${queued?.attributes?.kind}`);
        if (queued?.attributes?.parent_request_id !== R) problems.push(`parent_request_id ${queued?.attributes?.parent_request_id}`);
        for (const t of ["request.started", "request.completed", "inference.token.generated"]) {
            if (!infEvents.some((e) => e.event_type === t)) problems.push(`inference ${t} missing`);
        }
        if (!infEvents.every((e) => e.producer?.synthetic === true)) problems.push("an inference event is not labelled synthetic");
        if (rtEvents.some((e) => e.producer?.synthetic === true)) problems.push("a runtime event is labelled synthetic");
        gate("turn.correlation", problems.length === 0, problems.join("; ") || `runtime ${rtEvents.length} events, inference ${infEvents.length} events under run_id ${R}`);
        // The A2A turn's terminal event may land just after its HTTP answer.
        await waitFor(
            () =>
                eventsFor(rtStream, (e) => e.request_id === messageId && e.event_type === "request.completed").length > 0 &&
                eventsFor(infStream, (e) => e.run_id === messageId && e.event_type === "request.completed").length > 0,
            { timeoutMs: 20_000, what: `both streams to carry A2A turn ${messageId}` },
        ).catch(() => undefined);
        const a2aRt = eventsFor(rtStream, (e) => e.request_id === messageId).map((e) => e.event_type);
        const a2aInf = eventsFor(infStream, (e) => e.run_id === messageId).map((e) => e.event_type);
        gate(
            "turn.a2a.correlation",
            a2aRt.includes("request.started") && a2aRt.includes("request.completed") && a2aInf.includes("request.queued") && a2aInf.includes("request.completed"),
            `runtime [${[...new Set(a2aRt)].join(", ")}], inference ${a2aInf.length} events`,
        );
    });

    // Step 4: producer conformance with Observatory's suite, against both real producers.
    await step("conformance", async () => {
        const logFile = path.join(WORKDIR, "conformance.log");
        const jsonFile = path.join(WORKDIR, "conformance.json");
        artifact("conformance_log", logFile);
        artifact("conformance_json", jsonFile);
        const r = await runLogged(BIN("vitest"), ["run", "tests/conformance", "--reporter=verbose", "--reporter=json", `--outputFile.json=${jsonFile}`], {
            cwd: OBS_DIR,
            env: childEnv({
                SONDER_CONFORMANCE_URLS: `${INFERENCE_URL},${RUNTIME_URL}`,
                SONDER_CONFORMANCE_ORIGIN: VIEWER_ORIGIN,
                SONDER_CONFORMANCE_DENIED_ORIGIN: "https://denied.example",
            }),
            logFile,
            timeoutMs: 300_000,
        });
        const report = existsSync(jsonFile) ? JSON.parse(readFileSync(jsonFile, "utf8")) : {};
        gate(
            "conformance",
            r.code === 0 && report.numPassedTests === 2 && report.numFailedTests === 0 && report.numPendingTests === 0,
            `exit ${r.code}; passed ${report.numPassedTests}, failed ${report.numFailedTests}, skipped ${report.numPendingTests}`,
        );
    });

    // Step 6: the Observatory in Playwright (and negative control 2 inside the same run).
    const playwrightEnv = (extra) =>
        childEnv({
            E2E_ECOSYSTEM: "1",
            E2E_BASE_URL: VIEWER_ORIGIN,
            E2E_RUNTIME_URL: RUNTIME_URL,
            E2E_INFERENCE_URL: INFERENCE_URL,
            ...(CHROMIUM ? { E2E_CHROMIUM_PATH: CHROMIUM } : {}),
            ...extra,
        });
    await step("playwright", async () => {
        const logFile = path.join(WORKDIR, "playwright.log");
        const jsonFile = path.join(WORKDIR, "playwright-results.json");
        const shots = path.join(WORKDIR, "screenshots");
        turns.ui_a2a_message_id = `e2e-a2a-1-${RUN_ID}`;
        artifact("playwright_log", logFile);
        artifact("playwright_report", path.join(WORKDIR, "playwright-report", "index.html"));
        artifact("screenshots", shots);
        artifact("recording", path.join(WORKDIR, "ecosystem.sobs"));
        const r = await runLogged(
            BIN("playwright"),
            ["test", "e2e/ecosystem.spec.ts", "--output", path.join(WORKDIR, "test-results"), "--reporter=list,html,json", "--retries=0"],
            {
                cwd: OBS_DIR,
                env: playwrightEnv({
                    E2E_RUNTIME_NO_ORIGIN_URL: RUNTIME_ALT_URL,
                    E2E_A2A_MESSAGE_ID: turns.ui_a2a_message_id,
                    E2E_SHOTS_DIR: shots,
                    E2E_RECORDING_PATH: path.join(WORKDIR, "ecosystem.sobs"),
                    PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(WORKDIR, "playwright-report"),
                    PLAYWRIGHT_HTML_OPEN: "never",
                    PLAYWRIGHT_JSON_OUTPUT_FILE: jsonFile,
                }),
                logFile,
                timeoutMs: 600_000,
            },
        );
        const { stats, tests } = playwrightTests(jsonFile);
        const main = tests.find((t) => t.title.startsWith("connected ecosystem"));
        const negative = tests.find((t) => t.title.startsWith("negative control"));
        turns.ui_chat_turn_id = main?.annotations.find((a) => a.type === "turn-id")?.description ?? null;
        gate(
            "playwright.ecosystem",
            r.code === 0 && main?.status === "expected" && stats.unexpected === 0 && stats.flaky === 0,
            `exit ${r.code}; connected-ecosystem test ${main?.status ?? "missing"}; expected ${stats.expected}, unexpected ${stats.unexpected}, skipped ${stats.skipped}` +
                (r.code === 0 ? "" : `\n${tail(logFile, 40)}`),
        );
        gate(
            "negative.runtime-without-origin",
            negative?.status === "expected",
            `test ${negative?.status ?? "missing"}: the runtime card must end failed with advice naming SONDER_OBSERVATORY_ORIGINS and SONDER_CORS_ORIGINS`,
        );
        const recording = path.join(WORKDIR, "ecosystem.sobs");
        if (existsSync(recording)) {
            const manifest = JSON.parse(readFileSync(recording, "utf8").split("\n")[0]);
            writeFileSync(path.join(WORKDIR, "recording-manifest.json"), JSON.stringify(manifest, null, 2));
        }
    });

    // Negative control 1: a closed Inference port must fail the spec on the inference card.
    await step("negative.closed-inference-port", async () => {
        const dir = path.join(WORKDIR, "negative-closed-port");
        mkdirSync(dir, { recursive: true });
        const logFile = path.join(dir, "playwright.log");
        const jsonFile = path.join(dir, "results.json");
        artifact("negative_closed_port_log", logFile);
        const r = await runLogged(
            BIN("playwright"),
            ["test", "e2e/ecosystem.spec.ts", "--grep", "connected ecosystem", "--output", path.join(dir, "test-results"), "--reporter=list,json", "--retries=0"],
            {
                cwd: OBS_DIR,
                env: playwrightEnv({
                    E2E_INFERENCE_URL: CLOSED_URL,
                    E2E_SHOTS_DIR: path.join(dir, "screenshots"),
                    PLAYWRIGHT_JSON_OUTPUT_FILE: jsonFile,
                }),
                logFile,
                timeoutMs: 300_000,
            },
        );
        const text = readFileSync(logFile, "utf8");
        const { tests } = playwrightTests(jsonFile);
        const failedOnCard = /sonder-inference producer at http:\/\/127\.0\.0\.1:1 never reached "live"/.test(text);
        gate(
            "negative.closed-inference-port",
            r.code !== 0 && tests.length === 1 && tests[0].status === "unexpected" && failedOnCard,
            `exit ${r.code}; test ${tests[0]?.status ?? "missing"}; failed on the inference card ${failedOnCard}`,
        );
    });

    // Step 7: the Flutter app parses the payload this Runtime really served.
    if (opts.noFlutter) {
        skip("flutter.ecosystem", "--no-flutter");
    } else {
        await step("flutter.ecosystem", async () => {
            const appDir = path.join(RUNTIME_DIR, "app");
            const logFile = path.join(WORKDIR, "flutter.log");
            artifact("flutter_log", logFile);
            const env = childEnv({ SONDER_ECOSYSTEM_JSON: path.join(WORKDIR, "ecosystem.json"), TZ: "UTC" });
            const pub = await runLogged(FLUTTER, ["--no-version-check", "--suppress-analytics", "pub", "get", "--offline"], {
                cwd: appDir,
                env,
                logFile,
                timeoutMs: 300_000,
            });
            if (pub.code !== 0) {
                throw new Error(`flutter pub get --offline failed (exit ${pub.code}${pub.error ? `, ${pub.error}` : ""}); set FLUTTER_BIN or pass --no-flutter:\n${tail(logFile)}`);
            }
            const r = await runLogged(FLUTTER, ["--no-version-check", "--suppress-analytics", "test", "test/ecosystem_status_test.dart", "--reporter", "expanded"], {
                cwd: appDir,
                env,
                logFile,
                timeoutMs: 600_000,
            });
            const text = readFileSync(logFile, "utf8");
            const ran = /parses a payload captured from a live runtime/.test(text) && !/parses a payload captured from a live runtime[^\n]*\(skipped\)/.test(text);
            gate("flutter.ecosystem", r.code === 0 && ran, `exit ${r.code}; live payload test ${ran ? "ran" : "did not run"}`);
        });
    }

    if (opts.keepRunning) {
        await stopProcess("runtime-noorigin");
        await stopProcess("viewer");
        infStream?.close();
        rtStream?.close();
        const kept = ["inference", "runtime"].map((name) => procs.get(name)).filter((p) => p && !p.exit);
        writeFileSync(
            STACK_FILE,
            JSON.stringify({ workdir: WORKDIR, processes: kept.map((p) => ({ name: p.name, pgid: p.pid, log: p.logFile })) }, null, 2),
        );
        for (const p of kept) {
            p.child.unref();
            p.kept = true;
        }
        skip("teardown", "--keep-running: stop the stack with `npm run test:ecosystem -- --stop` and the same E2E_WORKDIR");
        return finish(summaryBase, statusBefore, guardBefore);
    }

    await teardown();
    return finish(summaryBase, statusBefore, guardBefore);

    // Step 8 and negative controls 3 and 4.
    async function teardown() {
        aborting = false; // teardown gates always run
        await stopProcess("runtime-noorigin");
        await step("inference.sigint", async () => {
            if (!procs.get("inference")) {
                skip("inference.sigint", "Inference never started");
                return;
            }
            const exit = await stopProcess("inference", { signal: "SIGINT", graceMs: 15_000 });
            await waitFor(() => infStream?.ended, { timeoutMs: 5_000, what: "the Inference stream to close" }).catch(() => undefined);
            const last = infStream?.events.at(-1);
            gate("inference.sigint", exit?.code === 0, `exit ${JSON.stringify(exit)}`);
            gate(
                "inference.engine-stopped",
                Boolean(infStream?.ended) && (infStream?.events ?? []).some((e) => e.event_type === "engine.stopped"),
                `stream ended ${infStream?.ended}, last event ${last?.event_type}`,
            );
        });
        await step("negative.inference-down", async () => {
            if (!procs.get("runtime") || procs.get("runtime").exit) {
                skip("negative.inference-down", "Runtime not running");
                return;
            }
            const r = await chatTurn(RUNTIME_URL, 30_000);
            const message = r.json?.error?.message ?? r.text;
            await new Promise((res) => setTimeout(res, 500));
            const events = eventsFor(rtStream, (e) => e.request_id === r.turnId);
            const ollama = events.filter((e) => e.event_type.startsWith("route.") && JSON.stringify(e.attributes).includes('"ollama"'));
            const failed = events.find((e) => e.event_type === "request.failed");
            gate(
                "negative.inference-down",
                r.status === 503 && message.includes(INFERENCE_URL) && r.ms < 10_000 && ollama.length === 0 && failed?.attributes?.http_status === 503,
                `HTTP ${r.status} in ${r.ms} ms; names base URL ${message.includes(INFERENCE_URL)}; Ollama route events ${ollama.length}; request.failed ${Boolean(failed)}`,
            );
        });
        await step("runtime.stop", async () => {
            if (!procs.get("runtime")) {
                skip("runtime.stop", "Runtime never started");
                return;
            }
            const exit = await stopProcess("runtime", { signal: "SIGINT", graceMs: 30_000 });
            await waitFor(() => rtStream?.ended, { timeoutMs: 5_000, what: "the Runtime stream to close" }).catch(() => undefined);
            const entry = procs.get("runtime");
            gate("runtime.stop", Boolean(exit) && !entry.killed, `exit ${JSON.stringify(exit)}; session.ended ${(rtStream?.events ?? []).some((e) => e.event_type === "session.ended")}`);
        });
        await step("negative.fallback-fails-closed", async () => {
            if (!existsSync(path.join(fallbackState.SONDER_HOME, "memory.db"))) {
                skip("negative.fallback-fails-closed", "the fallback home was not migrated");
                return;
            }
            if (await portAnswers(PORTS.inference)) {
                throw new Error(`something still answers on ${INFERENCE_URL}; the control needs Inference down`);
            }
            const logFile = path.join(WORKDIR, "runtime-fallback.log");
            artifact("runtime_fallback_log", logFile);
            await startRuntime("runtime-fallback", PORTS.runtimeAlt, { ...fallbackState, ...runtimeBinding({ SONDER_INFERENCE_FALLBACK: "ollama" }) }, logFile);
            const stream = recordStream("runtime_fallback", `${RUNTIME_ALT_URL}/v1/observability/events?format=ndjson`, path.join(WORKDIR, "runtime-fallback-stream.ndjson"));
            await waitFor(() => stream.events.some((e) => e.event_type === "session.started"), { timeoutMs: 10_000, what: "the fallback runtime stream" });
            const r = await chatTurn(RUNTIME_ALT_URL, 30_000);
            await waitFor(() => eventsFor(stream, (e) => e.request_id === r.turnId && e.event_type.startsWith("request.") && e.event_type !== "request.started").length > 0, {
                timeoutMs: 10_000,
                what: "the fallback turn's terminal event",
            }).catch(() => undefined);
            const events = eventsFor(stream, (e) => e.request_id === r.turnId);
            const changed = events.find((e) => e.event_type === "route.changed");
            stream.close();
            await stopProcess("runtime-fallback", { signal: "SIGINT", graceMs: 30_000 });
            gate(
                "negative.fallback-fails-closed",
                r.status >= 500 &&
                    r.ms < 15_000 &&
                    changed?.attributes?.from_provider === "sonder_inference" &&
                    changed?.attributes?.to_provider === "ollama" &&
                    events.some((e) => e.event_type === "request.failed"),
                `HTTP ${r.status} in ${r.ms} ms; route.changed ${changed ? `${changed.attributes.from_provider} -> ${changed.attributes.to_provider} (${changed.attributes.reason_code})` : "missing"}; events [${events.map((e) => e.event_type).join(", ")}]`,
            );
        });
        await stopProcess("viewer");
    }
}

function finish(summaryBase, statusBefore, guardBefore) {
    // No child may outlive the run (except a --keep-running stack).
    const leftovers = [];
    for (const p of procs.values()) {
        if (p.kept) {
            continue;
        }
        if (groupAlive(p.pid)) {
            leftovers.push(`${p.name} (pgid ${p.pid})`);
            signalGroup(p.pid, "SIGKILL");
        }
        if (p.orphans) {
            leftovers.push(`${p.name} left group members behind`);
        }
    }
    if (!opts.keepRunning) {
        gate("processes.none-left", leftovers.length === 0, leftovers.join(", ") || `${procs.size} process groups stopped`);
    }
    const changed = [];
    for (const [name, before] of Object.entries(statusBefore)) {
        const after = gitStatus(summaryBase.repos[name].dir);
        if (after !== before) {
            changed.push(`${name}: ${after.trim().split("\n").slice(0, 5).join("; ") || "(clean now)"}`);
        }
    }
    gate("hygiene.git-status-unchanged", changed.length === 0, changed.join(" | ") || "git status unchanged in all three repos");
    const touched = GUARD_PATHS.filter((p) => fingerprint(p) !== guardBefore[p]);
    gate("hygiene.guarded-paths-untouched", touched.length === 0, touched.length ? `changed: ${touched.join(", ")}` : `unchanged: ${GUARD_PATHS.join(", ")}`);

    const finishedAt = new Date();
    const failed = gates.filter((g) => !g.ok);
    const summary = {
        schema: "sonder.ecosystem.e2e/1",
        ok: failed.length === 0,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_s: Math.round((finishedAt.getTime() - startedAt.getTime()) / 100) / 10,
        ...summaryBase,
        urls: { inference: INFERENCE_URL, runtime: RUNTIME_URL, runtime_alt: RUNTIME_ALT_URL, viewer: VIEWER_ORIGIN },
        turns,
        gates,
        failed: failed.map((g) => g.name),
        artifacts,
    };
    writeFileSync(path.join(WORKDIR, "summary.json"), JSON.stringify(summary, null, 2));
    log(`${summary.ok ? "PASSED" : `FAILED (${failed.map((g) => g.name).join(", ")})`} in ${summary.duration_s} s; summary ${path.join(WORKDIR, "summary.json")}`);
    if (opts.keepRunning) {
        log(`kept running: Inference ${INFERENCE_URL}, Runtime ${RUNTIME_URL}; stop with E2E_WORKDIR=${WORKDIR} npm run test:ecosystem -- --stop`);
    }
    return summary.ok ? 0 : 1;
}

let exiting = false;
async function emergencyStop(reason) {
    if (exiting) {
        return;
    }
    exiting = true;
    log(`stopping everything: ${reason}`);
    for (const p of procs.values()) {
        if (!p.kept) {
            signalGroup(p.pid, "SIGKILL");
        }
    }
}
for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => {
        await emergencyStop(sig);
        process.exit(130);
    });
}

try {
    const code = await main();
    process.exit(code);
} catch (error) {
    console.error(error);
    await emergencyStop("unexpected error");
    process.exit(1);
}
