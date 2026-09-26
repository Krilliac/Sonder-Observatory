import { describe, expect, it } from "vitest";
import { checkEndpoint, LiveConnection, type ConnectionState, type WebSocketLike } from "../src/transport/live";
import { makeEvent } from "./helpers";

class FakeSocket implements WebSocketLike {
    readyState = 0;
    onopen: WebSocketLike["onopen"] = null;
    onclose: WebSocketLike["onclose"] = null;
    onerror: WebSocketLike["onerror"] = null;
    onmessage: WebSocketLike["onmessage"] = null;
    closed: { code?: number; reason?: string } | null = null;
    constructor(readonly url: string) {}
    close(code?: number, reason?: string): void {
        this.closed = { code, reason };
    }
}

function setup() {
    const sockets: FakeSocket[] = [];
    const states: ConnectionState[] = [];
    const received: string[] = [];
    let rejected = 0;
    const conn = new LiveConnection(
        {
            onEvents: (events) => received.push(...events.map((e) => e.event_id)),
            onRejected: (lines) => (rejected += lines.length),
            onState: (s) => states.push(s),
        },
        (url) => {
            const s = new FakeSocket(url);
            sockets.push(s);
            return s;
        },
    );
    return { conn, sockets, states, received, rejected: () => rejected };
}

describe("checkEndpoint", () => {
    it("accepts loopback ws urls and flags remote ones", () => {
        expect(checkEndpoint("ws://127.0.0.1:8765")).toMatchObject({ ok: true, loopback: true });
        expect(checkEndpoint("ws://localhost:1")).toMatchObject({ ok: true, loopback: true });
        expect(checkEndpoint("wss://example.com/t")).toMatchObject({ ok: true, loopback: false });
        expect(checkEndpoint("http://127.0.0.1").ok).toBe(false);
        expect(checkEndpoint("nope").ok).toBe(false);
    });

    it("refuses plain remote ws and tokens or credentials in the URL", () => {
        expect(checkEndpoint("ws://192.168.0.9:8765").ok).toBe(false);
        expect(checkEndpoint("ws://127.0.0.1:8765/?token=abc").ok).toBe(false);
        expect(checkEndpoint("wss://example.com/t?access_token=abc").ok).toBe(false);
        expect(checkEndpoint("wss://u:p@example.com/t").ok).toBe(false);
    });
});

describe("LiveConnection", () => {
    it("connects, receives single and NDJSON frames, and disconnects", () => {
        const t = setup();
        t.conn.connect("ws://127.0.0.1:8765");
        expect(t.states).toEqual(["connecting"]);
        const s = t.sockets[0]!;
        s.onopen?.({});
        expect(t.conn.state).toBe("connected");

        const a = makeEvent();
        const b = makeEvent();
        s.onmessage?.({ data: JSON.stringify(a) });
        s.onmessage?.({ data: `${JSON.stringify(b)}\n{"bad":true}` });
        expect(t.received).toEqual([a.event_id, b.event_id]);
        expect(t.rejected()).toBe(1);
        expect(t.conn.received).toBe(2);

        t.conn.disconnect();
        expect(s.closed?.code).toBe(1000);
        expect(t.conn.state).toBe("disconnected");
    });

    it("rejects binary frames and invalid urls without opening a socket", () => {
        const t = setup();
        t.conn.connect("http://127.0.0.1:8765");
        expect(t.sockets).toHaveLength(0);
        expect(t.conn.state).toBe("error");
        t.conn.handleFrame(new Uint8Array([1, 2]));
        expect(t.rejected()).toBe(1);
    });

    it("ignores callbacks from a replaced socket", () => {
        const t = setup();
        t.conn.connect("ws://127.0.0.1:1");
        const first = t.sockets[0]!;
        t.conn.connect("ws://127.0.0.1:2");
        const second = t.sockets[1]!;
        expect(first.closed).not.toBeNull();
        first.onmessage?.({ data: JSON.stringify(makeEvent()) });
        expect(t.received).toEqual([]);
        second.onopen?.({});
        second.onclose?.({ code: 1006, reason: "" });
        expect(t.conn.state).toBe("disconnected");
    });
});
