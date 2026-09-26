// Dev/test-only fake live producer: serves a recorded or synthetic NDJSON
// event log over WebSocket, Server-Sent Events and plain NDJSON-over-HTTP
// from one loopback port, so src/ingest/live can be exercised without Sonder
// Runtime or Sonder-Inference. Everything it serves is labelled synthetic:
// every event carries `producer.synthetic: true` (added when the log lacks
// it) and the discovery document says `synthetic: true`.
//
//   GET /.well-known/sonder-telemetry  discovery (sonder.telemetry.producer/1)
//   ws://HOST:PORT/ws                  one NDJSON frame per batch
//   http://HOST:PORT/sse               text/event-stream, `id:` = event_id
//   http://HOST:PORT/ndjson            application/x-ndjson, one event per line
//
// Role modes (--role runtime|inference|fixture) relabel the events as that
// kind of producer, following the live producer protocol v1
// (docs/TELEMETRY_PROTOCOL.md): producer name, role and a fresh per-process
// instance_id (rt-<12 hex>, tel-<16 hex>, fx-<12 hex>); sequences are
// renumbered 0..n-1 in replay order and event_id = <instance_id>-<sequence>.
// Without --role the events keep their ids, sequences and producer names
// (existing tests rely on it); only `producer.synthetic: true` is added.
//
// Resume: `Last-Event-ID` wins over `?last_event_id=`. In role modes an id of
// this instance resumes after its sequence; an id of another instance (a
// "restarted" producer) or no id replays the whole retained log, and
// `?since=now` sends only new events (with --loop). Resuming after the last
// event sends nothing more unless --loop is set (then the next pass follows).
// Without --role, a known event id resumes after it and an unknown id
// replays from the start.
//
// Auth: with --token-file every route except the CORS preflight requires
// `Authorization: Bearer <token>` (401 otherwise). CORS follows the producer
// rules of the ecosystem contract: an exact-match origin allowlist (default:
// the Observatory dev, preview and Tauri origins; each --cors-origin adds
// one), an allowed Origin is echoed with `Vary: Origin`, a present but not
// allowed Origin gets 403 forbidden_origin, and requests without an Origin
// are unaffected. The preflight allows Accept, Authorization, Cache-Control,
// Content-Type and Last-Event-ID. SSE starts with `retry: 2000` (--retry-ms).
// Heartbeats: `: keepalive` (SSE) or a blank line (NDJSON) every
// --heartbeat-ms (default 15000).
//
// Usage:
//   node scripts/fake-live-producer.mjs [--file fixtures/synthetic-session.ndjson]
//       [--host 127.0.0.1] [--port 8766] [--pace timeline|burst] [--speed 1]
//       [--batch 64] [--disconnect-after N] [--no-resume] [--loop]
//       [--role runtime|inference|fixture] [--token-file PATH] [--heartbeat-ms N]
//       [--retry-ms N] [--cors-origin ORIGIN]...
//
// Also importable: `startFakeLiveProducer(options)` (see the .d.mts file).
// Binds to loopback by default (docs/SECURITY_PRIVACY.md).
import { execFileSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURE = resolve(here, "..", "fixtures/synthetic-session.ndjson");

export const DISCOVERY_PATH = "/.well-known/sonder-telemetry";

/** Default exact-match CORS allowlist (Observatory dev, preview and Tauri origins). */
export const DEFAULT_CORS_ORIGINS = Object.freeze([
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://127.0.0.1:4173",
    "http://localhost:4173",
    "tauri://localhost",
    "http://tauri.localhost",
]);

/** Relabelling per role mode. `name: null` keeps the fixture's producer name. */
export const ROLE_MODES = {
    runtime: { name: "sonder-runtime", prefix: "rt-", hexBytes: 6 },
    inference: { name: "sonder-inference", prefix: "tel-", hexBytes: 8 },
    fixture: { name: null, prefix: "fx-", hexBytes: 6 },
};

const MAX_TOKEN_BYTES = 4096;

/** Reads an NDJSON/.sobs file into events sorted in replay order. */
export function loadEvents(file = DEFAULT_FIXTURE) {
    if (!existsSync(file) && file === DEFAULT_FIXTURE) {
        execFileSync(process.execPath, [resolve(here, "generate-fixture.mjs")], { stdio: "ignore" });
    }
    return readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l))
        .filter((e) => e && typeof e === "object" && !("format" in e)) // skip .sobs manifest
        .sort((a, b) => a.mono_ns - b.mono_ns || a.sequence - b.sequence);
}

