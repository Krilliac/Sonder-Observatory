/**
 * The fake live producer's role modes, auth and CORS, and the conformance
 * checks (tests/conformance/checks.ts): they pass on the fake producer in
 * both roles, with and without a token, and fail on broken producers.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
    readTokenFile,
    startFakeLiveProducer,
    type FakeLiveProducer,
    type FakeLiveProducerOptions,
} from "../../../scripts/fake-live-producer.mjs";
import { LiveConnectionManager } from "../../../src/ingest/live/manager";
import { validateDiscovery } from "../../../src/protocol/discovery";
import { validateEvent } from "../../../src/protocol/validate";
import { SessionStore } from "../../../src/replay/session";
import { checkProducer } from "../../conformance/checks";

const ORIGIN = "http://127.0.0.1:4173";
const FAST = { minEvents: 12, maxStreamMs: 3000, idleMs: 300 };

const producers: FakeLiveProducer[] = [];
const servers: Server[] = [];
const dir = mkdtempSync(join(tmpdir(), "obs-conformance-"));

afterEach(async () => {
    await Promise.all(producers.splice(0).map((p) => p.close()));
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function producer(options: FakeLiveProducerOptions): Promise<FakeLiveProducer> {
    const p = await startFakeLiveProducer({ batch: 8, ...options });
    producers.push(p);
    return p;
}

describe("fake live producer role modes", () => {
    it.each(["inference", "runtime"] as const)("--role %s serves valid discovery and relabelled synthetic events", async (role) => {
        const p = await producer({ role });
        const doc = await (await fetch(p.urls.discovery)).json();
        expect(validateDiscovery(doc)).toEqual([]);
        expect(doc.producer).toMatchObject({
            name: role === "runtime" ? "sonder-runtime" : "sonder-inference",
            role,
            synthetic: true,
            instance_id: p.instanceId,
        });
        expect(p.instanceId).toMatch(role === "runtime" ? /^rt-[0-9a-f]{12}$/ : /^tel-[0-9a-f]{16}$/);
        p.events.forEach((e, i) => {
            expect(validateEvent(e).ok).toBe(true);
            expect(e).toMatchObject({ sequence: i, event_id: `${p.instanceId}-${i}` });
            expect(e.producer).toMatchObject({ role, instance_id: p.instanceId, synthetic: true });
        });
    });

    it("--token-file requires the bearer token on every route but the preflight", async () => {
        const file = join(dir, "token");
        writeFileSync(file, "  s3cret-token\n");
        expect(readTokenFile(file)).toBe("s3cret-token");
        const p = await producer({ role: "runtime", tokenFile: file });
        for (const url of [p.urls.discovery, p.urls.sse, p.urls.ndjson]) {
            const res = await fetch(url, { headers: { Origin: ORIGIN } });
            expect(res.status, url).toBe(401);
            // Readable cross-origin so the viewer can say a token is needed.
            expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
            expect((await res.json()).error.code).toBe("unauthorized");
        }
        expect((await fetch(p.urls.discovery, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
        const ok = await fetch(p.urls.discovery, { headers: { Authorization: "Bearer s3cret-token" } });
        expect(ok.status).toBe(200);
        expect((await ok.json()).auth).toEqual({ required: true, schemes: ["bearer"] });
        expect(p.stats.unauthorized).toBe(4);
    });

    it("answers the CORS preflight for the headers the viewer sends", async () => {
        const p = await producer({ role: "inference" });
        const res = await fetch(p.urls.sse, {
            method: "OPTIONS",
            headers: {
                Origin: ORIGIN,
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "accept, authorization, cache-control, last-event-id",
            },
        });
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
        const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
        for (const h of ["accept", "authorization", "cache-control", "last-event-id"]) {
            expect(allowed).toContain(h);
        }
    });

    it("uses an exact-match origin allowlist: 403 forbidden_origin for others, no Origin unaffected", async () => {
        const p = await producer({ role: "runtime" });
        for (const method of ["GET", "OPTIONS"]) {
            const res = await fetch(p.urls.discovery, { method, headers: { Origin: "https://evil.example" } });
            expect(res.status, method).toBe(403);
            expect(res.headers.get("access-control-allow-origin"), method).toBeNull();
            expect((await res.json()).error.code).toBe("forbidden_origin");
        }
        const plain = await fetch(p.urls.discovery);
        expect(plain.status).toBe(200);
        expect(plain.headers.get("access-control-allow-origin")).toBeNull();
        const allowed = await fetch(p.urls.discovery, { headers: { Origin: "tauri://localhost" } });
        expect(allowed.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
        expect(allowed.headers.get("vary")).toBe("Origin");
        const custom = await producer({ role: "runtime", corsOrigins: ["https://viewer.example"] });
        expect((await fetch(custom.urls.discovery, { headers: { Origin: ORIGIN } })).status).toBe(403);
        expect((await fetch(custom.urls.discovery, { headers: { Origin: "https://viewer.example" } })).status).toBe(200);
    });

    it("starts SSE with retry: 2000 and labels no-role events synthetic", async () => {
        const events = [0, 1].map((sequence) => ({
            schema: "sonder.observatory.event/1",
            event_id: `e-${sequence}`,
            sequence,
            event_type: "session.started",
            wall_time: "2026-09-26T08:00:00.000Z",
            mono_ns: 1000 + sequence,
            session_id: "s",
            producer: { name: "recorded", version: "0", node_id: "n" },
            attributes: {},
        }));
        const p = await producer({ events });
        expect(p.events.map((e) => (e.producer as { synthetic?: unknown }).synthetic)).toEqual([true, true]);
        expect(p.events.map((e) => e.event_id)).toEqual(["e-0", "e-1"]);
        const controller = new AbortController();
        const res = await fetch(p.urls.sse, { signal: controller.signal });
        const reader = res.body!.getReader();
        let text = "";
        while (!text.includes("data:")) {
            text += new TextDecoder().decode((await reader.read()).value);
        }
        controller.abort();
        expect(text.split("\n")[0]).toBe("retry: 2000");
        expect(text).toContain('"synthetic":true');
    });

    it("sends blank-line NDJSON heartbeats", async () => {
        const p = await producer({ role: "inference", events: [], heartbeatMs: 20 }).catch((e: Error) => e);
        expect(p).toBeInstanceOf(Error); // no events: refuses to start
        const q = await producer({ role: "inference", heartbeatMs: 20 });
        const controller = new AbortController();
        const res = await fetch(`${q.urls.ndjson}?since=now`, { signal: controller.signal });
        const reader = res.body!.getReader();
        const { value } = await reader.read();
        controller.abort();
        expect(new TextDecoder().decode(value)).toBe("\n");
    });

    it("resumes by instance: same instance continues, another instance replays the window", async () => {
        const p = await producer({ role: "inference" });
        const read = async (lastId: string) => {
            const controller = new AbortController();
            const res = await fetch(p.urls.ndjson, { headers: { "Last-Event-ID": lastId }, signal: controller.signal });
            const reader = res.body!.getReader();
            let text = "";
            while (!text.includes("\n")) {
                text += new TextDecoder().decode((await reader.read()).value);
            }
            controller.abort();
            return JSON.parse(text.split("\n")[0]!) as { sequence: number };
        };
        expect((await read(`${p.instanceId}-4`)).sequence).toBe(5);
        expect((await read("tel-00000000000000ff-4")).sequence).toBe(0);
    });

    it("sends nothing after the last event unless --loop is set", async () => {
        /** Reads what arrives within `ms` after resuming from `lastId`. */
        const readFor = async (url: string, lastId: string, ms: number) => {
            const controller = new AbortController();
            const res = await fetch(url, { headers: { "Last-Event-ID": lastId }, signal: controller.signal });
            const reader = res.body!.getReader();
            let text = "";
            const timer = setTimeout(() => controller.abort(), ms);
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) {
                        break;
                    }
                    text += new TextDecoder().decode(value);
                }
            } catch {
                // aborted after `ms`
            } finally {
                clearTimeout(timer);
            }
            return text
                .split("\n")
                .filter((l) => l.trim() !== "")
                .map((l) => JSON.parse(l) as { sequence: number; event_id: string; session_id: string });
        };
        const p = await producer({ role: "inference" });
        const last = p.events.length - 1;
        expect(await readFor(p.urls.ndjson, `${p.instanceId}-${last}`, 300)).toEqual([]);
        expect(await readFor(p.urls.ndjson, `${p.instanceId}-${last + 50}`, 300)).toEqual([]);
        expect(p.stats.sent).toBe(0);

        const looping = await producer({ role: "inference", loop: true });
        const next = await readFor(looping.urls.ndjson, `${looping.instanceId}-${last}`, 300);
        expect(next.length).toBeGreaterThan(0);
        expect(next[0]).toMatchObject({ sequence: last + 1, event_id: `${looping.instanceId}-${last + 1}` });
        expect(next[0]!.session_id).toMatch(/_p1$/);
    });

    it("feeds the connection manager from its base URL with a token", async () => {
        const file = join(dir, "token2");
        writeFileSync(file, "tok-2");
        const p = await producer({ role: "runtime", tokenFile: file });
        const store = new SessionStore();
        const manager = new LiveConnectionManager(store);
        const conn = await manager.add({ url: p.urls.base, token: "tok-2" });
        expect(conn.identity).toMatchObject({ name: "sonder-runtime", role: "runtime", instance_id: p.instanceId });
        expect(conn.streamUrl).toBe(p.urls.sse);
        const deadline = Date.now() + 5000;
        while (store.events.length < p.events.length && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 10));
        }
        expect(store.events).toHaveLength(p.events.length);
        expect(store.gaps).toEqual([]);
        await manager.disconnectAll();
    });
});

