/** Synthetic PR #35 shapes, not a captured inference run. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ObservatoryEvent } from "../src/protocol/events";
import { deriveGpuMemory, deriveNodeGpuMemory, gpuMemorySample, nodeGpuDeviceSample } from "../src/query/gpuMemory";
import { gpuMemoryAt, nodeGpuMemoryAt } from "../src/query/gpuMemoryIndex";
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

describe("per-node multi-GPU VRAM inventory (discrete vs integrated UMA + combined pool)", () => {
    const MIB = 1024 * 1024;
    const GIB = 1024 * MIB;
    const node1Producer = { name: "sonder-inference", version: "0.4.0", node_id: "NODE1", instance_id: "tel-node1", synthetic: false };
    const wsProducer = { name: "sonder-inference", version: "0.4.0", node_id: "workstation", instance_id: "tel-ws", synthetic: false };

    const gpuSample = (
        ms: number,
        producer: typeof node1Producer,
        deviceId: string,
        attributes: Record<string, unknown>,
    ): ObservatoryEvent =>
        at(ms, "device.memory.sample", {
            producer,
            device_id: deviceId,
            attributes: { kind: "gpu", ...attributes },
        });

    it("distinguishes discrete GPU vs integrated UMA across dual-PC nodes and detects active combined VRAM pool", () => {
        const events: ObservatoryEvent[] = [
            // Workstation: discrete RTX 5070 Ti (16 GiB)
            gpuSample(100, wsProducer, "gpu:0", {
                name: "NVIDIA GeForce RTX 5070 Ti",
                vendor: "nvidia",
                is_integrated_uma: false,
                backend_hint: "cuda",
                source: "dxgi",
                dedicated_total_bytes: 16303 * MIB,
                total_bytes: 16303 * MIB,
                dedicated_free_bytes: 4303 * MIB,
                available_bytes: 4303 * MIB,
                used_bytes: 12000 * MIB,
                shared_total_bytes: 16 * GIB,
                effective_vram_mib: 16303,
                effective_free_vram_mib: 4303,
            }),
            // NODE1 gpu:0: discrete RX 9060 XT (16 GiB, carrying 15.2 GiB weights)
            gpuSample(110, node1Producer, "gpu:0", {
                name: "AMD Radeon RX 9060 XT",
                vendor: "amd",
                is_integrated_uma: false,
                backend_hint: "vulkan",
                source: "dxgi",
                dedicated_total_bytes: 16288 * MIB,
                total_bytes: 16288 * MIB,
                dedicated_free_bytes: 720 * MIB,
                available_bytes: 720 * MIB,
                used_bytes: 15568 * MIB,
                shared_total_bytes: 32 * GIB,
                effective_vram_mib: 16288,
                effective_free_vram_mib: 720,
            }),
            // NODE1 gpu:1: integrated Radeon 780M UMA (512 MiB BIOS carveout + 31.3 GiB GTT; total/available/used omitted like Sonder-Inference)
            gpuSample(120, node1Producer, "gpu:1", {
                name: "AMD Radeon 780M Graphics",
                vendor: "amd",
                is_integrated_uma: true,
                backend_hint: "vulkan",
                source: "dxgi",
                dedicated_total_bytes: 512 * MIB,
                dedicated_free_bytes: 13728 * MIB,
                shared_total_bytes: 32064 * MIB,
                effective_vram_mib: 32576,
                effective_free_vram_mib: 13728,
            }),
        ];

        const multi = deriveNodeGpuMemory(events);
        expect(multi.nodes).toHaveLength(2);

        const ws = multi.nodes.find((n) => n.nodeId === "workstation")!;
        expect(ws.devices).toHaveLength(1);
        expect(ws.devices[0]).toMatchObject({
            deviceId: "gpu:0",
            name: "NVIDIA GeForce RTX 5070 Ti",
            gpuClass: "discrete",
            carryingModelWeights: true,
        });
        expect(ws.combinedPool).toBeNull();

        const node1 = multi.nodes.find((n) => n.nodeId === "NODE1")!;
        expect(node1.devices).toHaveLength(2);
        const discrete = node1.devices.find((d) => d.deviceId === "gpu:0")!;
        const uma = node1.devices.find((d) => d.deviceId === "gpu:1")!;

        expect(discrete.gpuClass).toBe("discrete");
        expect(discrete.latest?.effectiveTotalBytes).toBe(16288 * MIB);
        expect(discrete.latest?.effectiveUsedBytes).toBe(15568 * MIB);
        expect(discrete.carryingModelWeights).toBe(true);

        expect(uma.gpuClass).toBe("integrated-uma");
        expect(uma.latest?.dedicatedTotalBytes).toBe(512 * MIB);
        expect(uma.latest?.sharedTotalBytes).toBe(32064 * MIB);
        expect(uma.latest?.effectiveTotalBytes).toBe(32576 * MIB);
        expect(uma.latest?.effectiveFreeBytes).toBe(13728 * MIB);
        expect(uma.latest?.effectiveUsedBytes).toBe((32576 - 13728) * MIB);
        expect(uma.carryingModelWeights).toBe(true);

        expect(node1.combinedPool).not.toBeNull();
        expect(node1.combinedPool).toMatchObject({
            discreteCount: 1,
            integratedUmaCount: 1,
            isHybridDiscreteUma: true,
            bothCarryingWeights: true,
            multiGpuActive: true,
            weightsEvidence: "observed-vram",
            discreteTotalBytes: 16288 * MIB,
            discreteUsedBytes: 15568 * MIB,
            umaTotalBytes: 32576 * MIB,
            umaUsedBytes: 18848 * MIB,
            combinedTotalBytes: (16288 + 32576) * MIB,
            combinedUsedBytes: (15568 + 18848) * MIB,
        });
    });

    it("distinguishes hybrid pool available vs active when only the discrete GPU carries weights", () => {
        const events: ObservatoryEvent[] = [
            gpuSample(10, node1Producer, "gpu:0", {
                name: "AMD Radeon RX 9060 XT",
                is_integrated_uma: false,
                dedicated_total_bytes: 16 * GIB,
                dedicated_free_bytes: 6 * GIB,
            }),
            gpuSample(20, node1Producer, "gpu:1", {
                name: "AMD Radeon 780M Graphics",
                is_integrated_uma: true,
                dedicated_total_bytes: 512 * MIB,
                shared_total_bytes: 32 * GIB,
                effective_vram_mib: 512 + 32768,
                // Only 128 MiB in use (desktop compositor idle), well below model weight threshold.
                effective_free_vram_mib: 512 + 32768 - 128,
            }),
        ];
        const pool = deriveNodeGpuMemory(events).nodes[0]!.combinedPool!;
        expect(pool.isHybridDiscreteUma).toBe(true);
        expect(pool.bothCarryingWeights).toBe(false);
        expect(pool.multiGpuActive).toBe(false);
        expect(pool.weightsEvidence).toBe("none");
    });

    it("honors explicit carrying_model_weights, active_devices, and combined_gpu_vram_mib metadata", () => {
        const events: ObservatoryEvent[] = [
            at(5, "model.load.completed", {
                producer: node1Producer,
                attributes: {
                    model: "qwen3-80b-moe",
                    resident: true,
                    combined_gpu_vram_mib: 48864,
                    recommended_devices: ["Vulkan0", "Vulkan1"],
                },
            }),
            gpuSample(10, node1Producer, "gpu:0", {
                name: "AMD Radeon RX 9060 XT",
                is_integrated_uma: false,
                effective_vram_mib: 16288,
                effective_free_vram_mib: 16100,
                carrying_model_weights: true,
                model_weights_bytes: 10 * GIB,
            }),
            gpuSample(20, node1Producer, "gpu:1", {
                name: "AMD Radeon 780M Graphics",
                is_integrated_uma: true,
                effective_vram_mib: 32576,
                effective_free_vram_mib: 32400,
                carrying_model_weights: true,
                model_weights_bytes: 20 * GIB,
            }),
        ];
        const node = deriveNodeGpuMemory(events).nodes[0]!;
        expect(node.combinedPool).toMatchObject({
            bothCarryingWeights: true,
            weightsEvidence: "reported",
            activeDevices: ["Vulkan0", "Vulkan1"],
            reportedCombinedTotalBytes: 48864 * MIB,
        });

        // Planner-only recommended_devices (or resident:false metadata load) must NOT falsely claim weights are resident on idle GPUs.
        const plannedOnly = deriveNodeGpuMemory([
            at(1, "model.load.completed", {
                producer: node1Producer,
                attributes: { model: "qwen3-80b-moe", resident: false, recommended_devices: ["Vulkan0", "Vulkan1"] },
            }),
            gpuSample(10, node1Producer, "gpu:0", { name: "RX 9060 XT", is_integrated_uma: false, effective_vram_mib: 16288, effective_free_vram_mib: 16188, recommended_devices: ["Vulkan0", "Vulkan1"] }),
            gpuSample(20, node1Producer, "gpu:1", { name: "Radeon 780M", is_integrated_uma: true, effective_vram_mib: 32576, effective_free_vram_mib: 32476 }),
        ]).nodes[0]!;
        expect(plannedOnly.combinedPool?.bothCarryingWeights).toBe(false);
        expect(plannedOnly.combinedPool?.activeDevices).toEqual(["Vulkan0", "Vulkan1"]);
    });

    it("ignores legacy kind=vram / kind=cpu samples and refuses to fabricate totals on partial or anomalous readings", () => {
        expect(
            deriveNodeGpuMemory([
                at(1, "device.memory.sample", { device_id: "dev_gpu0", attributes: { kind: "vram", used_bytes: 100, total_bytes: 200 } }),
                at(2, "device.memory.sample", { device_id: "cpu:0", attributes: { kind: "cpu", total_bytes: 32 * GIB, available_bytes: 16 * GIB } }),
            ]),
        ).toEqual({ nodes: [] });

        // Anomalous free > total must yield null used bytes (never negative).
        const anomalous = nodeGpuDeviceSample(
            gpuSample(1, node1Producer, "gpu:0", {
                name: "RX 9060 XT",
                is_integrated_uma: false,
                dedicated_total_bytes: 16 * GIB,
                dedicated_free_bytes: 17 * GIB,
            }),
        )!;
        expect(anomalous.effectiveFreeBytes).toBeNull();
        expect(anomalous.effectiveUsedBytes).toBeNull();

        // One known GPU + one unknown GPU must NOT report the single known GPU as the combined total.
        const partial = deriveNodeGpuMemory([
            gpuSample(1, node1Producer, "gpu:0", { name: "RX 9060 XT", is_integrated_uma: false, dedicated_total_bytes: 16 * GIB, dedicated_free_bytes: 8 * GIB }),
            gpuSample(2, node1Producer, "gpu:1", { name: "Unknown APU", is_integrated_uma: true }),
        ]).nodes[0]!;
        expect(partial.combinedPool?.combinedTotalBytes).toBeNull();
        expect(partial.combinedPool?.combinedUsedBytes).toBeNull();
        expect(partial.combinedPool?.discreteTotalBytes).toBe(16 * GIB);
        expect(partial.combinedPool?.umaTotalBytes).toBeNull();
    });

    it("nodeGpuMemoryAt matches deriveNodeGpuMemory across cursors, prefix appends, eviction, and out-of-order merges", () => {
        const events = orderEvents([
            gpuSample(10, node1Producer, "gpu:0", { name: "RX 9060 XT", is_integrated_uma: false, dedicated_total_bytes: 16 * GIB, dedicated_free_bytes: 15 * GIB }),
            at(15, "inference.token.generated", { producer: node1Producer }),
            gpuSample(20, node1Producer, "gpu:1", { name: "Radeon 780M", is_integrated_uma: true, effective_vram_mib: 32576, effective_free_vram_mib: 20000 }),
            gpuSample(30, node1Producer, "gpu:0", { name: "RX 9060 XT", is_integrated_uma: false, dedicated_total_bytes: 16 * GIB, dedicated_free_bytes: 1 * GIB }),
        ]).events;

        for (const c of [0, 1, 2, 3, 4, 2, 1, 4]) {
            expect(nodeGpuMemoryAt(events, c)).toEqual(deriveNodeGpuMemory(events.slice(0, c)));
        }

        const store = new SessionStore({ maxLiveEvents: 3 });
        store.reset("live", "multi-gpu");
        store.append(events.slice(0, 1));
        const before = nodeGpuMemoryAt(store.events);
        store.append([at(12, "inference.token.generated", { producer: node1Producer })]);
        // Token-only prefix append reuses exact cached result.
        expect(nodeGpuMemoryAt(store.events)).toBe(before);
        // Out-of-order and eviction stay exact.
        store.append(events.slice(2));
        expect(nodeGpuMemoryAt(store.events)).toEqual(deriveNodeGpuMemory(store.events));
        store.append([at(5, "device.memory.sample", { producer: node1Producer, device_id: "gpu:0", attributes: { kind: "gpu", name: "RX 9060 XT", is_integrated_uma: false, dedicated_total_bytes: 16 * GIB, dedicated_free_bytes: 14 * GIB } })]);
        expect(nodeGpuMemoryAt(store.events)).toEqual(deriveNodeGpuMemory(store.events));
    });
});