/** Reads a bearer token file: at most 4 KiB, trimmed, non-empty. */
export function readTokenFile(path) {
    const bytes = readFileSync(path);
    if (bytes.length > MAX_TOKEN_BYTES) {
        throw new Error("token file is larger than 4 KiB");
    }
    const token = bytes.toString("utf8").trim();
    if (token === "" || !/^[\x21-\x7e]+$/.test(token)) {
        throw new Error("token file must hold one printable ASCII token");
    }
    return token;
}

/** Adds `producer.synthetic: true` to an event served without a role (see header). */
function markSynthetic(event) {
    const producer = event?.producer;
    if (producer === null || typeof producer !== "object" || Array.isArray(producer) || producer.synthetic === true) {
        return event;
    }
    return { ...event, producer: { ...producer, synthetic: true } };
}

/** Relabels events as a producer of `role` with one instance id (see header). */
export function relabelForRole(events, role, instanceId) {
    const mode = ROLE_MODES[role];
    if (!mode) {
        throw new Error(`unknown role ${role} (expected runtime, inference or fixture)`);
    }
    return events.map((event, sequence) => ({
        ...event,
        event_id: `${instanceId}-${sequence}`,
        sequence,
        producer: {
            ...event.producer,
            name: mode.name ?? event.producer?.name ?? "sonder-observatory-fixture",
            role,
            instance_id: instanceId,
            synthetic: true,
        },
    }));
}

function splitEventId(id) {
    const at = id.lastIndexOf("-");
    if (at <= 0) {
        return null;
    }
    const seq = id.slice(at + 1);
    return /^\d+$/.test(seq) ? { instance: id.slice(0, at), sequence: Number(seq) } : null;
}

function sameToken(header, token) {
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
        return false;
    }
    const given = Buffer.from(header.slice(7));
    const expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Starts the producer. Resolves once listening.
 * @param {import("./fake-live-producer.d.mts").FakeLiveProducerOptions} options
 * @returns {Promise<import("./fake-live-producer.d.mts").FakeLiveProducer>}
 */
