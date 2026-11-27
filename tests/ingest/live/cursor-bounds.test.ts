import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveIngestClient } from "../../../src/ingest/live/client";
import type { ObservatoryEvent } from "../../../src/protocol/events";
import type { WebSocketLike } from "../../../src/transport/live";

const clients: LiveIngestClient[] = [];
afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.stop()));
    vi.useRealTimers();
});

function event(n: number, stream: string | null): ObservatoryEvent {
    return {
        schema: "sonder.observatory.event/1", event_id: `inst-${n}`, sequence: n,
        event_type: "synthetic.cursor", wall_time: "2026-10-04T00:00:00.000Z", mono_ns: 1000 + n,
        session_id: "cursor-session",
        producer: { name: "synthetic-cursor", version: "1", node_id: "local", synthetic: true, instance_id: "inst", ...(stream === null ? {} : { stream }) },
        attributes: {},
    };
}

async function feed(events: ObservatoryEvent[]) {
    vi.useFakeTimers();
    const appended: string[] = [];
    let opened = 0;
    const client = new LiveIngestClient({
        url: "ws://127.0.0.1:8766/ws", maxRetries: 0, backoff: { initialMs: 1, maxMs: 1, jitter: 0 },
        bufferCapacity: 20000, flushIntervalMs: 1,
        sink: { append: (batch) => { appended.push(...batch.map((e) => e.event_id)); } },
        webSocketFactory: () => {
            const first = ++opened === 1;
            const socket: WebSocketLike = { readyState: 0, onopen: null, onclose: null, onerror: null, onmessage: null, close: () => {} };
            setTimeout(() => {
                socket.onopen?.({});
                if (first) for (const e of events) socket.onmessage?.({ data: JSON.stringify(e) });
                socket.onclose?.({ code: 1000, reason: "done" });
            }, 0);
            return socket;
        },
    });
    clients.push(client);
    client.start();
    await vi.advanceTimersByTimeAsync(100);
    const cursors = (client as unknown as { cursors: Map<string, string> }).cursors;
    return { client, cursors, appended };
}

describe("resume cursor bounds", () => {
    it("caps tracked streams and the cursor header for 10,000 distinct stream names", async () => {
        const events = [event(0, null)];
        for (let i = 1; i <= 10000; i++) events.push(event(i, `s${i}`));
        const { client, cursors, appended } = await feed(events);
        expect(appended).toHaveLength(10001);
        expect(cursors.size).toBeLessThanOrEqual(8);
        expect(cursors.has("")).toBe(true);
        expect(client.status.lastEventId!.length).toBeLessThanOrEqual(1024);
    });

    it("does not track over-long names or names with separators, but keeps the events", async () => {
        const { client, cursors, appended } = await feed([
            event(1, null), event(2, "x".repeat(65)), event(3, "a,b"), event(4, "a\nb"), event(5, "sp ace"),
        ]);
        expect(appended).toHaveLength(5);
        expect([...cursors.keys()]).toEqual([""]);
        expect(client.status.lastEventId).toBe("inst-1");
    });

    it("tracks a 64-char name and ignores over-long ids for the cursor", async () => {
        const long = { ...event(2, "samples"), event_id: `inst-${"9".repeat(300)}` };
        const { cursors, appended } = await feed([event(1, "y".repeat(64)), long]);
        expect(appended).toHaveLength(2);
        expect([...cursors.keys()]).toEqual(["y".repeat(64)]);
    });

    it("keeps the default and samples behaviour unchanged", async () => {
        const { client, cursors } = await feed([event(1, null), event(2, "samples"), event(3, null)]);
        expect([...cursors.keys()].sort()).toEqual(["", "samples"]);
        expect(client.status.lastEventId).toBe("inst-3,inst-2");
    });
});
