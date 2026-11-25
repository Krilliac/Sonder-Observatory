import { describe, expect, it } from "vitest";
import type { ObservatoryEvent } from "../src/protocol/events";
import {
    deriveRequestLifecycles,
    findRequestLifecycle,
    MAX_LIFECYCLE_TRANSITIONS,
} from "../src/replay/lifecycle";
import { SessionStore } from "../src/replay/session";
import { at } from "./helpers";

const INF_A = { name: "sonder-inference", version: "0.1.0", node_id: "node-a", instance_id: "tel-aaaa", role: "inference" };
const INF_B = { name: "sonder-inference", version: "0.1.0", node_id: "node-b", instance_id: "tel-bbbb", role: "inference" };

describe("per-request lifecycle tracking", () => {
    it("cleanly separates req #1 (prefill -> decode -> cancelled) from req #2 starting 104ms later in prefill", () => {
        const store = new SessionStore();
        store.reset("live", "http://127.0.0.1:11437/v1/telemetry/sse");

        store.append([
            at(0, "request.started", { request_id: "req-1", producer: INF_A, sequence: 0, event_id: "tel-aaaa-0" }),
            at(10, "inference.prefill.started", { request_id: "req-1", producer: INF_A, sequence: 1, event_id: "tel-aaaa-1" }),
            at(45, "inference.decode.started", { request_id: "req-1", producer: INF_A, sequence: 2, event_id: "tel-aaaa-2" }),
            at(60, "inference.token.generated", { request_id: "req-1", producer: INF_A, sequence: 3, event_id: "tel-aaaa-3" }),
            at(120, "request.cancelled", { request_id: "req-1", producer: INF_A, sequence: 4, event_id: "tel-aaaa-4" }),
            // 104ms later: request #2 begins in prefill.
            at(224, "request.started", { request_id: "req-2", producer: INF_A, sequence: 5, event_id: "tel-aaaa-5" }),
            at(226, "inference.prefill.started", { request_id: "req-2", producer: INF_A, sequence: 6, event_id: "tel-aaaa-6" }),
            at(240, "inference.prefill.chunk", { request_id: "req-2", producer: INF_A, sequence: 7, event_id: "tel-aaaa-7" }),
        ]);

        const lifecycles = store.requestLifecycles;
        expect(lifecycles).toHaveLength(2);

        const r1 = lifecycles.find((r) => r.requestId === "req-1")!;
        const r2 = lifecycles.find((r) => r.requestId === "req-2")!;

        expect(r1).toMatchObject({
            requestId: "req-1",
            status: "cancelled",
            cancelled: true,
            phase: "cancelled",
            lastActivePhase: "decode",
            startNs: 0,
            endNs: 120 * 1e6,
            firstTokenNs: 60 * 1e6,
            lateEventsAfterTerminal: 0,
        });
        expect(r1.transitions.map((t) => t.to)).toEqual(["prefill", "decode", "cancelled"]);

        expect(r2).toMatchObject({
            requestId: "req-2",
            status: "active",
            cancelled: false,
            phase: "prefill",
            lastActivePhase: "prefill",
            startNs: 224 * 1e6,
            endNs: null,
            firstTokenNs: null,
        });
        expect(r2.transitions.map((t) => t.to)).toEqual(["prefill"]);

        expect(store.activeRequests.map((r) => r.requestId)).toEqual(["req-2"]);
        expect(store.cancelledRequests.map((r) => r.requestId)).toEqual(["req-1"]);

        // Now req-2 advances into decode in a subsequent live batch.
        store.append([
            at(280, "inference.decode.started", { request_id: "req-2", producer: INF_A, sequence: 8, event_id: "tel-aaaa-8" }),
            at(295, "inference.token.generated", { request_id: "req-2", producer: INF_A, sequence: 9, event_id: "tel-aaaa-9" }),
        ]);

        const updated = store.requestLifecycles;
        expect(updated.find((r) => r.requestId === "req-1")!.transitions.map((t) => t.to)).toEqual([
            "prefill",
            "decode",
            "cancelled",
        ]);
        expect(updated.find((r) => r.requestId === "req-2")!.transitions.map((t) => t.to)).toEqual([
            "prefill",
            "decode",
        ]);
        expect(updated.find((r) => r.requestId === "req-2")!.status).toBe("active");
    });

    it("keeps overlapping requests isolated when req #1 cancels mid-decode while req #2 is prefilling", () => {
        const lifecycles = deriveRequestLifecycles([
            at(0, "request.started", { request_id: "req-1", producer: INF_A, sequence: 0 }),
            at(20, "inference.decode.started", { request_id: "req-1", producer: INF_A, sequence: 1 }),
            at(30, "request.started", { request_id: "req-2", producer: INF_A, sequence: 2 }),
            at(35, "inference.token.generated", { request_id: "req-1", producer: INF_A, sequence: 3 }),
            at(40, "inference.prefill.chunk", { request_id: "req-2", producer: INF_A, sequence: 4 }),
            at(50, "request.cancelled", { request_id: "req-1", producer: INF_A, sequence: 5 }),
            at(70, "inference.decode.started", { request_id: "req-2", producer: INF_A, sequence: 6 }),
            at(90, "request.completed", { request_id: "req-2", producer: INF_A, sequence: 7 }),
        ]);

        expect(lifecycles).toHaveLength(2);
        const [r1, r2] = lifecycles;
        expect(r1!.status).toBe("cancelled");
        expect(r1!.lastActivePhase).toBe("decode");
        expect(r1!.transitions.map((t) => t.to)).toEqual(["prefill", "decode", "cancelled"]);
        expect(r2!.status).toBe("completed");
        expect(r2!.lastActivePhase).toBe("decode");
        expect(r2!.transitions.map((t) => t.to)).toEqual(["prefill", "decode", "completed"]);
    });

    it("opens a new generation when the same (stream, request_id) restarts after cancellation instead of blurring them", () => {
        const events = [
            at(0, "request.started", { request_id: "retry-1", producer: INF_A, sequence: 0 }),
            at(30, "inference.decode.started", { request_id: "retry-1", producer: INF_A, sequence: 1 }),
            at(50, "request.cancelled", { request_id: "retry-1", producer: INF_A, sequence: 2 }),
            at(154, "request.started", { request_id: "retry-1", producer: INF_A, sequence: 3 }),
            at(190, "inference.decode.started", { request_id: "retry-1", producer: INF_A, sequence: 4 }),
        ];
        const lifecycles = deriveRequestLifecycles(events);
        expect(lifecycles).toHaveLength(2);
        expect(lifecycles[0]).toMatchObject({
            requestId: "retry-1",
            generation: 0,
            status: "cancelled",
            cancelled: true,
            phase: "cancelled",
            lastActivePhase: "decode",
        });
        expect(lifecycles[0]!.transitions.map((t) => t.to)).toEqual(["prefill", "decode", "cancelled"]);
        expect(lifecycles[1]).toMatchObject({
            requestId: "retry-1",
            generation: 1,
            status: "active",
            cancelled: false,
            phase: "decode",
            lastActivePhase: "decode",
        });
        expect(lifecycles[1]!.transitions.map((t) => t.to)).toEqual(["prefill", "decode"]);
        expect(findRequestLifecycle(lifecycles, events[4]!)?.generation).toBe(1);
    });

    it("locks terminal cancelled state against straggler prefill/decode/token/completed events", () => {
        const lifecycles = deriveRequestLifecycles([
            at(0, "request.started", { request_id: "req-c", producer: INF_A, sequence: 0 }),
            at(20, "inference.decode.started", { request_id: "req-c", producer: INF_A, sequence: 1 }),
            at(40, "request.cancelled", { request_id: "req-c", producer: INF_A, sequence: 2 }),
            // Late stragglers that must never revert cancelled -> prefill/active/completed:
            at(41, "inference.prefill.started", { request_id: "req-c", producer: INF_A, sequence: 3 }),
            at(42, "inference.prefill.completed", { request_id: "req-c", producer: INF_A, sequence: 4 }),
            at(43, "inference.token.generated", { request_id: "req-c", producer: INF_A, sequence: 5 }),
            at(44, "scheduler.preempted", { request_id: "req-c", producer: INF_A, sequence: 6 }),
            at(45, "request.completed", { request_id: "req-c", producer: INF_A, sequence: 7 }),
            at(46, "request.failed", { request_id: "req-c", producer: INF_A, sequence: 8 }),
        ]);

        expect(lifecycles).toHaveLength(1);
        const r = lifecycles[0]!;
        expect(r.status).toBe("cancelled");
        expect(r.cancelled).toBe(true);
        expect(r.phase).toBe("cancelled");
        expect(r.endNs).toBe(40 * 1e6);
        expect(r.lateEventsAfterTerminal).toBe(6);
        expect(r.transitions.map((t) => t.to)).toEqual(["prefill", "decode", "cancelled"]);
    });

    it("never regresses decode -> prefill on late prefill/kv events, but allows explicit scheduler.preempted", () => {
        const lifecycles = deriveRequestLifecycles([
            at(0, "request.started", { request_id: "req-p", producer: INF_A, sequence: 0 }),
            at(10, "inference.decode.started", { request_id: "req-p", producer: INF_A, sequence: 1 }),
            at(15, "inference.prefill.completed", { request_id: "req-p", producer: INF_A, sequence: 2 }),
            at(16, "kv.allocated", { request_id: "req-p", producer: INF_A, sequence: 3 }),
            at(17, "inference.prefill.started", { request_id: "req-p", producer: INF_A, sequence: 4 }),
            // Explicit preemption legitimately moves active decode -> queued -> prefill -> decode:
            at(20, "scheduler.preempted", { request_id: "req-p", producer: INF_A, sequence: 5 }),
            at(30, "scheduler.admitted", { request_id: "req-p", producer: INF_A, sequence: 6 }),
            at(40, "inference.decode.started", { request_id: "req-p", producer: INF_A, sequence: 7 }),
        ]);

        expect(lifecycles[0]!.transitions.map((t) => `${t.from ?? "birth"}->${t.to}:${t.eventType}`)).toEqual([
            "birth->prefill:request.started",
            "prefill->decode:inference.decode.started",
            "decode->queued:scheduler.preempted",
            "queued->prefill:scheduler.admitted",
            "prefill->decode:inference.decode.started",
        ]);
    });

    it("isolates identical request_ids across distinct producer streams and ignores empty request_ids", () => {
        const lifecycles = deriveRequestLifecycles([
            at(0, "request.started", { request_id: "shared", producer: INF_A, sequence: 0 }),
            at(5, "request.started", { request_id: "shared", producer: INF_B, sequence: 0 }),
            at(10, "inference.decode.started", { request_id: "shared", producer: INF_A, sequence: 1 }),
            at(15, "request.cancelled", { request_id: "shared", producer: INF_A, sequence: 2 }),
            at(20, "inference.prefill.chunk", { request_id: "shared", producer: INF_B, sequence: 1 }),
            at(25, "request.started", { request_id: "", producer: INF_A, sequence: 3 }),
            at(26, "inference.decode.started", { request_id: null, producer: INF_A, sequence: 4 }),
        ]);

        expect(lifecycles).toHaveLength(2);
        const a = lifecycles.find((r) => r.nodeId === "node-a")!;
        const b = lifecycles.find((r) => r.nodeId === "node-b")!;
        expect(a.status).toBe("cancelled");
        expect(b.status).toBe("active");
        expect(b.phase).toBe("prefill");
    });

    it("handles live ring-buffer eviction cleanly without leaking evicted requests or mis-attributing partial ones", () => {
        const store = new SessionStore({ maxLiveEvents: 6 });
        store.reset("live", "http://127.0.0.1:11437/sse");

        store.append([
            at(0, "request.started", { request_id: "old-1", producer: INF_A, sequence: 0, event_id: "tel-aaaa-0" }),
            at(10, "request.completed", { request_id: "old-1", producer: INF_A, sequence: 1, event_id: "tel-aaaa-1" }),
            at(20, "request.started", { request_id: "mid-2", producer: INF_A, sequence: 2, event_id: "tel-aaaa-2" }),
            at(30, "inference.decode.started", { request_id: "mid-2", producer: INF_A, sequence: 3, event_id: "tel-aaaa-3" }),
        ]);
        expect(store.requestLifecycles.map((r) => r.requestId)).toEqual(["old-1", "mid-2"]);

        // Push enough events to evict old-1 and mid-2's request.started.
        store.append([
            at(40, "inference.token.generated", { request_id: "mid-2", producer: INF_A, sequence: 4, event_id: "tel-aaaa-4" }),
            at(50, "request.cancelled", { request_id: "mid-2", producer: INF_A, sequence: 5, event_id: "tel-aaaa-5" }),
            at(60, "request.started", { request_id: "new-3", producer: INF_A, sequence: 6, event_id: "tel-aaaa-6" }),
            at(70, "inference.prefill.started", { request_id: "new-3", producer: INF_A, sequence: 7, event_id: "tel-aaaa-7" }),
        ]);

        expect(store.droppedByRetention).toBeGreaterThan(0);
        const retained = store.requestLifecycles;
        expect(retained.some((r) => r.requestId === "old-1")).toBe(false);
        const mid = retained.find((r) => r.requestId === "mid-2")!;
        expect(mid).toMatchObject({ status: "cancelled", cancelled: true, partialStart: true });
        const fresh = retained.find((r) => r.requestId === "new-3")!;
        expect(fresh).toMatchObject({ status: "active", phase: "prefill", partialStart: false });
    });

    it("keeps intermediate SessionStore snapshots accurate even if a newer snapshot was queried first", () => {
        const store = new SessionStore();
        store.reset("live", "u");

        store.append([at(0, "request.started", { request_id: "r1", producer: INF_A, sequence: 0, event_id: "tel-aaaa-0" })]);
        const snap1 = store.events;
        // Prime cache on snap1.
        expect(deriveRequestLifecycles(snap1)[0]!.phase).toBe("prefill");

        store.append([at(10, "inference.decode.started", { request_id: "r1", producer: INF_A, sequence: 1, event_id: "tel-aaaa-1" })]);
        const snap2 = store.events; // NOT queried yet!

        store.append([at(20, "request.cancelled", { request_id: "r1", producer: INF_A, sequence: 2, event_id: "tel-aaaa-2" })]);
        const snap3 = store.events;

        // Query snap3 first (advances shared accumulator to length 3), then query skipped snap2!
        expect(deriveRequestLifecycles(snap3)[0]!.status).toBe("cancelled");
        expect(deriveRequestLifecycles(snap2)[0]!.status).toBe("active");
        expect(deriveRequestLifecycles(snap2)[0]!.phase).toBe("decode");
        expect(deriveRequestLifecycles(snap1)[0]!.phase).toBe("prefill");
    });

    it("bounds transitions per request under repeated preemption storms", () => {
        const events: ObservatoryEvent[] = [
            at(0, "request.started", { request_id: "storm", producer: INF_A, sequence: 0 }),
        ];
        for (let i = 0; i < 200; i += 1) {
            events.push(
                at(i * 3 + 1, "inference.decode.started", { request_id: "storm", producer: INF_A, sequence: i * 3 + 1 }),
                at(i * 3 + 2, "scheduler.preempted", { request_id: "storm", producer: INF_A, sequence: i * 3 + 2 }),
            );
        }
        const lifecycles = deriveRequestLifecycles(events);
        expect(lifecycles[0]!.transitions.length).toBeLessThanOrEqual(MAX_LIFECYCLE_TRANSITIONS);
        // Preserves the original birth transition at index 0.
        expect(lifecycles[0]!.transitions[0]!.from).toBeNull();
    });
});
