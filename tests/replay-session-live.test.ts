import { describe, expect, it } from "vitest";
import type { ObservatoryEvent } from "../src/protocol/events";
import type { RejectedLine } from "../src/recording/ndjson";
import { findSequenceGaps, orderEvents } from "../src/replay/order";
import { SessionStore } from "../src/replay/session";
import { makeEvent } from "./helpers";

function ev(i: number, extra: Partial<ObservatoryEvent> = {}): ObservatoryEvent {
    return makeEvent({ event_id: `e${i}`, sequence: i, mono_ns: i * 1000, ...extra });
}

/** Deterministic shuffle (LCG) so the test does not depend on Math.random. */
function shuffled<T>(items: readonly T[], seed = 7): T[] {
    const out = [...items];
    let x = seed;
    for (let i = out.length - 1; i > 0; i -= 1) {
        x = (x * 1103515245 + 12345) % 2147483648;
        const j = x % (i + 1);
        [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
}

describe("live SessionStore retention", () => {
    it("bounds a live session and says how many older events it dropped", () => {
        const store = new SessionStore({ maxLiveEvents: 1000 });
        store.reset("live", "http://127.0.0.1:1/events");
        for (let b = 0; b < 30; b += 1) {
            store.append(Array.from({ length: 100 }, (_, i) => ev(b * 100 + i)));
        }
        expect(store.events.length).toBeLessThanOrEqual(1000);
        expect(store.droppedByRetention).toBe(3000 - store.events.length);
        expect(store.droppedByRetention).toBeGreaterThan(0);
        // The newest events are kept, in order.
        expect(store.events.at(-1)!.event_id).toBe("e2999");
        const seqs = store.events.map((e) => e.sequence);
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
        // Retention is not telemetry loss: no sequence gap is invented.
        expect(store.gaps).toEqual([]);
        // The viewer is told, with the count.
        expect(store.retentionNotice).toContain(`${store.droppedByRetention} older live event(s) dropped`);
    });

    it("drops (and counts) a late event older than the retained window instead of re-inserting it", () => {
        const store = new SessionStore({ maxLiveEvents: 10 });
        store.reset("live", "u");
        store.append(Array.from({ length: 20 }, (_, i) => ev(i)));
        const before = store.droppedByRetention;
        store.append([ev(0, { event_id: "late-old" })]);
        expect(store.events.some((e) => e.event_id === "late-old")).toBe(false);
        expect(store.droppedByRetention).toBe(before + 1);
    });

    it("keeps every event of a loaded recording", () => {
        const store = new SessionStore({ maxLiveEvents: 10 });
        store.reset("file", "rec.sobs");
        store.append(Array.from({ length: 50 }, (_, i) => ev(i)));
        expect(store.events).toHaveLength(50);
        expect(store.droppedByRetention).toBe(0);
        expect(store.retentionNotice).toBeNull();
    });

    it("caps kept rejected lines for a live session but counts them all", () => {
        const store = new SessionStore({ maxLiveEvents: 10 });
        store.reset("live", "u");
        const lines: RejectedLine[] = Array.from({ length: 5000 }, (_, i) => ({ line: i + 1, reason: "bad", raw: "" }));
        store.addRejected(lines);
        store.addRejected(lines);
        expect(store.rejected.length).toBeLessThanOrEqual(1000);
        expect(store.rejectedCount).toBe(10_000);
        expect(store.rejected[0]!.line).toBe(1);
    });
});

describe("live SessionStore incremental ordering", () => {
    it("matches orderEvents for out-of-order, duplicated batches", () => {
        const all: ObservatoryEvent[] = [];
        for (let i = 0; i < 3000; i += 1) {
            // Two streams, some equal timestamps, and holes in the sequences.
            if (i % 97 === 5) {
                continue;
            }
            all.push(ev(i, { mono_ns: Math.floor(i / 3) * 1000, producer: { name: i % 2 ? "a" : "b", version: "1", node_id: "n" } }));
        }
        const wire = shuffled([...all, ...all.slice(100, 400)]);
        const store = new SessionStore();
        store.reset("live", "u");
        for (let i = 0; i < wire.length; i += 137) {
            store.append(wire.slice(i, i + 137));
        }
        const expected = orderEvents(wire);
        expect(store.events.map((e) => e.event_id)).toEqual(expected.events.map((e) => e.event_id));
        expect(store.duplicates).toBe(expected.duplicates);
        const byKey = (g: { stream: string; from: number }) => `${g.stream}|${String(g.from).padStart(8, "0")}`;
        expect([...store.gaps].sort((x, y) => byKey(x).localeCompare(byKey(y)))).toEqual(
            [...findSequenceGaps(expected.events)].sort((x, y) => byKey(x).localeCompare(byKey(y))),
        );
    });

    it("does not re-sort the whole history for each in-order batch", () => {
        const store = new SessionStore({ maxLiveEvents: 1_000_000 });
        store.reset("live", "u");
        const started = performance.now();
        for (let b = 0; b < 400; b += 1) {
            store.append(Array.from({ length: 1000 }, (_, i) => ev(b * 1000 + i)));
        }
        const elapsed = performance.now() - started;
        expect(store.events).toHaveLength(400_000);
        // Re-sorting 400 growing histories is ~80M comparisons (many seconds).
        expect(elapsed).toBeLessThan(4000);
    });
});
