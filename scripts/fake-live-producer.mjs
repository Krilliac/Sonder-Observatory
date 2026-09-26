// Dev/test-only fake live producer: serves a recorded or synthetic NDJSON
// event log over WebSocket, Server-Sent Events and plain NDJSON-over-HTTP
// from one loopback port, so src/ingest/live can be exercised without Sonder
// Runtime or Sonder-Inference. Events keep their `producer.synthetic` flag.
//
//   ws://HOST:PORT/ws       one NDJSON frame per batch
//   http://HOST:PORT/sse    text/event-stream, `id:` = event_id
//   http://HOST:PORT/ndjson application/x-ndjson, one event per line
//
// Resume: a client may send `Last-Event-ID` (HTTP) or `?last_event_id=` (any);
// the replay then starts after that event. Unknown ids replay from the start.
//
// Usage:
//   node scripts/fake-live-producer.mjs [--file fixtures/synthetic-session.ndjson]
//       [--host 127.0.0.1] [--port 8766] [--pace timeline|burst] [--speed 1]
//       [--batch 1] [--disconnect-after N] [--no-resume] [--loop]
//
// Also importable: `startFakeLiveProducer(options)` (see the .d.mts file).
// Binds to loopback by default (docs/SECURITY_PRIVACY.md).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURE = resolve(here, "..", "fixtures/synthetic-session.ndjson");

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

function variant(event, pass, spanNs) {
    if (pass === 0) {
        return event;
    }
    // Later loop passes become new sessions with unique ids and later clocks.
    return {
        ...event,
        event_id: `${event.event_id}_p${pass}`,
        session_id: `${event.session_id}_p${pass}`,
        run_id: event.run_id ? `${event.run_id}_p${pass}` : event.run_id,
        mono_ns: event.mono_ns + pass * (spanNs + 1_000_000_000),
        wall_time: new Date(Date.parse(event.wall_time) + pass * (spanNs / 1e6 + 1000)).toISOString(),
    };
}

/**
 * Starts the producer. Resolves once listening.
 * @param {import("./fake-live-producer.d.mts").FakeLiveProducerOptions} options
 * @returns {Promise<import("./fake-live-producer.d.mts").FakeLiveProducer>}
 */
export async function startFakeLiveProducer(options = {}) {
    const events = options.events ?? loadEvents(options.file);
    if (events.length === 0) {
        throw new Error("fake live producer: no events to serve");
    }
    const host = options.host ?? "127.0.0.1";
    const pace = options.pace ?? "burst";
    const speed = options.speed ?? 1;
    const batch = Math.max(1, options.batch ?? 1);
    const disconnectAfter = options.disconnectAfter ?? 0;
    const resume = options.resume !== false;
    const loop = options.loop === true;
    const retryMs = options.retryMs ?? 1000;
    const log = options.log ?? (() => undefined);
    if (!Number.isFinite(speed) || speed <= 0) {
        throw new Error("speed must be a positive number");
    }
    const spanNs = events[events.length - 1].mono_ns - events[0].mono_ns;
    const indexById = new Map(events.map((e, i) => [e.event_id, i]));
    const stats = { connections: 0, resumed: [], sent: 0, byTransport: { websocket: 0, sse: 0, ndjson: 0 } };
    const sockets = new Set();

    /** Where a (re)connecting client starts: after its last seen event. */
    function startIndex(lastId) {
        if (!resume || !lastId) {
            return 0;
        }
        const i = indexById.get(lastId);
        if (i === undefined) {
            return 0;
        }
        stats.resumed.push(lastId);
        return i + 1;
    }

    /**
     * Drives one replay. `write(lines, lastEvent)` returns false when the
     * transport wants the producer to wait for `drain`; `end()` hard-closes.
     */
    function replay(first, write, waitDrain, end) {
        let index = first;
        let pass = 0;
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
                    chunk.push(variant(events[index], pass, spanNs));
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

    const cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Last-Event-ID, Cache-Control",
        "Access-Control-Expose-Headers": "Content-Type",
    };

    const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://${host}`);
        if (req.method === "OPTIONS") {
            res.writeHead(204, cors);
            res.end();
            return;
        }
        const path = url.pathname;
        const kind = path === "/sse" ? "sse" : path === "/ndjson" ? "ndjson" : null;
        if (req.method !== "GET" || kind === null) {
            res.writeHead(404, { "Content-Type": "text/plain", ...cors });
            res.end("fake live producer: use /ws (WebSocket), /sse or /ndjson\n");
            return;
        }
        const header = req.headers["last-event-id"];
        const lastId = (Array.isArray(header) ? header[0] : header) || url.searchParams.get("last_event_id");
        stats.connections += 1;
        stats.byTransport[kind] += 1;
        res.writeHead(200, {
            "Content-Type": kind === "sse" ? "text/event-stream; charset=utf-8" : "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
            ...cors,
        });
        res.flushHeaders();
        if (kind === "sse") {
            res.write(`retry: ${retryMs}\n: fake live producer (synthetic data)\n\n`);
        }
        const heartbeat = kind === "sse" ? setInterval(() => res.write(": keepalive\n\n"), 15_000) : null;
        heartbeat?.unref?.();
        const stop = replay(
            startIndex(lastId),
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
            if (heartbeat) {
                clearInterval(heartbeat);
            }
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
        wss.handleUpgrade(req, socket, head, (ws) => {
            stats.connections += 1;
            stats.byTransport.websocket += 1;
            const stop = replay(
                startIndex(url.searchParams.get("last_event_id")),
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
    log(`fake live producer: ${events.length} events; ws://${base}/ws  http://${base}/sse  http://${base}/ndjson`);
    return {
        port,
        events,
        stats,
        urls: { websocket: `ws://${base}/ws`, sse: `http://${base}/sse`, ndjson: `http://${base}/ndjson` },
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
        log: (m) => console.log(m),
    }).catch((error) => {
        console.error(error.message);
        process.exit(2);
    });
}
