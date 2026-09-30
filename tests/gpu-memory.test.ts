/** Synthetic PR #35 shapes, not a captured inference run. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ObservatoryEvent } from "../src/protocol/events";
import { deriveGpuMemory, gpuMemorySample } from "../src/query/gpuMemory";
import { gpuMemoryAt } from "../src/query/gpuMemoryIndex";
import { deriveMetrics } from "../src/query/metrics";
import { parseNdjson } from "../src/recording/ndjson";
import { ReplayCursor } from "../src/replay/controller";
import { orderEvents } from "../src/replay/order";
import { SessionStore } from "../src/replay/session";
import { at } from "./helpers";

const fixtureText = readFileSync(new URL("./fixtures/sonder-inference-gpu.jsonl", import.meta.url), "utf8");
const sample = (ms: number, attributes: Record<string, unknown> = {}) => at(ms, "backend.gpu_memory.sample", { attributes: { backend: "llamaserver", ...attributes } });
const warning = (ms: number, attributes: Record<string, unknown> = {}) => at(ms, "backend.warning", { attributes: { backend: "llamaserver", code: "vram_spill", ...attributes } });

function fixture(): ObservatoryEvent[] {
    const parsed = parseNdjson(fixtureText);
    expect(parsed.rejected).toEqual([]);
    expect(parsed.events).toHaveLength(8);
    expect(parsed.events.every((e) => e.producer.synthetic === true)).toBe(true);
    return orderEvents(parsed.events).events;
}

describe("backend GPU telemetry", () => {
    it("derives clean samples, spill and recovery after auto_fit, plus reported warning occurrences", () => {
        const events = fixture();
        const result = deriveGpuMemory(events);
        expect(result.backends).toHaveLength(1);
        const b = result.backends[0]!;
        expect(b).toMatchObject({ backend: "llamaserver", instanceId: "tel-synthetic-gpu", nodeId: "node-synthetic", synthetic: true, fittedCtx: 84992 });
        expect(b.samples.map((s) => s.spilled)).toEqual([false, false, true, false]);
        expect(b.samples.map((s) => s.epoch)).toEqual([0, 0, 0, 1]);
        expect(b.samples.map((s) => s.spillLimitBytes)).toEqual([335544320, 335544320, 335544320, 335544320]);
        expect(b.latest).toMatchObject({ dedicatedBytes: 15032385536, sharedBytes: 201326592, spilled: false, fittedCtx: 84992 });
        expect(b.contextChanges.map((c) => [c.fittedCtx, c.fitOutcome])).toEqual([[100096, "not_needed"], [84992, "fitted"]]);
        expect(b.warnings.find((w) => w.code === "vram_spill")).toMatchObject({ count: 3, firstSeenNs: 4100000000, lastSeenNs: 5000000000, firstSeenWallTime: "2026-09-30T12:00:03.100Z", lastSeenWallTime: "2026-09-30T12:00:04.000Z" });
        expect(b.warnings.find((w) => w.code === "mtp_tensors_ignored")?.count).toBe(4);
    });

    it("uses strict shared > baseline + threshold only when the flag is absent", () => {
        expect(gpuMemorySample(sample(1, { shared_bytes: 320, shared_baseline_bytes: 64, spill_threshold_bytes: 256 }))?.spilled).toBe(false);
        expect(gpuMemorySample(sample(2, { shared_bytes: 321, shared_baseline_bytes: 64, spill_threshold_bytes: 256 }))?.spilled).toBe(true);
        expect(gpuMemorySample(sample(3, { shared_bytes: 257, spill_threshold_bytes: 256 }))?.spilled).toBe(true);
        expect(gpuMemorySample(sample(4, { shared_bytes: 999, spill_threshold_bytes: 256, spilled: false }))?.spilled).toBe(false);
        expect(gpuMemorySample(sample(5, { shared_bytes: 0, spilled: true }))?.spilled).toBe(true);
        expect(gpuMemorySample(sample(6, { shared_bytes: 999 }))?.spilled).toBeNull();
        expect(gpuMemorySample(sample(7, { shared_bytes: 999, shared_baseline_bytes: "0", spill_threshold_bytes: 256 }))?.spillLimitBytes).toBeNull();
    });

    it("preserves missing and invalid fields as unknown and accepts measured zeros", () => {
        expect(deriveGpuMemory([at(1, "device.memory.sample", { attributes: { used_bytes: 42, total_bytes: 100 } })])).toEqual({ backends: [] });
        expect(gpuMemorySample(sample(1))).toMatchObject({ dedicatedBytes: null, sharedBytes: null, spillLimitBytes: null, spilled: null, fittedCtx: null });
        for (const value of [null, "1024", -1, NaN, Infinity, 1.25, Number.MAX_SAFE_INTEGER + 1]) {
            expect(gpuMemorySample(sample(1, { dedicated_bytes: value, shared_bytes: value, spill_threshold_bytes: value, fitted_ctx: value }))).toMatchObject({ dedicatedBytes: null, sharedBytes: null, spillLimitBytes: null, fittedCtx: null });
        }
        expect(gpuMemorySample(sample(1, { dedicated_bytes: 0, shared_bytes: 0, spill_threshold_bytes: 0, samples: 1, status: "ok" }))).toMatchObject({ dedicatedBytes: 0, sharedBytes: 0, spillLimitBytes: 0, spilled: false });
        for (const status of ["not_sampled", "unsupported", "error", "disabled"]) {
            expect(gpuMemorySample(sample(1, { status, dedicated_bytes: 0, shared_bytes: 0, spilled: false }))).toMatchObject({ dedicatedBytes: null, sharedBytes: null, spilled: null });
        }
        expect(gpuMemorySample(sample(1, { status: "ok", samples: 0, dedicated_bytes: 0, shared_bytes: 0, spilled: false }))).toMatchObject({ dedicatedBytes: null, sharedBytes: null, spilled: null });
        expect(gpuMemorySample(warning(1))).toBeNull();
    });

    it("isolates backend and producer identities, including node and instance restarts", () => {
        const one = sample(1, { dedicated_bytes: 5 });
        const result = deriveGpuMemory([
            one,
            sample(2, { backend: "other", dedicated_bytes: 10 }),
            { ...sample(3), producer: { ...one.producer, instance_id: "new" } },
            { ...sample(4), producer: { ...one.producer, node_id: "other-node" } },
            { ...sample(5), session_id: "other-session" },
        ]);
        expect(result.backends).toHaveLength(5);
        expect(new Set(result.backends.map((b) => b.key)).size).toBe(5);
        expect(result.backends.every((b) => b.samples.length === 1)).toBe(true);
        // Stable producer instance spans request sessions, without splitting a backend.
        expect(deriveGpuMemory([one, { ...sample(6), session_id: "different" }].map((e) => ({ ...e, producer: { ...e.producer, instance_id: "same" } }))).backends).toHaveLength(1);
    });

    it("tracks explicit fitted context changes and does not turn missing fields into resets", () => {
        const b = deriveGpuMemory([sample(1, { fitted_ctx: 100096 }), sample(2), sample(3, { fitted_ctx: 100096 }), sample(4, { fitted_ctx: 84992, fit_outcome: "fitted" }), sample(5, { fitted_ctx: null })]).backends[0]!;
        expect(b.contextChanges.map((c) => c.fittedCtx)).toEqual([100096, 84992, null]);
        expect(b.fittedCtx).toBeNull();
        expect(deriveGpuMemory([sample(1, { fitted_ctx: 100096 }), sample(2)]).backends[0]?.fittedCtx).toBe(100096);
    });

    it("counts cumulative warning snapshots once per code/source/message and tolerates old count-less events", () => {
        const b = deriveGpuMemory([
            warning(1, { count: 4, message: "one", source: "log" }),
            warning(2, { count: 4, message: "one", source: "log" }),
            warning(3, { count: 6, message: "one", source: "log" }),
            warning(4, { count: 2, message: "one", source: "log" }),
            warning(5, { count: 3, message: "two", source: "log" }),
            warning(6, { code: "future_code" }), warning(7, { code: "future_code" }),
            warning(8, { code: null }),
        ]).backends[0]!;
        expect(b.warnings).toHaveLength(2);
        expect(b.warnings[0]).toMatchObject({ code: "vram_spill", count: 9, firstSeenNs: 1000000, lastSeenNs: 5000000 });
        expect(b.warnings[1]).toMatchObject({ code: "future_code", count: 2 });
        const unknown = deriveGpuMemory([warning(1)]).backends[0]!;
        expect(unknown.latest).toBeNull();
        expect(unknown.fittedCtx).toBeNull();
    });
});

describe("GPU replay/live index", () => {
    it("matches derivation at every cursor without future spill, context or warnings leaking backwards", () => {
        const events = fixture();
        for (const count of [0, 1, 4, 8, 7, 2, 6, 3, 5, 0, 8]) {
            expect(gpuMemoryAt(events, count)).toEqual(deriveGpuMemory(events.slice(0, count)));
        }
        const cursor = new ReplayCursor(events);
        cursor.seek(3e9);
        expect(gpuMemoryAt(cursor.events, cursor.visibleCount()).backends[0]?.latest?.spilled).toBe(true);
        cursor.seek(0);
        expect(gpuMemoryAt(cursor.events, cursor.visibleCount()).backends[0]?.latest).toBeNull();
        expect(gpuMemoryAt(events, -1)).toEqual({ backends: [] });
        expect(gpuMemoryAt(events, Infinity)).toEqual(deriveGpuMemory(events));
    });

    it("updates on live append, deduplicates via the store and expires evicted history", () => {
        const store = new SessionStore({ maxLiveEvents: 4 });
        store.reset("live", "synthetic GPU");
        const events = fixture();
        for (const e of events) {
            store.append([e, e]);
            const actual = gpuMemoryAt(store.events);
            expect(actual).toEqual(deriveGpuMemory(store.events));
            expect(actual.backends.reduce((n, b) => n + b.samples.length, 0)).toBeLessThanOrEqual(4);
        }
        expect(store.droppedByRetention).toBeGreaterThan(0);
        expect(gpuMemoryAt(store.events).backends[0]?.warnings.some((w) => w.code === "kv_kernel_f16_fallback")).toBe(false);
        store.append([at(20000, "request.started"), at(20001, "request.started"), at(20002, "request.started"), at(20003, "request.started")]);
        expect(gpuMemoryAt(store.events)).toEqual({ backends: [] });
        store.reset("live", "replacement");
        expect(gpuMemoryAt(store.events)).toEqual({ backends: [] });
    });

    it("rebuilds on out-of-order merges and reuses results for token-only prefix appends", () => {
        const store = new SessionStore();
        const events = fixture();
        store.append(events.slice(0, 2));
        const before = gpuMemoryAt(store.events);
        const old = store.events;
        store.append([at(2500, "inference.token.generated")]);
        expect(gpuMemoryAt(store.events)).toBe(before);
        store.append(events.slice(2));
        expect(gpuMemoryAt(old)).toEqual(before);
        store.append([sample(1500, { dedicated_bytes: 42 })]);
        expect(gpuMemoryAt(store.events)).toEqual(deriveGpuMemory(store.events));
    });

    it("keeps existing metrics unchanged when GPU queries run", () => {
        const events = fixture();
        const before = deriveMetrics(events);
        const wire = JSON.stringify(events);
        gpuMemoryAt(events);
        deriveGpuMemory(events);
        expect(deriveMetrics(events)).toEqual(before);
        expect(JSON.stringify(events)).toBe(wire);
    });
});
