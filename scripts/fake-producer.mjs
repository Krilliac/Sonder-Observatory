// Dev-only fake producer: replays a recorded/synthetic NDJSON event log over
// a loopback WebSocket so the live transport can be exercised without Sonder
// Runtime or Sonder-Inference. Events keep their `producer.synthetic` flag.
//
// Usage:
//   node scripts/fake-producer.mjs [--file fixtures/synthetic-session.ndjson]
//       [--host 127.0.0.1] [--port 8765] [--speed 1] [--loop]
//       [--cors-origin ORIGIN]... [--max-connections 32]
//
// Loopback only (docs/SECURITY_PRIVACY.md): this producer has no
// authentication (browsers cannot send headers on a WebSocket handshake), so
// a non-loopback --host is refused; use fake-live-producer.mjs with
// --token-file for a LAN listener. A browser page may connect only from the
// Observatory origins (the fake-live producer's DEFAULT_CORS_ORIGINS, plus
// each --cors-origin); clients that send no Origin (not a browser) are
// unaffected. At most --max-connections (default 32) replays run at once.
// Each connected client receives its own replay from the start of the file.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { DEFAULT_CORS_ORIGINS, DEFAULT_MAX_CONNECTIONS, isLoopbackHost } from "./fake-live-producer.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
const file = resolve(process.cwd(), option("file", resolve(here, "..", "fixtures/synthetic-session.ndjson")));
const host = option("host", "127.0.0.1");
const port = Number(option("port", "8765"));
const speed = Number(option("speed", "1"));
const loop = args.includes("--loop");
const origins = new Set([
    ...DEFAULT_CORS_ORIGINS,
    ...args.flatMap((a, i) => (a === "--cors-origin" && i + 1 < args.length ? [args[i + 1]] : [])),
]);
const maxConnections = Number(option("max-connections", String(DEFAULT_MAX_CONNECTIONS)));

if (!isLoopbackHost(host)) {
    console.error(`refusing to bind ${host}: this producer has no authentication and binds loopback only (use fake-live-producer.mjs --token-file for a LAN listener)`);
    process.exit(2);
}
if (!Number.isInteger(maxConnections) || maxConnections <= 0) {
    console.error("--max-connections must be a positive integer");
    process.exit(2);
}

if (!Number.isFinite(speed) || speed <= 0) {
    console.error("--speed must be a positive number");
    process.exit(2);
}

if (!existsSync(file) && file === resolve(here, "..", "fixtures/synthetic-session.ndjson")) {
    execFileSync(process.execPath, [resolve(here, "generate-fixture.mjs")], { stdio: "inherit" });
}

const events = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l))
    .filter((e) => e && typeof e === "object" && !("format" in e)) // skip .sobs manifest
    .sort((a, b) => a.mono_ns - b.mono_ns || a.sequence - b.sequence);

if (events.length === 0) {
    console.error(`no events in ${file}`);
    process.exit(2);
}
const spanNs = events[events.length - 1].mono_ns - events[0].mono_ns;

function variant(event, pass) {
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

const wss = new WebSocketServer({
    host,
    port,
    // A web page on another origin must not read the replay (cross-site WebSocket hijacking).
    verifyClient: ({ origin }, done) => {
        if (typeof origin === "string" && origin !== "" && !origins.has(origin)) {
            console.log(`refused a connection from origin ${origin}`);
            done(false, 403, "origin not allowed");
            return;
        }
        if (wss.clients.size >= maxConnections) {
            done(false, 503, "too many clients");
            return;
        }
        done(true);
    },
});
wss.on("listening", () => {
    console.log(`fake producer: ws://${host}:${port} replaying ${events.length} events from ${file} at ${speed}x${loop ? " (loop)" : ""}`);
});
wss.on("connection", (socket, request) => {
    console.log(`client connected from ${request.socket.remoteAddress}`);
    let index = 0;
    let pass = 0;
    let timer = null;
    const sendNext = () => {
        if (socket.readyState !== socket.OPEN) {
            return;
        }
        const batch = [];
        const current = events[index];
        // Send every event that shares this timestamp in one NDJSON frame.
        while (index < events.length && events[index].mono_ns === current.mono_ns) {
            batch.push(JSON.stringify(variant(events[index], pass)));
            index += 1;
        }
        socket.send(batch.join("\n"));
        if (index >= events.length) {
            if (!loop) {
                console.log("replay finished; keeping connection open");
                return;
            }
            index = 0;
            pass += 1;
            timer = setTimeout(sendNext, 1000 / speed);
            return;
        }
        const delayMs = (events[index].mono_ns - current.mono_ns) / 1e6 / speed;
        timer = setTimeout(sendNext, delayMs);
    };
    sendNext();
    socket.on("close", () => {
        if (timer) {
            clearTimeout(timer);
        }
        console.log("client disconnected");
    });
});
