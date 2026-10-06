import { describe, expect, it } from "vitest";
import type { ObservatoryEvent } from "../src/protocol/events";
import { validateEvent } from "../src/protocol/validate";
import { totalDroppedEvents } from "../src/query/attributes";
import { producerInstance, scopedRequestKey, scopedSessionKey, streamNameAndNode, tupleKey } from "../src/query/identity";
import { deriveMetrics } from "../src/query/metrics";
import { metricsAt } from "../src/query/metricsIndex";
import { renderSobs } from "../src/export/sobs";
import { renderJson } from "../src/export/json";
import { buildReport } from "../src/export/report";
import { loadRecording } from "../src/recording/sobs";
import { findSequenceGaps, orderEvents, streamKey } from "../src/replay/order";
import { SessionStore } from "../src/replay/session";
import { at, makeEvent } from "./helpers";

const a = { name: "x", node_id: "y\u0000z", instance_id: "i", version: "test", role: "inference", synthetic: true };
const b = { ...a, name: "x\u0000y", node_id: "z" };
const event = (ms: number, type: string, producer: ObservatoryEvent["producer"] = a, extra: Partial<ObservatoryEvent> = {}) => at(ms, type, { producer, request_id: "r", ...extra });

function metricsParity(events: readonly ObservatoryEvent[]): void {
    for (const count of Array.from({ length: events.length + 1 }, (_, i) => i).reverse()) {
        expect(metricsAt(events, count)).toEqual(deriveMetrics(events.slice(0, count)));
    }
}

