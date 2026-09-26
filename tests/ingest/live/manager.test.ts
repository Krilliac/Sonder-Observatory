/**
 * LiveConnectionManager / probeProducer with a fake fetch and a fake
 * WebSocket: discovery, transport choice, multi-producer merge, token
 * handling and the endpoint security policy.
 */
import { afterEach, describe, expect, it } from "vitest";
import { classifyProducerUrl, selectStream } from "../../../src/ingest/live/discovery";
import {
    LOCAL_PRESETS,
    LiveConnectionManager,
    probeProducer,
    type ProducerConnection,
} from "../../../src/ingest/live/manager";
import { producerState } from "../../../src/ingest/live/status";
import type { ProducerDiscovery } from "../../../src/protocol/discovery";
import type { ObservatoryEvent } from "../../../src/protocol/events";
import { SessionStore } from "../../../src/replay/session";
import type { WebSocketLike } from "../../../src/transport/live";

interface Call {
    url: string;
    headers: Record<string, string>;
}

function event(instance: string, name: string, role: string, seq: number, extra: Partial<ObservatoryEvent> = {}): ObservatoryEvent {
    return {
        schema: "sonder.observatory.event/1",
        event_id: `${instance}-${seq}`,
        sequence: seq,
        event_type: "request.started",
        wall_time: "2026-09-26T08:00:00.000Z",
        mono_ns: 1_000_000 + seq * 1000 + (role === "runtime" ? 1 : 0),
        session_id: `ses-${instance}`,
        request_id: `req-${seq}`,
        producer: { name, version: "1.0.0", node_id: "host", instance_id: instance, role, synthetic: true },
        attributes: {},
        ...extra,
    };
}

function discoveryDoc(name: string, role: "runtime" | "inference" | "fixture", instance: string, streams?: ProducerDiscovery["streams"]): ProducerDiscovery {
    return {
        schema: "sonder.telemetry.producer/1",
        producer: { name, version: "1.0.0", node_id: "host", instance_id: instance, role, synthetic: true },
        event_schema: "sonder.observatory.event/1",
        streams: streams ?? [
            { transport: "sse", url: "/events/sse" },
            { transport: "ndjson", url: "/events/ndjson" },
            { transport: "websocket", url: "/ws" },
        ],
        resume: { header: "Last-Event-ID", query: "last_event_id", retained_events: 2, oldest_sequence: 0, next_sequence: 2 },
        auth: { required: false, schemes: ["bearer"] },
        clock: { mono_ns: "host-monotonic" },
    };
}

type Route = (call: Call, signal: AbortSignal | undefined) => Response | Promise<Response>;

/** Streaming body that stays open until the request is aborted. */
function openStream(text: string, contentType: string, signal: AbortSignal | undefined): Response {
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            signal?.addEventListener("abort", () => {
                try {
                    controller.error(new DOMException("aborted", "AbortError"));
                } catch {
                    // already closed
                }
            });
        },
    });
    return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

