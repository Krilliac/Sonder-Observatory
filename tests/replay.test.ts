import { describe, expect, it } from "vitest";
import { relatedEvents } from "../src/inspector/related";
import { ReplayCursor, upperBound } from "../src/replay/controller";
import { compareEvents, findSequenceGaps, orderEvents } from "../src/replay/order";
import { SessionStore } from "../src/replay/session";
import { at, makeEvent } from "./helpers";

describe("replay ordering", () => {
    it("sorts by mono_ns, then sequence, then event_id", () => {
        const a = makeEvent({ event_id: "b", mono_ns: 10, sequence: 2 });
        const b = makeEvent({ event_id: "a", mono_ns: 10, sequence: 2 });
        const c = makeEvent({ event_id: "c", mono_ns: 10, sequence: 1 });
        const d = makeEvent({ event_id: "d", mono_ns: 5, sequence: 9 });
        const ordered = orderEvents([a, b, c, d]).events.map((e) => e.event_id);
        expect(ordered).toEqual(["d", "c", "a", "b"]);
        expect(compareEvents(a, a)).toBe(0);
    });

    it("does not mutate the input array", () => {
        const input = [at(3, "x"), at(1, "y")];
        const snapshot = input.map((e) => e.event_id);
        orderEvents(input);
        expect(input.map((e) => e.event_id)).toEqual(snapshot);
    });

    it("drops duplicate event ids (first wins) and counts them", () => {
        const first = makeEvent({ event_id: "dup", attributes: { v: 1 } });
        const again = makeEvent({ event_id: "dup", attributes: { v: 2 } });
        const r = orderEvents([first, again]);
        expect(r.events).toHaveLength(1);
        expect(r.events[0]!.attributes.v).toBe(1);
        expect(r.duplicates).toBe(1);
    });

    it("reports sequence gaps per producer stream", () => {
        const p2 = { name: "other", version: "1", node_id: "n2" };
        const events = [
            makeEvent({ sequence: 0, mono_ns: 1 }),
            makeEvent({ sequence: 1, mono_ns: 2 }),
            makeEvent({ sequence: 4, mono_ns: 3 }),
            makeEvent({ sequence: 0, mono_ns: 4, producer: p2 }),
            makeEvent({ sequence: 1, mono_ns: 5, producer: p2 }),
        ];
        const gaps = findSequenceGaps(events);
        expect(gaps).toHaveLength(1);
        expect(gaps[0]).toMatchObject({ from: 2, to: 3 });
    });
});

describe("ReplayCursor", () => {
    const events = orderEvents([at(0, "a"), at(100, "b"), at(100, "c"), at(250, "d"), at(1000, "e")]).events;

    it("starts at the end with everything visible", () => {
        const c = new ReplayCursor(events);
        expect(c.durationNs).toBe(1000 * 1e6);
        expect(c.visibleCount()).toBe(5);
        expect(c.atEnd).toBe(true);
    });

    it("seeks, clamps and shows events at or before the cursor", () => {
        const c = new ReplayCursor(events);
        c.seek(100 * 1e6);
        expect(c.visibleEvents().map((e) => e.event_type)).toEqual(["a", "b", "c"]);
        expect(c.seek(-5)).toBe(0);
        expect(c.visibleCount()).toBe(1);
        expect(c.seek(1e15)).toBe(c.durationNs);
    });

    it("advances by elapsed wall time times speed", () => {
        const c = new ReplayCursor(events);
        c.seek(0);
        c.advance(50, 2); // 100 ms of session time
        expect(c.position).toBe(100 * 1e6);
        expect(c.visibleCount()).toBe(3);
    });

    it("finds the next matching event after the cursor", () => {
        const c = new ReplayCursor(events);
        c.seek(100 * 1e6);
        expect(c.nextMatching(() => true)?.event_type).toBe("d");
        c.seek(c.durationNs);
        expect(c.nextMatching(() => true)).toBeUndefined();
    });

    it("handles an empty session", () => {
        const c = new ReplayCursor([]);
        expect(c.durationNs).toBe(0);
        expect(c.visibleCount()).toBe(0);
        expect(upperBound([], 5)).toBe(0);
    });
});

describe("SessionStore", () => {
    it("keeps live appends in replay order and tracks duplicates", () => {
        const s = new SessionStore();
        s.reset("live", "ws://127.0.0.1:8765");
        s.append([at(20, "b")]);
        s.append([at(10, "a"), at(20, "b")]);
        expect(s.events.map((e) => e.event_type)).toEqual(["a", "b"]);
        expect(s.duplicates).toBe(1);
        expect(s.synthetic).toBe(false);
        expect(s.capturePolicy).toBe("unspecified");
    });
});

describe("relatedEvents", () => {
    it("prefers tool_call_id, then request_id", () => {
        const called = at(1, "tool.called", { request_id: "r1", attributes: { tool_call_id: "tc" } });
        const done = at(2, "tool.completed", { request_id: "r1", attributes: { tool_call_id: "tc" } });
        const other = at(3, "inference.token.generated", { request_id: "r1" });
        expect(relatedEvents(called, [called, done, other])).toMatchObject({ by: "tool_call_id", events: [done] });
        expect(relatedEvents(other, [called, done, other])?.by).toBe("request_id");
        expect(relatedEvents(at(4, "x"), [called])).toBeNull();
    });
});