export async function startFakeLiveProducer(options = {}) {
    const loaded = options.events ?? loadEvents(options.file);
    if (loaded.length === 0) {
        throw new Error("fake live producer: no events to serve");
    }
    const role = options.role ?? null;
    if (role !== null && !ROLE_MODES[role]) {
        throw new Error(`unknown role ${role} (expected runtime, inference or fixture)`);
    }
    const instanceId =
        options.instanceId ??
        (role !== null
            ? `${ROLE_MODES[role].prefix}${randomBytes(ROLE_MODES[role].hexBytes).toString("hex")}`
            : typeof loaded[0].producer?.instance_id === "string" && loaded[0].producer.instance_id !== ""
              ? loaded[0].producer.instance_id
              : `fx-${randomBytes(6).toString("hex")}`);
    const events = role !== null ? relabelForRole(loaded, role, instanceId) : loaded.map(markSynthetic);
    const host = options.host ?? "127.0.0.1";
    const pace = options.pace ?? "burst";
    const speed = options.speed ?? 1;
    const batch = Math.max(1, options.batch ?? 1);
    const disconnectAfter = options.disconnectAfter ?? 0;
    const resume = options.resume !== false;
    const loop = options.loop === true;
    const retryMs = options.retryMs ?? 2000;
    const corsOrigins = new Set(options.corsOrigins ?? DEFAULT_CORS_ORIGINS);
    const heartbeatMs = options.heartbeatMs ?? 15_000;
    const token = options.token ?? (options.tokenFile ? readTokenFile(options.tokenFile) : null);
    const log = options.log ?? (() => undefined);
    if (!Number.isFinite(speed) || speed <= 0) {
        throw new Error("speed must be a positive number");
    }
    if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) {
        throw new Error("heartbeatMs must be a positive number");
    }
    const first = events[0];
    const producer = {
        name: first.producer?.name ?? "sonder-observatory-fixture",
        version: first.producer?.version ?? "0.0.0",
        node_id: first.producer?.node_id ?? hostname(),
        instance_id: instanceId,
        role: role ?? "fixture",
        synthetic: true,
    };
    const spanNs = events[events.length - 1].mono_ns - first.mono_ns;
    const indexById = new Map(events.map((e, i) => [e.event_id, i]));
    const stats = {
        connections: 0,
        resumed: [],
        sent: 0,
        byTransport: { websocket: 0, sse: 0, ndjson: 0 },
        discovery: 0,
        unauthorized: 0,
    };
    const sockets = new Set();

    function variant(event, pass) {
        if (pass === 0) {
            return event;
        }
        // Later loop passes become new sessions with later clocks. Role modes
        // keep one contiguous sequence per instance across passes.
        const shifted = {
            ...event,
            session_id: `${event.session_id}_p${pass}`,
            run_id: event.run_id ? `${event.run_id}_p${pass}` : event.run_id,
            mono_ns: event.mono_ns + pass * (spanNs + 1_000_000_000),
            wall_time: new Date(Date.parse(event.wall_time) + pass * (spanNs / 1e6 + 1000)).toISOString(),
        };
        if (role !== null) {
            const sequence = pass * events.length + event.sequence;
            return { ...shifted, sequence, event_id: `${instanceId}-${sequence}` };
        }
        return { ...shifted, event_id: `${event.event_id}_p${pass}` };
    }

    /** Where a (re)connecting client starts: { index, pass }. */
    function startPosition(lastId, sinceNow) {
        if (sinceNow) {
            return { index: events.length, pass: 0 };
        }
        if (!resume || !lastId) {
            return { index: 0, pass: 0 };
        }
        if (role !== null) {
            const parsed = splitEventId(lastId);
            if (!parsed || parsed.instance !== instanceId) {
                return { index: 0, pass: 0 }; // another instance: replay the whole window
            }
            stats.resumed.push(lastId);
            const next = parsed.sequence + 1;
            if (!loop) {
                // Nothing after the last event: stay live-only, never invent a second pass.
                return { index: Math.min(next, events.length), pass: 0 };
            }
            return { index: next % events.length, pass: Math.floor(next / events.length) };
        }
        const i = indexById.get(lastId);
        if (i === undefined) {
            return { index: 0, pass: 0 };
        }
        stats.resumed.push(lastId);
        return { index: i + 1, pass: 0 };
    }

    /**
     * Drives one replay. `write(lines, lastEvent)` returns false when the
     * transport wants the producer to wait for `drain`; `end()` hard-closes.
     */
    function replay(start, write, waitDrain, end) {
        let index = start.index;
        let pass = start.pass;
        let sentHere = 0;
        let timer = null;
        let stopped = false;
        const step = async () => {
            timer = null;
            while (!stopped) {
                if (index >= events.length) {
                    if (!loop) {
                        return; // finished; keep the connection open
                    }
                    index = 0;
                    pass += 1;
                }
                const chunk = [];
                const startMono = events[index].mono_ns;
                while (index < events.length && chunk.length < batch) {
                    if (pace === "timeline" && chunk.length > 0 && events[index].mono_ns !== startMono) {
                        break;
                    }
                    chunk.push(variant(events[index], pass));
                    index += 1;
                    if (disconnectAfter > 0 && sentHere + chunk.length >= disconnectAfter) {
                        break;
                    }
                }
                sentHere += chunk.length;
                stats.sent += chunk.length;
                const ok = write(chunk);
                if (disconnectAfter > 0 && sentHere >= disconnectAfter) {
                    stopped = true;
                    // Let the bytes flush before simulating a crash.
                    setTimeout(end, 5);
                    return;
                }
                if (!ok) {
                    await waitDrain();
                }
                if (pace === "timeline" && index < events.length) {
                    const delayMs = (events[index].mono_ns - startMono) / 1e6 / speed;
                    timer = setTimeout(step, delayMs);
                    return;
                }
                if (pace === "burst") {
                    // Yield so the event loop can service I/O between frames.
                    timer = setTimeout(step, 0);
                    return;
                }
            }
        };
        timer = setTimeout(step, 0);
        return () => {
            stopped = true;
            if (timer) {
                clearTimeout(timer);
            }
        };
    }

    /** CORS headers for an allowed or absent Origin; null for a refused one. */
    function corsHeaders(req) {
        const origin = req.headers.origin;
        if (typeof origin !== "string" || origin === "") {
            return { Vary: "Origin" };
        }
        if (!corsOrigins.has(origin)) {
            return null;
        }
        return {
            "Access-Control-Allow-Origin": origin,
            Vary: "Origin",
            "Access-Control-Expose-Headers": "Content-Type",
        };
    }

    function discoveryDocument() {
        return {
            schema: "sonder.telemetry.producer/1",
            producer,
            event_schema: "sonder.observatory.event/1",
            streams: [
                { transport: "sse", url: "/sse" },
                { transport: "ndjson", url: "/ndjson" },
                { transport: "websocket", url: "/ws" },
            ],
            resume: {
                header: "Last-Event-ID",
                query: "last_event_id",
                retained_events: events.length,
                oldest_sequence: role !== null ? 0 : first.sequence,
                next_sequence: role !== null ? events.length : events[events.length - 1].sequence + 1,
            },
            auth: { required: token !== null, schemes: ["bearer"] },
            clock: { mono_ns: "host-monotonic" },
            text_capture: "none",
            fake_producer: "synthetic data from scripts/fake-live-producer.mjs (dev/test only)",
        };
    }

    const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://${host}`);
        const cors = corsHeaders(req);
        if (cors === null) {
            res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin" });
            res.end(
                JSON.stringify({
                    error: { message: "origin not allowed", type: "invalid_request_error", code: "forbidden_origin", param: null },
                }) + "\n",
            );
            return;
        }
        if (req.method === "OPTIONS") {
            res.writeHead(204, {
                ...cors,
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "Accept, Authorization, Cache-Control, Content-Type, Last-Event-ID",
                "Access-Control-Max-Age": "600",
            });
            res.end();
            return;
        }
        if (token !== null && !sameToken(req.headers.authorization, token)) {
            stats.unauthorized += 1;
            res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors });
            res.end(
                JSON.stringify({
                    error: { message: "bearer token required", type: "authentication_error", code: "unauthorized", param: null },
                }) + "\n",
            );
            return;
        }
        const path = url.pathname;
        if (req.method === "GET" && path === DISCOVERY_PATH) {
            stats.discovery += 1;
            res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors });
            res.end(JSON.stringify(discoveryDocument()));
            return;
        }
        const kind = path === "/sse" ? "sse" : path === "/ndjson" ? "ndjson" : null;
        if (req.method !== "GET" || kind === null) {
            res.writeHead(404, { "Content-Type": "text/plain", ...cors });
            res.end(`fake live producer: use ${DISCOVERY_PATH}, /ws (WebSocket), /sse or /ndjson\n`);
            return;
        }
        const header = req.headers["last-event-id"];
        const lastId = (Array.isArray(header) ? header[0] : header) || url.searchParams.get("last_event_id");
        stats.connections += 1;
        stats.byTransport[kind] += 1;
        res.writeHead(200, {
            "Content-Type": kind === "sse" ? "text/event-stream; charset=utf-8" : "application/x-ndjson",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
            ...cors,
        });
        res.flushHeaders();
        if (kind === "sse") {
            res.write(`retry: ${retryMs}\n: fake live producer (synthetic data)\n\n`);
        }
        const heartbeat = setInterval(() => res.write(kind === "sse" ? ": keepalive\n\n" : "\n"), heartbeatMs);
        heartbeat.unref?.();
        const stop = replay(
            startPosition(lastId, url.searchParams.get("since") === "now"),
            (chunk) => {
                const text =
                    kind === "sse"
                        ? chunk.map((e) => `id: ${e.event_id}\ndata: ${JSON.stringify(e)}\n\n`).join("")
                        : chunk.map((e) => JSON.stringify(e)).join("\n") + "\n";
                return res.write(text);
            },
            () => new Promise((r) => res.once("drain", r)),
            () => res.destroy(),
        );
        const cleanup = () => {
            stop();
            clearInterval(heartbeat);
        };
        req.on("close", cleanup);
        res.on("close", cleanup);
    });

    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });

    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url ?? "/", `http://${host}`);
        if (url.pathname !== "/ws" && url.pathname !== "/") {
            socket.destroy();
            return;
        }
        if (corsHeaders(req) === null) {
            socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
            return;
        }
        if (token !== null && !sameToken(req.headers.authorization, token)) {
            stats.unauthorized += 1;
            socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            stats.connections += 1;
            stats.byTransport.websocket += 1;
            const stop = replay(
                startPosition(url.searchParams.get("last_event_id"), url.searchParams.get("since") === "now"),
                (chunk) => {
                    ws.send(chunk.map((e) => JSON.stringify(e)).join("\n"));
                    return true;
                },
                () => Promise.resolve(),
                () => ws.terminate(),
            );
            ws.on("close", stop);
        });
    });

    await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? 0, host, () => resolveListen());
    });
    const port = server.address().port;
    const base = `${host.includes(":") ? `[${host}]` : host}:${port}`;
    log(
        `fake live producer (synthetic data): ${events.length} events as ${producer.name} ` +
            `(role ${producer.role}, instance ${instanceId}${token !== null ? ", bearer token required" : ""}); ` +
            `http://${base}${DISCOVERY_PATH}  ws://${base}/ws  http://${base}/sse  http://${base}/ndjson`,
    );
    return {
        port,
        events,
        stats,
        instanceId,
        producer,
        urls: {
            base: `http://${base}`,
            discovery: `http://${base}${DISCOVERY_PATH}`,
            websocket: `ws://${base}/ws`,
            sse: `http://${base}/sse`,
            ndjson: `http://${base}/ndjson`,
        },
        /** Drops every open connection (simulates a producer crash/restart). */
        dropConnections() {
            for (const client of wss.clients) {
                client.terminate();
            }
            for (const socket of sockets) {
                socket.destroy();
            }
        },
        close() {
            for (const client of wss.clients) {
                client.terminate();
            }
            for (const socket of sockets) {
                socket.destroy();
            }
            wss.close();
            return new Promise((r) => server.close(() => r()));
        },
    };
}