describe("conformance checks", () => {
    it.each([
        ["inference", false],
        ["runtime", false],
        ["inference", true],
        ["runtime", true],
    ] as const)("pass against the fake producer (--role %s, token %s)", async (role, withToken) => {
        let tokenFile: string | undefined;
        if (withToken) {
            tokenFile = join(dir, `token-${role}`);
            writeFileSync(tokenFile, "conformance-token");
        }
        const p = await producer({ role, tokenFile });
        const report = await checkProducer(p.urls.base, {
            origin: ORIGIN,
            token: withToken ? "conformance-token" : undefined,
            ...FAST,
        });
        expect(report.failures).toEqual([]);
        expect(report.sse!.events.length).toBeGreaterThanOrEqual(FAST.minEvents);
        expect(report.ndjson!.events.length).toBeGreaterThanOrEqual(FAST.minEvents);
        if (withToken) {
            const anonymous = await checkProducer(p.urls.base, { origin: ORIGIN, ...FAST });
            expect(anonymous.failures.join("\n")).toMatch(/HTTP 401/);
        }
    }, 30_000);

    interface BadOptions {
        eventName?: boolean;
        idMismatch?: boolean;
        gap?: boolean;
        gapNotice?: boolean;
        /** Answer CORS with `*` instead of echoing the origin. */
        wildcard?: boolean;
        /** First SSE line. Default "retry: 2000". */
        retryLine?: string;
    }

    /** A minimal producer whose SSE stream can be broken in one way. */
    async function badProducer(opts: BadOptions): Promise<string> {
        const instance = "bad-0001";
        const sequences = opts.gap ? [0, 1, 3, 4] : [0, 1, 2, 3];
        const events = sequences.map((sequence) => ({
            schema: "sonder.observatory.event/1",
            event_id: `${instance}-${sequence}`,
            sequence,
            event_type: "session.started",
            wall_time: "2026-09-26T08:00:00.000Z",
            mono_ns: 1000 + sequence,
            session_id: "s",
            producer: { name: "bad", version: "0", node_id: "n", instance_id: instance, role: "fixture", synthetic: true },
            attributes: {},
        }));
        const cors: Record<string, string> = opts.wildcard
            ? { "Access-Control-Allow-Origin": "*" }
            : { "Access-Control-Allow-Origin": ORIGIN, Vary: "Origin" };
        const server = createServer((req, res) => {
            const path = new URL(req.url ?? "/", "http://x").pathname;
            if (req.method === "OPTIONS") {
                res.writeHead(204, {
                    ...cors,
                    "Access-Control-Allow-Methods": "GET",
                    "Access-Control-Allow-Headers": "Accept, Authorization, Cache-Control, Last-Event-ID",
                });
                res.end();
            } else if (path === "/.well-known/sonder-telemetry") {
                res.writeHead(200, { ...cors, "Content-Type": "application/json" });
                res.end(
                    JSON.stringify({
                        schema: "sonder.telemetry.producer/1",
                        producer: events[0]!.producer,
                        event_schema: "sonder.observatory.event/1",
                        streams: [
                            { transport: "sse", url: "/sse" },
                            { transport: "ndjson", url: "/ndjson" },
                        ],
                        resume: { header: "Last-Event-ID", query: "last_event_id", retained_events: 4, oldest_sequence: 0, next_sequence: 5 },
                        auth: { required: false, schemes: ["bearer"] },
                        clock: { mono_ns: "host-monotonic" },
                    }),
                );
            } else if (path === "/sse") {
                const last = req.headers["last-event-id"];
                const from = typeof last === "string" ? Number(last.split("-").pop()) + 1 : 0;
                res.writeHead(200, { ...cors, "Content-Type": "text/event-stream" });
                res.write(`${opts.retryLine ?? "retry: 2000"}\n\n`);
                for (const e of events.filter((x) => x.sequence >= from)) {
                    if (opts.gapNotice && e.sequence === 3) {
                        res.write(": resume-gap 2-2\n\n");
                    }
                    const id = opts.idMismatch && e.sequence === 1 ? "other-1" : e.event_id;
                    res.write(`${opts.eventName ? "event: telemetry\n" : ""}id: ${id}\ndata: ${JSON.stringify(e)}\n\n`);
                }
            } else if (path === "/ndjson") {
                res.writeHead(200, { ...cors, "Content-Type": "application/x-ndjson" });
                res.write(events.map((e) => JSON.stringify(e)).join("\n") + "\n");
            } else {
                res.writeHead(404);
                res.end();
            }
        });
        servers.push(server);
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        const address = server.address();
        return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    }

    const options = { origin: ORIGIN, minEvents: 4, maxStreamMs: 1500, idleMs: 200 };

    it("pass against a minimal conforming producer", async () => {
        expect((await checkProducer(await badProducer({}), options)).failures).toEqual([]);
    });

    it("fail on a wildcard Access-Control-Allow-Origin", async () => {
        const report = await checkProducer(await badProducer({ wildcard: true }), options);
        expect(report.failures.join("\n")).toMatch(/discovery: Access-Control-Allow-Origin is "\*", expected exactly/);
        expect(report.failures.join("\n")).toMatch(/Vary does not include Origin/);
    });

    it("fail on a retry hint other than retry: 2000", async () => {
        const report = await checkProducer(await badProducer({ retryLine: "retry: 1000" }), options);
        expect(report.failures.join("\n")).toMatch(/sse: the first line is "retry: 1000", expected "retry: 2000"/);
    });

    it("check that a disallowed origin is refused when asked to", async () => {
        const p = await producer({ role: "inference" });
        const denied = await checkProducer(p.urls.base, { ...options, minEvents: 12, deniedOrigin: "https://denied.example" });
        expect(denied.failures).toEqual([]);
        const permissive = await checkProducer(await badProducer({}), { ...options, deniedOrigin: "https://denied.example" });
        expect(permissive.failures.join("\n")).toMatch(/disallowed Origin https:\/\/denied.example returned HTTP 200, expected 403/);
    });

    it("fail on an SSE event: name", async () => {
        const report = await checkProducer(await badProducer({ eventName: true }), options);
        expect(report.failures.join("\n")).toMatch(/custom event name "event: telemetry"/);
    });

    it("fail on an id that differs from event_id", async () => {
        const report = await checkProducer(await badProducer({ idMismatch: true }), options);
        expect(report.failures.join("\n")).toMatch(/id "other-1" differs from event_id bad-0001-1/);
    });

    it("fail on a non-contiguous sequence without a resume gap, and accept one with it", async () => {
        const broken = await checkProducer(await badProducer({ gap: true }), options);
        expect(broken.failures.join("\n")).toMatch(/sse: sequence 3 follows 1 without a resume-gap/);
        const noticed = await checkProducer(await badProducer({ gap: true, gapNotice: true }), options);
        expect(noticed.failures.filter((f) => f.startsWith("sse:"))).toEqual([]);
    });
});