describe("injective producer and request identities", () => {
    it("admits literal control characters while separating producer tuple boundaries", () => {
        const left = event(1, "request.started");
        const right = event(2, "request.started", b);
        expect(validateEvent(left).ok).toBe(true);
        expect(validateEvent(right).ok).toBe(true);
        expect(streamKey(left)).not.toBe(streamKey(right));
        expect(scopedRequestKey(streamKey(left), "r\u0000s")).not.toBe(scopedRequestKey(streamKey(right), "r\u0000s"));
        expect(streamNameAndNode(streamKey(left))).toEqual({ name: a.name, nodeId: a.node_id });
    });

    it("separates known-instance and session-fallback modes without relying on control characters", () => {
        const known = makeEvent({ producer: { ...a, name: "n", node_id: "a", instance_id: "i" } });
        const fallback = makeEvent({ session_id: "n", producer: { ...a, name: "a", node_id: "#i", instance_id: null } });
        expect(producerInstance(fallback)).toBeNull();
        expect(streamKey(known)).not.toBe(streamKey(fallback));
        expect(streamNameAndNode(streamKey(fallback))).toEqual({ name: "a", nodeId: "#i" });
    });

    it("retains exact explicit/inferred instances across sessions and inference mismatch fallback", () => {
        const known = event(1, "test.event", a, { session_id: "s1" });
        const inferred = event(2, "test.event", { ...a, instance_id: undefined }, { session_id: "s2", event_id: "i-2", sequence: 2 });
        expect(streamKey(inferred)).toBe(streamKey(known));
        for (const eventId of ["i-02", "i-3", "i-\n2"]) {
            const mismatch = { ...inferred, event_id: eventId };
            expect(producerInstance(mismatch)).toBeNull();
            expect(streamKey(mismatch)).not.toBe(streamKey(known));
        }
        expect(streamKey({ ...inferred, producer: { ...a, instance_id: "explicit" } })).not.toBe(streamKey(known));
    });

    it.each(["\u0000", "\u0001", "|", '"', "\\", "😀", "\ud800"])("keeps literal %j boundaries distinct and domains separate", delimiter => {
        const left = event(1, "test.event", { ...a, node_id: "n", instance_id: `i${delimiter}r` });
        const right = event(2, "test.event", { ...a, node_id: "n", instance_id: "i" });
        const key = scopedRequestKey(streamKey(left), "s");
        expect(key).not.toBe(scopedRequestKey(streamKey(right), `r${delimiter}s`));
        expect(scopedSessionKey(streamKey(left), "s")).not.toBe(key);
        expect(tupleKey("domain", "", delimiter)).not.toBe(tupleKey("domain", delimiter, ""));
        expect(validateEvent(left).ok).toBe(true);
    });

    it("keeps sequence gaps and cumulative drop totals separate in scan and live append", () => {
        const events = [
            event(1, "telemetry.dropped", a, { sequence: 0, attributes: { dropped_events: 3 } }),
            event(2, "telemetry.dropped", b, { sequence: 1, attributes: { dropped_events: 7 } }),
            event(3, "telemetry.dropped", a, { sequence: 2, attributes: { dropped_events: 5 } }),
            event(4, "telemetry.dropped", b, { sequence: 3, attributes: { dropped_events: 9 } }),
        ];
        const ordered = orderEvents(events).events;
        expect(findSequenceGaps(ordered).map(g => [g.stream, g.from, g.to])).toEqual([
            [streamKey(events[0]!), 1, 1], [streamKey(events[1]!), 2, 2],
        ]);
        expect(totalDroppedEvents(ordered)).toBe(14);
        const store = new SessionStore();
        store.reset("live", "synthetic identity gaps");
        for (const e of events) {
            store.append([e]);
            expect(store.gaps).toEqual(findSequenceGaps(store.events));
            metricsParity(store.events);
        }
        expect(metricsAt(store.events).droppedEvents).toBe(14);
    });

    it("prevents cross-completion of colliding request spans and keeps indexed prefix parity", () => {
        const events = orderEvents([
            event(1, "request.started"), event(2, "request.started", b),
            event(3, "inference.token.generated", a, { attributes: { count: 2 } }),
            event(4, "request.failed", b), event(5, "request.completed"),
        ]).events;
        const before = JSON.stringify(events);
        metricsParity(events);
        metricsParity(Object.freeze([...events]));
        expect(deriveMetrics(events).requests.map(r => [r.streamKey, r.outcome, r.tokens])).toEqual([
            [streamKey(events[0]!), "completed", 2], [streamKey(events[1]!), "failed", 0],
        ]);
        expect(JSON.stringify(events)).toBe(before);
    });

    it("separates the U+0001 request suffix boundary in plain and indexed spans", () => {
        const pa = { ...a, name: "n", node_id: "n", instance_id: "i\u0001r" };
        const pb = { ...pa, instance_id: "i" };
        const events = orderEvents([
            event(1, "request.started", pa, { request_id: "s" }),
            event(2, "request.started", pb, { request_id: "r\u0001s" }),
            event(3, "request.completed", pa, { request_id: "s" }),
            event(4, "request.failed", pb, { request_id: "r\u0001s" }),
        ]).events;
        metricsParity(events);
        expect(deriveMetrics(events).requests.map(r => [r.requestId, r.outcome])).toEqual([["s", "completed"], ["r\u0001s", "failed"]]);
    });

    it("isolates session model lookup across U+0001 stream/session boundaries", () => {
        const pa = { ...a, name: "n", node_id: "n", instance_id: "i\u0001s" };
        const pb = { ...pa, instance_id: "i" };
        const events = orderEvents([
            event(1, "session.created", pa, { session_id: "t", attributes: { model: "model-a" } }),
            event(2, "session.created", pb, { session_id: "s\u0001t", attributes: { model: "model-b" } }),
            event(3, "request.started", pa, { session_id: "t" }),
            event(4, "request.started", pb, { session_id: "s\u0001t" }),
        ]).events;
        metricsParity(events);
        expect(deriveMetrics(events).requests.map(r => r.model)).toEqual(["model-a", "model-b"]);
    });

    it("preserves old prefix results across append, retained eviction and source replacement", () => {
        const store = new SessionStore({ maxLiveEvents: 4 });
        store.reset("live", "synthetic bounded identity");
        store.append([event(1, "request.started"), event(2, "request.started", b)]);
        const old = store.events;
        const oldMetrics = metricsAt(old);
        store.append([event(3, "request.completed"), event(4, "request.failed", b)]);
        const completed = store.events;
        store.append([event(5, "request.started", a, { request_id: "new" })]);
        expect(store.droppedByRetention).toBeGreaterThan(0);
        metricsParity(store.events);
        expect(store.gaps).toEqual(findSequenceGaps(store.events));
        expect(metricsAt(old)).toEqual(oldMetrics);
        metricsParity(completed);
        store.reset("file", "synthetic replacement");
        store.append([event(7, "request.started", b)]);
        expect(metricsAt(store.events).requests).toHaveLength(1);
        expect(metricsAt(old)).toEqual(oldMetrics);
    });

    it("keeps source envelopes lossless and exports derived stream identities as opaque strings", () => {
        const events = orderEvents([event(1, "request.started"), event(2, "request.completed")]).events;
        const before = JSON.stringify(events);
        const recording = renderSobs(events, {}, new Date("2026-10-06T00:00:00Z"));
        expect(loadRecording(recording).events).toEqual(events);
        expect(JSON.stringify(events)).toBe(before);
        const exported = JSON.parse(renderJson(buildReport({ events, generatedAt: new Date("2026-10-06T00:00:00Z") })));
        expect(exported.format).toBe("sonder.observatory.export/1");
        expect(exported.metrics.requests[0].streamKey).toBe(streamKey(events[0]!));
        expect(exported.metrics.requests[0].requestId).toBe("r");
    });
});
