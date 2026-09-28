import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startFakeLiveProducer, type FakeLiveProducer } from "../../../scripts/fake-live-producer.mjs";

const event = {
    schema: "sonder.observatory.event/1",
    event_id: "e1",
    sequence: 1,
    event_type: "test.event",
    wall_time: "2026-09-26T08:00:00.000Z",
    mono_ns: 1,
    session_id: "s",
    producer: { name: "p", version: "1", node_id: "n" },
    attributes: {},
};

describe("fake-live producer exposure", () => {
    const producers: FakeLiveProducer[] = [];
    afterEach(async () => {
        await Promise.all(producers.splice(0).map((p) => p.close()));
    });

    it("refuses a non-loopback bind without a bearer token", async () => {
        await expect(startFakeLiveProducer({ events: [event], host: "0.0.0.0" })).rejects.toThrow(/token/);
    });

    it("allows a non-loopback bind when a token is required", async () => {
        const p = await startFakeLiveProducer({ events: [event], host: "0.0.0.0", token: "t0ken" });
        producers.push(p);
        expect(p.port).toBeGreaterThan(0);
    });

    it("caps concurrent stream connections", async () => {
        const p = await startFakeLiveProducer({ events: [event], maxConnections: 2, heartbeatMs: 60_000 });
        producers.push(p);
        const controllers = [new AbortController(), new AbortController()];
        try {
            const open = await Promise.all(controllers.map((c) => fetch(p.urls.ndjson, { signal: c.signal })));
            expect(open.map((r) => r.status)).toEqual([200, 200]);
            const third = await fetch(p.urls.ndjson);
            expect(third.status).toBe(503);
            await third.body?.cancel();
            const ws = new WebSocket(p.urls.websocket);
            const refused = await new Promise<boolean>((resolve) => {
                ws.on("open", () => resolve(false));
                ws.on("error", () => resolve(true));
                ws.on("unexpected-response", () => resolve(true));
            });
            ws.terminate();
            expect(refused).toBe(true);
        } finally {
            for (const c of controllers) {
                c.abort();
            }
        }
    });
});

describe("legacy fake producer (scripts/fake-producer.mjs)", () => {
    const children: ChildProcess[] = [];
    afterEach(() => {
        for (const c of children.splice(0)) {
            c.kill();
        }
    });

    function start(args: string[]): Promise<{ child: ChildProcess; out: string; code: number | null }> {
        const script = fileURLToPath(new URL("../../../scripts/fake-producer.mjs", import.meta.url));
        const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
        children.push(child);
        let out = "";
        return new Promise((resolve) => {
            const done = (code: number | null) => resolve({ child, out, code });
            child.stdout!.on("data", (d: Buffer) => {
                out += d.toString();
                if (out.includes("fake producer: ws://")) {
                    done(null);
                }
            });
            child.stderr!.on("data", (d: Buffer) => {
                out += d.toString();
            });
            child.on("exit", (code) => done(code));
        });
    }

    function connect(url: string, origin?: string): Promise<"open" | "refused"> {
        const ws = new WebSocket(url, origin ? { origin } : {});
        return new Promise((resolve) => {
            ws.on("open", () => {
                ws.terminate();
                resolve("open");
            });
            ws.on("error", () => resolve("refused"));
            ws.on("unexpected-response", () => {
                ws.terminate();
                resolve("refused");
            });
        });
    }

    it("refuses a non-loopback bind (it has no authentication)", async () => {
        const r = await start(["--host", "0.0.0.0", "--port", "0"]);
        expect(r.code).toBe(2);
        expect(r.out).toMatch(/loopback/);
    }, 20_000);

    it("refuses a cross-origin page but accepts the Observatory origin and non-browser clients", async () => {
        const port = 20_000 + Math.floor(Math.random() * 20_000);
        const r = await start(["--port", String(port)]);
        expect(r.code).toBeNull();
        const url = `ws://127.0.0.1:${port}`;
        expect(await connect(url, "https://evil.example")).toBe("refused");
        expect(await connect(url, "http://127.0.0.1:5173")).toBe("open");
        expect(await connect(url)).toBe("open");
    }, 20_000);
});
