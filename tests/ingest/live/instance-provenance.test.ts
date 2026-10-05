/** Instance-scoped wire provenance, using the real HTTP parsers and manager. */
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveConnectionManager } from "../../../src/ingest/live/manager";
import type { ProducerDiscovery } from "../../../src/protocol/discovery";
import type { ObservatoryEvent } from "../../../src/protocol/events";
import { producerCardModel } from "../../../src/renderer/producersPanel";
import { SessionStore } from "../../../src/replay/session";

const managers: LiveConnectionManager[] = [];
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disconnectAll()));
    vi.useRealTimers();
});

function event(instance: string, sequence: number, synthetic?: boolean | null, extra: Partial<ObservatoryEvent["producer"]> = {}): ObservatoryEvent {
    return {
        schema: "sonder.observatory.event/1", event_id: `${instance}-${sequence}`, sequence,
        event_type: "engine.stopped", session_id: `session-${instance}`, wall_time: "2026-10-05T00:00:00.000Z", mono_ns: sequence + 1,
        producer: { name: "sonder-inference", version: "1", node_id: "host", instance_id: instance, synthetic, ...extra },
        attributes: {},
    };
}

async function pump(): Promise<void> {
    for (let i = 0; i < 10; i += 1) await nextTurn();
}

async function harness(transport: "sse" | "ndjson", discovery?: ProducerDiscovery["producer"], maxLiveEvents?: number) {
    const store = new SessionStore({ maxLiveEvents });
    const batches: number[] = [];
    const append = store.append.bind(store);
    store.append = (events) => { batches.push(events.length); append(events); };
    const calls: { url: string; cursor: string | null }[] = [];
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const manager = new LiveConnectionManager(store, { fetch: async (url, init) => {
        calls.push({ url, cursor: new Headers(init?.headers).get("Last-Event-ID") });
        if (url.endsWith("/.well-known/sonder-telemetry")) {
            return Response.json({
                schema: "sonder.telemetry.producer/1", producer: discovery,
                event_schema: "sonder.observatory.event/1", streams: [{ transport, url: `/events/${transport}` }],
                resume: { header: "Last-Event-ID", query: "last_event_id", retained_events: 1000, oldest_sequence: 0, next_sequence: 1000 },
                auth: { required: false, schemes: ["bearer"] }, clock: { mono_ns: "host-monotonic" },
            });
        }
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
            streams.push(controller);
            init?.signal?.addEventListener("abort", () => {
                try { controller.error(new DOMException("aborted", "AbortError")); } catch { /* already closed */ }
            }, { once: true });
        } }), { headers: { "content-type": transport === "sse" ? "text/event-stream" : "application/x-ndjson" } });
    } });
    managers.push(manager);
    await manager.add({ url: discovery ? "http://127.0.0.1:11437" : `http://127.0.0.1:11437/events/${transport}`, transport });
    await pump();
    return {
        store, manager, batches, calls,
        current: () => manager.list()[0]!,
        card: () => producerCardModel(manager.list()[0]!),
        async send(events: ObservatoryEvent[]) {
            const original = JSON.stringify(events);
            const text = transport === "sse"
                ? events.map((e) => `id: ${e.event_id}\ndata: ${JSON.stringify(e)}\n\n`).join("")
                : events.map((e) => JSON.stringify(e)).join("\n") + "\n";
            streams.at(-1)!.enqueue(new TextEncoder().encode(text));
            await pump();
            // Real client defaults: 1000 events per batch, 50 ms flush, 20000 queue.
            await vi.advanceTimersByTimeAsync(50);
            await pump();
            expect(JSON.stringify(events)).toBe(original);
            expect(manager.list()[0]!.status.lastEventId).toBe(events.at(-1)!.event_id);
            expect(manager.list()[0]!.status.dropped).toBe(0);
            expect(manager.list()[0]!.status.rejected).toBe(0);
        },
        async reconnect() {
            const cursor = manager.list()[0]!.status.lastEventId;
            streams.at(-1)!.close();
            await pump();
            await vi.advanceTimersByTimeAsync(1000);
            await pump();
            expect(streams).toHaveLength(2);
            expect(calls.at(-1)!.cursor).toBe(cursor);
        },
    };
}