function sse(events: ObservatoryEvent[]): string {
    return "retry: 2000\n\n" + events.map((e) => `id: ${e.event_id}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function fakeFetch(routes: Record<string, Route>) {
    const calls: Call[] = [];
    const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
        const headers = { ...(init?.headers as Record<string, string> | undefined) };
        const call = { url: input, headers };
        calls.push(call);
        const route = routes[input];
        if (!route) {
            throw new TypeError("Failed to fetch");
        }
        return route(call, init?.signal ?? undefined);
    };
    return { fetch, calls };
}

class FakeSocket implements WebSocketLike {
    readyState = 0;
    onopen: WebSocketLike["onopen"] = null;
    onclose: WebSocketLike["onclose"] = null;
    onerror: WebSocketLike["onerror"] = null;
    onmessage: WebSocketLike["onmessage"] = null;
    constructor(readonly url: string) {}
    close(): void {
        this.readyState = 3;
    }
}

const managers: LiveConnectionManager[] = [];

afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.disconnectAll()));
});

function manager(store: SessionStore, opts: ConstructorParameters<typeof LiveConnectionManager>[1] = {}): LiveConnectionManager {
    const m = new LiveConnectionManager(store, opts);
    managers.push(m);
    return m;
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await new Promise((r) => setTimeout(r, 5));
    }
}

const INF = "http://127.0.0.1:11437";
const RT = "http://127.0.0.1:11435";
const infEvents = [event("tel-aaaa", "sonder-inference", "inference", 0), event("tel-aaaa", "sonder-inference", "inference", 1)];
const rtEvents = [event("rt-bbbb", "sonder-runtime", "runtime", 0), event("rt-bbbb", "sonder-runtime", "runtime", 1)];

function inferenceRoutes(): Record<string, Route> {
    return {
        [`${INF}/.well-known/sonder-telemetry`]: () => Response.json(discoveryDoc("sonder-inference", "inference", "tel-aaaa")),
        [`${INF}/events/sse`]: (_c, signal) => openStream(sse(infEvents), "text/event-stream; charset=utf-8", signal),
        [`${INF}/events/ndjson`]: (_c, signal) =>
            openStream(infEvents.map((e) => JSON.stringify(e)).join("\n") + "\n\n", "application/x-ndjson", signal),
    };
}

function runtimeRoutes(): Record<string, Route> {
    return {
        [`${RT}/.well-known/sonder-telemetry`]: () =>
            Response.json(
                discoveryDoc("sonder-runtime", "runtime", "rt-bbbb", [
                    { transport: "sse", url: `${RT}/v1/observability/events` },
                    { transport: "ndjson", url: "/v1/observability/events?format=ndjson" },
                ]),
            ),
        [`${RT}/v1/observability/events`]: (_c, signal) => openStream(sse(rtEvents), "text/event-stream", signal),
    };
}

describe("LiveConnectionManager", () => {
    it("resolves a base URL through discovery to the SSE stream", async () => {
        const { fetch, calls } = fakeFetch(inferenceRoutes());
        const store = new SessionStore();
        const m = manager(store, { fetch });
        const conn = await m.add({ url: INF, label: "inference" });
        expect(conn.streamUrl).toBe(`${INF}/events/sse`);
        expect(conn.discovery?.producer.name).toBe("sonder-inference");
        expect(conn.identity).toEqual({
            name: "sonder-inference",
            version: "1.0.0",
            node_id: "host",
            instance_id: "tel-aaaa",
            role: "inference",
            synthetic: true,
        });
        await waitFor(() => store.events.length === 2, "inference events");
        expect(calls.map((c) => c.url)).toEqual([`${INF}/.well-known/sonder-telemetry`, `${INF}/events/sse`]);
        const [live] = m.list();
        expect(live!.status.state).toBe("open");
        expect(live!.status.transport).toBe("sse");
        expect(producerState(live!.status)).toBe("live");
        expect(store.source).toBe("live");
    });

    it("also accepts an explicit discovery URL", async () => {
        const { fetch } = fakeFetch(inferenceRoutes());
        const m = manager(new SessionStore(), { fetch });
        const conn = await m.add({ url: `${INF}/.well-known/sonder-telemetry` });
        expect(conn.streamUrl).toBe(`${INF}/events/sse`);
    });

    it("opens a direct stream URL without discovery", async () => {
        const { fetch, calls } = fakeFetch(inferenceRoutes());
        const store = new SessionStore();
        const m = manager(store, { fetch });
        const conn = await m.add({ url: `${INF}/events/sse` });
        expect(conn.discovery).toBeNull();
        await waitFor(() => store.events.length === 2, "events");
        expect(calls.map((c) => c.url)).toEqual([`${INF}/events/sse`]);
        // Identity comes from the events of a direct stream.
        expect(m.list()[0]!.identity).toMatchObject({ name: "sonder-inference", instance_id: "tel-aaaa", role: "inference" });
    });

    it("honours a forced transport from discovery", async () => {
        const { fetch } = fakeFetch(inferenceRoutes());
        const store = new SessionStore();
        const m = manager(store, { fetch });
        const conn = await m.add({ url: INF, transport: "ndjson" });
        expect(conn.streamUrl).toBe(`${INF}/events/ndjson`);
        await waitFor(() => store.events.length === 2, "ndjson events");
        expect(m.list()[0]!.status.transport).toBe("ndjson");

        const sockets: FakeSocket[] = [];
        const ws = manager(new SessionStore(), {
            fetch,
            webSocketFactory: (url) => {
                const s = new FakeSocket(url);
                sockets.push(s);
                return s;
            },
        });
        const wsConn = await ws.add({ url: INF, transport: "websocket" });
        expect(wsConn.streamUrl).toBe("ws://127.0.0.1:11437/ws");
        expect(sockets.map((s) => s.url)).toEqual(["ws://127.0.0.1:11437/ws"]);
    });

    it("merges two producers into one store with a single reset", async () => {
        const { fetch } = fakeFetch({ ...inferenceRoutes(), ...runtimeRoutes() });
        const store = new SessionStore();
        store.reset("fixture", "synthetic fixture");
        let resets = 0;
        const reset = store.reset.bind(store);
        store.reset = (...args: Parameters<SessionStore["reset"]>) => {
            resets += 1;
            reset(...args);
        };
        let appends = 0;
        const m = manager(store, { fetch, onAppend: () => (appends += 1) });
        const changes: (readonly ProducerConnection[])[] = [];
        m.subscribe((c) => changes.push(c));
        await m.add({ url: RT });
        await m.add({ url: INF });
        await waitFor(() => store.events.length === 4, "events from both producers");
        expect(resets).toBe(1);
        expect(store.source).toBe("live");
        expect(appends).toBeGreaterThanOrEqual(2);
        expect(new Set(store.events.map((e) => e.producer.name))).toEqual(new Set(["sonder-runtime", "sonder-inference"]));
        expect(store.gaps).toEqual([]);
        expect(store.sourceLabel).toBe(`${RT}/v1/observability/events + ${INF}/events/sse`);
        expect(m.list().map((c) => c.identity?.role)).toEqual(["runtime", "inference"]);
        expect(changes.length).toBeGreaterThan(2);
    });

    it("remove() stops a producer and keeps its events", async () => {
        const { fetch } = fakeFetch({ ...inferenceRoutes(), ...runtimeRoutes() });
        const store = new SessionStore();
        const m = manager(store, { fetch });
        const rt = await m.add({ url: RT });
        await m.add({ url: INF });
        await waitFor(() => store.events.length === 4, "events");
        await m.remove(rt.id);
        expect(m.list().map((c) => c.identity?.name)).toEqual(["sonder-inference"]);
        expect(store.events).toHaveLength(4);
        await m.disconnectAll();
        expect(m.list()).toEqual([]);
        expect(store.events).toHaveLength(4);
    });

    it("turns a failed discovery into a failed connection with a readable error", async () => {
        const { fetch } = fakeFetch({
            [`${RT}/.well-known/sonder-telemetry`]: () => new Response("not found", { status: 404 }),
        });
        const m = manager(new SessionStore(), { fetch });
        const unreachable = await m.add({ url: "http://127.0.0.1:1" });
        expect(unreachable.status.state).toBe("failed");
        expect(unreachable.status.lastError).toMatch(/could not reach/);
        expect(unreachable.status.lastError).toMatch(/SONDER_OBSERVATORY_ORIGINS/);
        expect(unreachable.status.lastError).toMatch(/--cors-origin/);
        const missing = await m.add({ url: RT });
        expect(missing.status.state).toBe("failed");
        expect(missing.status.lastError).toMatch(/HTTP 404/);
        expect(producerState(missing.status)).toBe("failed");

        const invalid = fakeFetch({
            [`${RT}/.well-known/sonder-telemetry`]: () =>
                Response.json({ ...discoveryDoc("sonder-runtime", "runtime", "rt-1"), schema: "sonder.telemetry.producer/2" }),
        });
        const m2 = manager(new SessionStore(), { fetch: invalid.fetch });
        const refused = await m2.add({ url: RT });
        expect(refused.status.lastError).toMatch(/unsupported discovery schema major/);
        expect(refused.status.lastError).toMatch(/stream URL directly/);
    });

    it("sends Authorization on HTTP requests only when a token is given", async () => {
        const withToken = fakeFetch(inferenceRoutes());
        const store = new SessionStore();
        const m = manager(store, { fetch: withToken.fetch });
        const conn = await m.add({ url: INF, token: " secret-token \n" });
        await waitFor(() => store.events.length === 2, "events");
        expect(conn.hasToken).toBe(true);
        expect(withToken.calls.map((c) => c.headers.Authorization)).toEqual(["Bearer secret-token", "Bearer secret-token"]);
        // The token is never exposed through the connection snapshot.
        expect(JSON.stringify(m.list())).not.toContain("secret-token");

        const without = fakeFetch(inferenceRoutes());
        const m2 = manager(new SessionStore(), { fetch: without.fetch });
        const plain = await m2.add({ url: INF });
        expect(plain.hasToken).toBe(false);
        await waitFor(() => without.calls.length === 2, "stream request");
        expect(without.calls.every((c) => !("Authorization" in c.headers))).toBe(true);
    });

    it("refuses a token with a WebSocket stream", async () => {
        const sockets: string[] = [];
        const { fetch } = fakeFetch({
            [`${INF}/.well-known/sonder-telemetry`]: () =>
                Response.json(discoveryDoc("sonder-inference", "inference", "tel-1", [{ transport: "websocket", url: "/ws" }])),
        });
        const m = manager(new SessionStore(), {
            fetch,
            webSocketFactory: (url) => {
                sockets.push(url);
                return new FakeSocket(url);
            },
        });
        const direct = await m.add({ url: "ws://127.0.0.1:8765", token: "t0k3n" });
        expect(direct.status.state).toBe("failed");
        expect(direct.status.lastError).toMatch(/cannot be sent over WebSocket/);
        const discovered = await m.add({ url: INF, token: "t0k3n" });
        expect(discovered.status.state).toBe("failed");
        expect(discovered.status.lastError).toMatch(/websocket stream cannot carry a bearer token/);
        expect(sockets).toEqual([]);
    });

    it("refuses plain http:// and ws:// to non-loopback hosts", async () => {
        const { fetch, calls } = fakeFetch({});
        const sockets: string[] = [];
        const m = manager(new SessionStore(), {
            fetch,
            webSocketFactory: (url) => {
                sockets.push(url);
                return new FakeSocket(url);
            },
        });
        for (const url of ["http://192.168.1.20:11435", "ws://10.0.0.5:8765/ws", "http://example.com/events"]) {
            const conn = await m.add({ url });
            expect(conn.status.state, url).toBe("failed");
            expect(conn.status.lastError, url).toMatch(/only allowed to a loopback host/);
        }
        expect(calls).toEqual([]);
        expect(sockets).toEqual([]);
    });

    it("refuses credentials and token/access_token query parameters", async () => {
        const { fetch, calls } = fakeFetch({});
        const m = manager(new SessionStore(), { fetch });
        const creds = await m.add({ url: "https://user:pass@node.example/" });
        expect(creds.status.lastError).toMatch(/credentials in the URL/);
        for (const url of ["http://127.0.0.1:11435/?token=abc", "https://node.example/sse?Access_Token=abc"]) {
            const conn = await m.add({ url });
            expect(conn.status.state).toBe("failed");
            expect(conn.status.lastError).toMatch(/tokens never go in URLs/);
        }
        expect(calls).toEqual([]);
    });

    it("refuses a discovered stream on another origin when a token is given", () => {
        const doc = discoveryDoc("sonder-runtime", "runtime", "rt-1", [
            { transport: "sse", url: "https://other.example/events" },
        ]);
        expect(selectStream(doc, "https://node.example/.well-known/sonder-telemetry", { hasToken: true }).message).toMatch(
            /another origin/,
        );
        expect(selectStream(doc, "https://node.example/.well-known/sonder-telemetry").url).toBe("https://other.example/events");
    });
});

describe("probeProducer", () => {
    it("reports the stream a base URL resolves to", async () => {
        const { fetch } = fakeFetch(runtimeRoutes());
        const r = await probeProducer(RT, { fetch });
        expect(r).toMatchObject({ ok: true, streamUrl: `${RT}/v1/observability/events`, error: null, corsSuspected: false });
        expect(r.discovery?.producer.role).toBe("runtime");
    });

    it("flags a network-level failure as possible CORS and names the allowlists", async () => {
        const { fetch } = fakeFetch({});
        const r = await probeProducer(RT, { fetch });
        expect(r.ok).toBe(false);
        expect(r.corsSuspected).toBe(true);
        expect(r.error).toMatch(/SONDER_OBSERVATORY_ORIGINS/);
    });

    it("says when a token is needed or refused", async () => {
        const { fetch } = fakeFetch({
            [`${RT}/.well-known/sonder-telemetry`]: (call) =>
                call.headers.Authorization === "Bearer good"
                    ? Response.json(discoveryDoc("sonder-runtime", "runtime", "rt-1"))
                    : Response.json({ error: { code: "unauthorized" } }, { status: 401 }),
            [`${INF}/.well-known/sonder-telemetry`]: () =>
                Response.json({ error: { code: "forbidden_origin" } }, { status: 403 }),
        });
        expect((await probeProducer(RT, { fetch })).error).toMatch(/requires a bearer token/);
        expect((await probeProducer(RT, { fetch, token: "bad" })).error).toMatch(/rejected the bearer token/);
        expect((await probeProducer(RT, { fetch, token: "good" })).ok).toBe(true);
        const origin = await probeProducer(INF, { fetch });
        expect(origin.corsSuspected).toBe(true);
        expect(origin.error).toMatch(/forbidden_origin/);
    });

    it("times out a silent producer", async () => {
        const fetch = (_url: string, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) =>
                init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
            );
        const r = await probeProducer(RT, { fetch, timeoutMs: 20 });
        expect(r.error).toMatch(/timed out/);
    });

    it("accepts stream URLs without fetching and applies the policy", async () => {
        const { fetch, calls } = fakeFetch({});
        expect(await probeProducer("ws://127.0.0.1:8765", { fetch })).toMatchObject({ ok: true, streamUrl: "ws://127.0.0.1:8765" });
        expect((await probeProducer("ws://127.0.0.1:8765", { fetch, token: "t" })).ok).toBe(false);
        expect((await probeProducer("http://10.1.1.1/sse", { fetch })).ok).toBe(false);
        expect((await probeProducer(RT, { fetch, token: "has space" })).error).toMatch(/printable ASCII/);
        expect(calls).toEqual([]);
    });
});

describe("producer URL classification and presets", () => {
    it("classifies base, discovery and stream URLs", () => {
        expect(classifyProducerUrl("http://127.0.0.1:11435")).toMatchObject({
            kind: "base",
            discoveryUrl: "http://127.0.0.1:11435/.well-known/sonder-telemetry",
        });
        expect(classifyProducerUrl("https://node.example/")).toMatchObject({ kind: "base" });
        expect(classifyProducerUrl("http://127.0.0.1:1/.well-known/sonder-telemetry").kind).toBe("discovery");
        expect(classifyProducerUrl("http://127.0.0.1:8766/sse").kind).toBe("stream");
        // ws(s) URLs are always streams; the legacy default endpoint keeps working.
        expect(classifyProducerUrl("ws://127.0.0.1:8765").kind).toBe("stream");
        expect(classifyProducerUrl("ftp://127.0.0.1").ok).toBe(false);
    });

    it("lists the local Runtime, Inference and fake producers", () => {
        expect(LOCAL_PRESETS.map((p) => [p.url, p.role])).toEqual([
            ["http://127.0.0.1:11435", "runtime"],
            ["http://127.0.0.1:11437", "inference"],
            ["http://127.0.0.1:8766/sse", "fixture"],
        ]);
    });

    it("maps client states to producer card states", () => {
        expect(["idle", "connecting", "open", "reconnecting", "closed", "failed"].map((state) =>
            producerState({ state: state as Parameters<typeof producerState>[0]["state"] }),
        )).toEqual(["disconnected", "connecting", "live", "reconnecting", "disconnected", "failed"]);
    });
});
