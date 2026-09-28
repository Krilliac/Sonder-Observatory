import { describe, expect, it } from "vitest";
import type { ObservatoryEvent } from "../src/protocol/events";
import { deriveMetrics } from "../src/query/metrics";
import { at } from "./helpers";

function token(ms: number, rid: string | null, index: number): ObservatoryEvent {
    return at(ms, "inference.token.generated", {
        ...(rid ? { request_id: rid } : {}),
        event_id: `tok_${rid ?? "none"}_${index}`,
        attributes: { index, unit: "token", count: 1 },
    });
}

describe("deriveMetrics on very long sessions", () => {
    it("does not throw when there are more finished requests than a call can take arguments", () => {
        // Spreading ~125k+ values into Math.max throws RangeError in V8.
        const n = 200_000;
        const events: ObservatoryEvent[] = new Array(n * 2);
        for (let i = 0; i < n; i += 1) {
            events[2 * i] = { ...at(i * 10, "request.started", { request_id: `r${i}` }), event_id: `s${i}`, sequence: 2 * i };
            events[2 * i + 1] = { ...at(i * 10 + 1 + (i % 7), "request.completed", { request_id: `r${i}` }), event_id: `c${i}`, sequence: 2 * i + 1 };
        }
        const m = deriveMetrics(events);
        expect(m.requestLatency.count).toBe(n);
        expect(m.requestLatency.maxMs).toBe(7);
    });

    it("does not throw on a single request with more token events than a call can take arguments", () => {
        const n = 200_000;
        const events: ObservatoryEvent[] = [at(0, "request.started", { request_id: "big", event_id: "big_start" })];
        for (let i = 0; i < n; i += 1) {
            events.push({ ...token(1 + i * 0.01, "big", i), sequence: i + 1 });
        }
        const m = deriveMetrics(events);
        expect(m.tokens.total).toBe(n);
    });
});

describe("token rates: fenceposts and short sessions", () => {
    it("rates token events without a request over their intervals, not their count", () => {
        // 11 tokens 100 ms apart: 10 intervals over 1.0 s is 10 tok/s, not 11.
        const events = [];
        for (let i = 0; i <= 10; i += 1) {
            events.push(token(i * 100, null, i));
        }
        const m = deriveMetrics(events);
        expect(m.tokens.total).toBe(11);
        expect(m.tokens.overallRate).toBeCloseTo(10, 6);
    });

    it("divides the recent rate by the time actually observed when the session is shorter than the window", () => {
        // 11 tokens over 1 s: the trailing window is 1 s long, not 5 s.
        const events = [];
        for (let i = 0; i <= 10; i += 1) {
            events.push(token(i * 100, null, i));
        }
        const m = deriveMetrics(events);
        expect(m.tokens.windowMs).toBeCloseTo(1000, 6);
        expect(m.tokens.recentRate).toBeCloseTo(10, 6);
    });

    it("reports no recent rate when no time has elapsed", () => {
        const m = deriveMetrics([token(5, null, 0)]);
        expect(m.tokens.total).toBe(1);
        expect(m.tokens.recentRate).toBeNull();
    });

    it("keeps the full window once the session is longer than it", () => {
        const events = [at(0, "session.started")];
        for (let i = 0; i <= 10; i += 1) {
            events.push(token(10_000 + i * 100, null, i));
        }
        const m = deriveMetrics(events);
        expect(m.tokens.windowMs).toBe(5000);
        expect(m.tokens.recentRate).toBeCloseTo(11 / 5, 6);
    });
});
