/**
 * --session / --capability on live connections: the session id travels as a
 * query parameter on every transport; the capability token goes in the
 * Authorization header (HTTP) or the first frame (WebSocket), never the URL.
 */
import { afterEach, describe, expect, it } from "vitest";
import { LiveIngestClient } from "../../../src/ingest/live/client";
import { capabilityFrame } from "../../../src/ingest/live/transports";
import type { WebSocketLike } from "../../../src/transport/live";

class FakeSocket implements WebSocketLike {
    readyState = 0;
    onopen: ((ev: unknown) => void) | null = null;
    onclose: ((ev: { code: number; reason: string }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    sent: string[] = [];
    closed: { code?: number; reason?: string } | null = null;
    constructor(readonly url: string) {}
    send(data: string): void {
        this.sent.push(data);
    }
    close(code?: number, reason?: string): void {
        this.closed = { code, reason };
    }
    open(): void {
        this.readyState = 1;
        this.onopen?.({});
    }
}

const clients: LiveIngestClient[] = [];
afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.stop()));
});

function client(options: ConstructorParameters<typeof LiveIngestClient>[0]): LiveIngestClient {
    const c = new LiveIngestClient({ reconnect: false, ...options });
    clients.push(c);
    return c;
}

const sink = { append: () => undefined };

describe("live credentials", () => {
    it("WebSocket: session in the query, capability as the first frame only", () => {
        const sockets: FakeSocket[] = [];
        const c = client({
            url: "ws://127.0.0.1:8766/ws",
            sink,
            session: "ses_42",
            capability: "cap-secret",
            webSocketFactory: (url) => {
                const s = new FakeSocket(url);
                sockets.push(s);
                return s;
            },
        });
        c.start();
        const socket = sockets[0]!;
        expect(new URL(socket.url).searchParams.get("session")).toBe("ses_42");
        expect(socket.url).not.toContain("cap-secret");
        expect(socket.sent).toEqual([]);
        socket.open();
        expect(socket.sent).toEqual([capabilityFrame("cap-secret", "ses_42")]);
        expect(JSON.parse(socket.sent[0]!)).toEqual({ type: "observatory.auth", capability: "cap-secret", session: "ses_42" });
        expect(c.status.state).toBe("open");
        expect(JSON.stringify(c.status)).not.toContain("cap-secret");
    });

    it("WebSocket without credentials sends nothing and keeps the URL", () => {
        const sockets: FakeSocket[] = [];
        const c = client({
            url: "ws://127.0.0.1:8766/ws",
            sink,
            webSocketFactory: (url) => {
                const s = new FakeSocket(url);
                sockets.push(s);
                return s;
            },
        });
        c.start();
        sockets[0]!.open();
        expect(sockets[0]!.url).toBe("ws://127.0.0.1:8766/ws");
        expect(sockets[0]!.sent).toEqual([]);
    });

    it("WebSocket fails closed when the socket cannot send the capability", () => {
        let socket: FakeSocket | null = null;
        const c = client({
            url: "ws://127.0.0.1:8766/ws",
            sink,
            capability: "cap-secret",
            webSocketFactory: (url) => {
                socket = new FakeSocket(url);
                (socket as { send?: unknown }).send = undefined;
                return socket;
            },
        });
        c.start();
        socket!.open();
        expect(c.status.state).toBe("failed");
        expect(socket!.closed?.code).toBe(1008);
    });

    it("HTTP: session in the query, capability as a Bearer header", async () => {
        const calls: { url: string; headers: Record<string, string> }[] = [];
        const c = client({
            url: "http://127.0.0.1:8766/events?format=ndjson",
            sink,
            session: "ses_42",
            capability: "cap-secret",
            fetch: async (url, init) => {
                calls.push({ url, headers: init?.headers as Record<string, string> });
                return new Response("", { status: 503 });
            },
        });
        c.start();
        await new Promise((r) => setTimeout(r, 10));
        expect(calls).toHaveLength(1);
        const url = new URL(calls[0]!.url);
        expect(url.searchParams.get("session")).toBe("ses_42");
        expect(url.searchParams.get("format")).toBe("ndjson");
        expect(calls[0]!.url).not.toContain("cap-secret");
        expect(calls[0]!.headers.Authorization).toBe("Bearer cap-secret");
    });

    it("honours a custom session parameter name", async () => {
        const urls: string[] = [];
        const c = client({
            url: "https://node.example/stream",
            sink,
            session: "ses_1",
            sessionParam: "session_id",
            fetch: async (url) => {
                urls.push(url);
                return new Response("", { status: 503 });
            },
        });
        c.start();
        await new Promise((r) => setTimeout(r, 10));
        expect(new URL(urls[0]!).searchParams.get("session_id")).toBe("ses_1");
        expect(new URL(urls[0]!).searchParams.has("session")).toBe(false);
    });
});