// --- CLI ---------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const args = process.argv.slice(2);
    const option = (name, fallback) => {
        const i = args.indexOf(`--${name}`);
        return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
    };
    const file = option("file", undefined);
    const corsOrigins = args.flatMap((a, i) => (a === "--cors-origin" && i + 1 < args.length ? [args[i + 1]] : []));
    const tokenFile = option("token-file", undefined);
    startFakeLiveProducer({
        file: file ? resolve(process.cwd(), file) : undefined,
        host: option("host", "127.0.0.1"),
        port: Number(option("port", "8766")),
        pace: option("pace", "timeline"),
        speed: Number(option("speed", "1")),
        batch: Number(option("batch", "64")),
        disconnectAfter: Number(option("disconnect-after", "0")),
        resume: !args.includes("--no-resume"),
        loop: args.includes("--loop"),
        role: option("role", undefined),
        tokenFile: tokenFile ? resolve(process.cwd(), tokenFile) : undefined,
        heartbeatMs: Number(option("heartbeat-ms", "15000")),
        retryMs: Number(option("retry-ms", "2000")),
        corsOrigins: corsOrigins.length > 0 ? [...DEFAULT_CORS_ORIGINS, ...corsOrigins] : undefined,
        log: (m) => console.log(m),
    }).catch((error) => {
        console.error(error.message);
        process.exit(2);
    });
}