for (const transport of ["sse", "ndjson"] as const) {
    describe(`instance provenance over ${transport}`, () => {
        for (const footer of [undefined, null, false]) {
            it(`preserves same-instance batch positive evidence before ${String(footer)} footer`, async () => {
                const h = await harness(transport);
                const events = [event("A", 0, true), event("A", 1, footer)];
                await h.send(events);
                expect(h.card().synthetic).toBe(true);
                expect(h.store.events).toEqual(events);
                expect(h.batches).toEqual([2]);
            });
        }
        it("retains same-key positives across later unknown/false batches and refreshes metadata", async () => {
            const h = await harness(transport);
            await h.send([event("A", 0, true, { role: "inference" })]);
            await h.send([event("A", 1, undefined, { version: "2" })]);
            expect(h.current().identity).toMatchObject({ version: "2", role: "inference", synthetic: true });
            await h.send([event("A", 2, false, { role: "custom", version: "3" })]);
            expect(h.current().identity).toMatchObject({ version: "3", role: "custom", synthetic: true });
        });
        it("aggregates only the final instance within an interleaved batch", async () => {
            const h = await harness(transport);
            await h.send([event("A", 0, true), event("B", 0), event("A", 1)]);
            expect(h.card().synthetic).toBe(true);
            await h.send([event("A", 2, true), event("B", 1, false)]);
            expect(h.current().identity).toMatchObject({ instance_id: "B", synthetic: false });
            expect(h.store.synthetic).toBe(true);
        });
        it("does not carry synthetic or role across a restart", async () => {
            const h = await harness(transport);
            await h.send([event("A", 0, true, { role: "inference" })]);
            await h.send([event("B", 0, false, { version: "2" })]);
            expect(h.current().identity).toMatchObject({ instance_id: "B", version: "2", role: null, synthetic: false });
            await h.send([event("B", 1, true), event("B", 2)]);
            expect(h.card().synthetic).toBe(true);
        });
        for (const changed of [{ name: "other" }, { node_id: "other" }]) {
            it(`treats changed ${Object.keys(changed)[0]} with the same instance string as a separate key`, async () => {
                const h = await harness(transport);
                await h.send([event("A", 0, true, { role: "inference" })]);
                await h.send([event("A", 1, undefined, changed)]);
                expect(h.current().identity).toMatchObject({ ...changed, role: null, synthetic: false });
            });
        }
        it("reapplies immutable matching discovery after A→B→A, with same-key role fallback", async () => {
            const discovery = { name: "sonder-inference", version: "0", node_id: "host", instance_id: "A", role: "inference" as const, synthetic: true };
            const h = await harness(transport, discovery);
            const original = JSON.stringify(h.current().discovery);
            await h.send([event("A", 0, false, { version: "1" })]);
            expect(h.current().identity).toMatchObject({ version: "1", role: "inference", synthetic: true });
            await h.send([event("B", 0)]);
            expect(h.current().identity).toMatchObject({ instance_id: "B", role: null, synthetic: false });
            await h.send([event("A", 1)]);
            expect(h.current().identity).toMatchObject({ instance_id: "A", role: "inference", synthetic: true });
            expect(JSON.stringify(h.current().discovery)).toBe(original);
        });
        it("does not apply discovery to a same-instance string on another node", async () => {
            const h = await harness(transport, { name: "sonder-inference", version: "0", node_id: "host", instance_id: "A", role: "inference", synthetic: true });
            await h.send([event("A", 0, false, { node_id: "elsewhere" })]);
            expect(h.current().identity).toMatchObject({ node_id: "elsewhere", role: null, synthetic: false });
        });
        it("recovers a canonical event-id instance, but explicit instance wins", async () => {
            const h = await harness(transport);
            await h.send([event("A", 0, true, { instance_id: null }), event("A", 1, undefined, { instance_id: undefined })]);
            expect(h.current().identity).toMatchObject({ instance_id: "A", synthetic: true });
            await h.send([event("A", 2, false, { instance_id: "B" })]);
            expect(h.current().identity).toMatchObject({ instance_id: "B", synthetic: false });
        });
        it("classifies unresolved final identities from their final event only", async () => {
            const h = await harness(transport, { name: "sonder-inference", version: "0", node_id: "host", instance_id: "A", role: "inference", synthetic: true });
            await h.send([event("A", 0, true, { role: "inference" })]);
            const unresolved = (sequence: number, synthetic?: boolean) => ({ ...event("unresolved", sequence, synthetic, { instance_id: null }), event_id: `anonymous:${sequence}` });
            await h.send([unresolved(1, true), unresolved(2)]);
            expect(h.current().identity).toMatchObject({ instance_id: null, role: null, synthetic: false });
            await h.send([unresolved(3, true)]);
            expect(h.card().synthetic).toBe(true);
            await h.send([unresolved(4, false)]);
            expect(h.card().synthetic).toBe(false);
        });
        it("does not guess continuity from a noncanonical or mismatched event id", async () => {
            const h = await harness(transport);
            await h.send([event("A", 0, true)]);
            await h.send([{ ...event("A", 1, undefined, { instance_id: null }), event_id: "A-01" }]);
            expect(h.current().identity).toMatchObject({ instance_id: null, synthetic: false });
            await h.send([{ ...event("A", 2, false, { instance_id: null }), event_id: "A-3" }]);
            expect(h.current().identity).toMatchObject({ instance_id: null, synthetic: false });
        });
        it("retains same-instance classification on reconnect and resets it for a restarted producer", async () => {
            const h = await harness(transport);
            const first = event("A", 0, true);
            await h.send([first]);
            await h.reconnect();
            await h.send([first, event("A", 1)]);
            expect(h.card().synthetic).toBe(true);
            expect(h.store.duplicates).toBe(1);
            await h.send([event("B", 0)]);
            expect(h.current().identity).toMatchObject({ instance_id: "B", synthetic: false });
            expect(h.store.gaps).toEqual([]);
        });
        it("follows wire-final replay, independently of retained time order and deduplication", async () => {
            const h = await harness(transport);
            const a = event("A", 0, true);
            const b = { ...event("B", 0), mono_ns: 100 };
            await h.send([a, b]);
            expect(h.current().identity?.instance_id).toBe("B");
            await h.send([a]);
            expect(h.current().identity).toMatchObject({ instance_id: "A", synthetic: true });
            expect(h.store.events).toEqual([a, b]);
            expect(h.store.events.at(-1)!.producer.instance_id).toBe("B");
            expect(h.store.duplicates).toBe(1);
        });
        it("keeps current-instance evidence after retention evicts its positive event", async () => {
            const h = await harness(transport, undefined, 2);
            await h.send([event("A", 0, true)]);
            await h.send([event("A", 1), event("A", 2), event("A", 3)]);
            expect(h.card().synthetic).toBe(true);
            expect(h.store.synthetic).toBe(false);
            expect(h.store.droppedByRetention).toBeGreaterThan(0);
            expect(h.store.events.length).toBeLessThanOrEqual(2);
        });
        it("does not claim a history map when an old instance returns without discovery", async () => {
            const h = await harness(transport);
            await h.send([event("A", 0, true)]);
            await h.send([event("B", 0)]);
            await h.send([event("A", 1)]);
            expect(h.card().synthetic).toBe(false);
            expect(h.store.synthetic).toBe(true);
        });
        it("keeps all-unknown and all-false instances unclassified", async () => {
            const h = await harness(transport);
            await h.send([event("A", 0), event("A", 1, null), event("A", 2, false)]);
            expect(h.card().synthetic).toBe(false);
            expect(h.store.synthetic).toBe(false);
        });
        it("preserves default bounded batches and original event fields across the 1000-event boundary", async () => {
            const h = await harness(transport);
            const events = Array.from({ length: 1001 }, (_, sequence) => event("A", sequence, sequence === 0 ? true : undefined));
            await h.send(events);
            await vi.advanceTimersByTimeAsync(50);
            await pump();
            expect(h.batches).toEqual([1000, 1]);
            expect(h.current().status.bufferCapacity).toBe(20000);
            expect(h.current().status.appended).toBe(1001);
            expect(h.store.events).toEqual(events);
            expect(h.card().synthetic).toBe(true);
        });
    });
}
