/**
 * Hybrid Multi-GPU `backend.gpu_memory.sample` keying & UMA vs discrete GDDR
 * spill semantics (`src/query/gpuMemory.ts` and `src/query/gpuMemoryIndex.ts`).
 *
 * Covers single discrete GPU, pure integrated UMA GPU, and hybrid discrete +
 * integrated UMA multi-GPU hosts (e.g. Node1 RX 9060 XT + Radeon 780M).
 */
import { describe, expect, it } from "vitest";
import type { ObservatoryEvent } from "../../src/protocol/events";
import { deriveGpuMemory, gpuMemorySample } from "../../src/query/gpuMemory";
import { gpuMemoryAt } from "../../src/query/gpuMemoryIndex";
import { orderEvents } from "../../src/replay/order";
import { SessionStore } from "../../src/replay/session";
import { at } from "../helpers";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const node1 = { name: "sonder-inference", version: "0.4.0", node_id: "NODE1", instance_id: "tel-node1", synthetic: false };
const ws = { name: "sonder-inference", version: "0.4.0", node_id: "workstation", instance_id: "tel-ws", synthetic: false };
const apuHost = { name: "sonder-inference", version: "0.4.0", node_id: "apu-mini", instance_id: "tel-apu", synthetic: false };

function backendSample(
    ms: number,
    producer: typeof node1,
    deviceId: string | null,
    attributes: Record<string, unknown>,
): ObservatoryEvent {
    const envelope: Partial<ObservatoryEvent> = {
        producer,
        attributes: { backend: "llamaserver", probe: "pdh", status: "ok", ...attributes },
    };
    if (deviceId !== null) {
        envelope.device_id = deviceId;
    }
    return at(ms, "backend.gpu_memory.sample", envelope);
}

function gpuDeviceSample(
    ms: number,
    producer: typeof node1,
    deviceId: string,
    attributes: Record<string, unknown>,
): ObservatoryEvent {
    return at(ms, "device.memory.sample", {
        producer,
        device_id: deviceId,
        attributes: { kind: "gpu", ...attributes },
    });
}

describe("hybrid multi-GPU backend.gpu_memory.sample keying", () => {
    it("isolates per-GPU samples on a multi-GPU host by (producer, node, instance, backend, device_id)", () => {
        const events = [
            backendSample(100, node1, "gpu:0", {
                name: "AMD Radeon RX 9060 XT",
                is_integrated_uma: false,
                dedicated_bytes: 15 * GIB,
                shared_bytes: 128 * MIB,
                spill_threshold_bytes: 256 * MIB,
                samples: 1,
                fitted_ctx: 65536,
            }),
            backendSample(110, node1, "gpu:1", {
                name: "AMD Radeon 780M Graphics",
                is_integrated_uma: true,
                dedicated_bytes: 512 * MIB,
                shared_bytes: 24 * GIB,
                spill_threshold_bytes: 256 * MIB,
                samples: 1,
                fitted_ctx: 65536,
            }),
            backendSample(200, node1, "gpu:0", {
                name: "AMD Radeon RX 9060 XT",
                is_integrated_uma: false,
                dedicated_bytes: 15.5 * GIB,
                shared_bytes: 512 * MIB,
                spill_threshold_bytes: 256 * MIB,
                samples: 2,
                fitted_ctx: 65536,
            }),
            backendSample(210, node1, "gpu:1", {
                name: "AMD Radeon 780M Graphics",
                is_integrated_uma: true,
                dedicated_bytes: 512 * MIB,
                shared_bytes: 25 * GIB,
                spill_threshold_bytes: 256 * MIB,
                samples: 2,
                fitted_ctx: 65536,
            }),
            // Distinct host with same device_id "gpu:0" must stay isolated.
            backendSample(220, ws, "gpu:0", {
                name: "NVIDIA GeForce RTX 5070 Ti",
                is_integrated_uma: false,
                dedicated_bytes: 12 * GIB,
                shared_bytes: 96 * MIB,
                spill_threshold_bytes: 256 * MIB,
                samples: 1,
            }),
        ];

        const metrics = deriveGpuMemory(events);
        expect(metrics.backends).toHaveLength(3);
        expect(new Set(metrics.backends.map((b) => b.key)).size).toBe(3);

        const rx9060 = metrics.backends.find((b) => b.nodeId === "NODE1" && b.deviceId === "gpu:0")!;
        const r780m = metrics.backends.find((b) => b.nodeId === "NODE1" && b.deviceId === "gpu:1")!;
        const rtx = metrics.backends.find((b) => b.nodeId === "workstation" && b.deviceId === "gpu:0")!;

        expect(rx9060.samples).toHaveLength(2);
        expect(rx9060.samples.map((s) => s.epoch)).toEqual([0, 0]);
        expect(rx9060.latest?.dedicatedBytes).toBe(15.5 * GIB);
        expect(rx9060.latest?.spilled).toBe(true);
        expect(rx9060.memoryMode).toBe("discrete-gddr");
        expect(rx9060.gpuClass).toBe("discrete");

        expect(r780m.samples).toHaveLength(2);
        expect(r780m.samples.map((s) => s.epoch)).toEqual([0, 0]);
        expect(r780m.latest?.sharedBytes).toBe(25 * GIB);
        expect(r780m.latest?.spilled).toBe(false);
        expect(r780m.memoryMode).toBe("integrated-uma");
        expect(r780m.gpuClass).toBe("integrated-uma");

        expect(rtx.samples).toHaveLength(1);
        expect(rtx.latest?.dedicatedBytes).toBe(12 * GIB);
        expect(rtx.latest?.spilled).toBe(false);
    });

    it("accepts string attributes.device_id when envelope device_id is absent, and ignores numeric PCI device_id", () => {
        const strAttr = deriveGpuMemory([
            backendSample(10, node1, null, { device_id: "Vulkan0", is_integrated_uma: false, dedicated_bytes: 10 * GIB, shared_bytes: 64 * MIB, spill_threshold_bytes: 256 * MIB }),
            backendSample(20, node1, null, { device_id: "Vulkan1", is_integrated_uma: true, dedicated_bytes: 512 * MIB, shared_bytes: 18 * GIB, spill_threshold_bytes: 256 * MIB }),
        ]);
        expect(strAttr.backends).toHaveLength(2);
        expect(strAttr.backends.map((b) => b.deviceId)).toEqual(["Vulkan0", "Vulkan1"]);

        const numericPci = deriveGpuMemory([
            backendSample(10, node1, null, { device_id: 0x7590, dedicated_bytes: 10 * GIB, shared_bytes: 64 * MIB }),
        ]);
        expect(numericPci.backends[0]!.deviceId).toBeNull();
    });
});

describe("UMA & hybrid UMA spill semantics in gpuMemorySample", () => {
    it("never marks intentional integrated UMA or hybrid UMA shared memory as spilled", () => {
        const umaCases: Record<string, unknown>[] = [
            { is_integrated_uma: true, shared_bytes: 24 * GIB, spill_threshold_bytes: 256 * MIB },
            // Even if an unpatched probe sent spilled: true on an integrated UMA device.
            { is_integrated_uma: true, shared_bytes: 24 * GIB, spill_threshold_bytes: 256 * MIB, spilled: true },
            { uma_mode: true, shared_bytes: 25 * GIB, spill_threshold_bytes: 256 * MIB },
            { uma_mode: "on", shared_bytes: 25 * GIB, spill_threshold_bytes: 256 * MIB },
            { uma_mode: "hybrid", shared_bytes: 25 * GIB, spill_threshold_bytes: 256 * MIB, spilled: true },
            { hybrid_uma: true, shared_bytes: 25 * GIB, spill_threshold_bytes: 256 * MIB },
            { memory_kind: "uma", shared_bytes: 20 * GIB, spill_threshold_bytes: 256 * MIB },
            { memory_kind: "hybrid_uma", shared_bytes: 22 * GIB, spill_threshold_bytes: 256 * MIB },
            { memory_kind: "unified", shared_bytes: 18 * GIB, spill_threshold_bytes: 256 * MIB },
            { gpu_memory_kind: "gtt", shared_bytes: 16 * GIB, spill_threshold_bytes: 256 * MIB },
        ];
        for (const [idx, attrs] of umaCases.entries()) {
            const s = gpuMemorySample(backendSample(idx * 10, node1, "gpu:1", attrs))!;
            expect(s.spilled, JSON.stringify(attrs)).toBe(false);
            expect(s.umaIntentionalShared, JSON.stringify(attrs)).toBe(true);
            expect(["integrated-uma", "hybrid-uma"]).toContain(s.memoryMode);
        }
    });

    it("preserves genuine discrete GDDR spill detection and explicit discrete_spilled override", () => {
        const discreteSpill = gpuMemorySample(
            backendSample(10, ws, "gpu:0", {
                is_integrated_uma: false,
                dedicated_bytes: 15.5 * GIB,
                shared_bytes: 600 * MIB,
                shared_baseline_bytes: 64 * MIB,
                spill_threshold_bytes: 256 * MIB,
            }),
        )!;
        expect(discreteSpill.memoryMode).toBe("discrete-gddr");
        expect(discreteSpill.umaIntentionalShared).toBe(false);
        expect(discreteSpill.spilled).toBe(true);

        const discreteOff = gpuMemorySample(
            backendSample(20, ws, "gpu:0", {
                uma_mode: "off",
                shared_bytes: 600 * MIB,
                spill_threshold_bytes: 256 * MIB,
            }),
        )!;
        expect(discreteOff.memoryMode).toBe("discrete-gddr");
        expect(discreteOff.spilled).toBe(true);

        // Explicit per-adapter discrete_spilled: true on a hybrid sample still signals spill.
        const hybridExplicitDiscreteSpill = gpuMemorySample(
            backendSample(30, node1, null, {
                uma_mode: "hybrid",
                shared_bytes: 25 * GIB,
                discrete_spilled: true,
            }),
        )!;
        expect(hybridExplicitDiscreteSpill.memoryMode).toBe("hybrid-uma");
        expect(hybridExplicitDiscreteSpill.spilled).toBe(true);

        // Unusable probe on UMA never fabricates spilled: false.
        const failedProbe = gpuMemorySample(
            backendSample(40, apuHost, "gpu:0", {
                status: "error",
                is_integrated_uma: true,
                shared_bytes: 10 * GIB,
                spill_threshold_bytes: 256 * MIB,
            }),
        )!;
        expect(failedProbe.spilled).toBeNull();
        expect(failedProbe.sharedBytes).toBeNull();
    });
});

describe("cross-event device.memory.sample correlation and gpuMemoryAt parity", () => {
    it("correlates per-device and host-level backend.gpu_memory.sample against device.memory.sample without masking discrete-only spills", () => {
        // 1. Pure iGPU UMA host (Ryzen 780M only): process-level backend sample omits UMA flags.
        const pureUmaEvents = orderEvents([
            gpuDeviceSample(10, apuHost, "gpu:0", {
                name: "AMD Radeon 780M Graphics",
                vendor: "amd",
                is_integrated_uma: true,
                backend_hint: "vulkan",
                dedicated_total_bytes: 512 * MIB,
                shared_total_bytes: 31 * GIB,
                effective_vram_mib: 512 + 31 * 1024,
                effective_free_vram_mib: 12 * 1024,
            }),
            backendSample(20, apuHost, null, {
                dedicated_bytes: 512 * MIB,
                shared_bytes: 19 * GIB,
                spill_threshold_bytes: 256 * MIB,
                samples: 1,
            }),
        ]).events;
        const pureUma = deriveGpuMemory(pureUmaEvents);
        expect(pureUma.backends).toHaveLength(1);
        expect(pureUma.backends[0]!.memoryMode).toBe("integrated-uma");
        expect(pureUma.backends[0]!.deviceName).toBe("AMD Radeon 780M Graphics");
        expect(pureUma.backends[0]!.latest?.spilled).toBe(false);
        expect(pureUma.backends[0]!.latest?.umaIntentionalShared).toBe(true);
        expect(pureUma.backends[0]!.effectiveTotalBytes).toBe((512 + 31 * 1024) * MIB);

        // 2. Hybrid Node1 (RX 9060 XT + Radeon 780M) with BOTH GPUs active: process-level sample is hybrid-uma (NOT spilled).
        const hybridActiveEvents = orderEvents([
            gpuDeviceSample(10, node1, "gpu:0", {
                name: "AMD Radeon RX 9060 XT",
                vendor: "amd",
                is_integrated_uma: false,
                backend_hint: "vulkan",
                dedicated_total_bytes: 16 * GIB,
                dedicated_free_bytes: 1 * GIB,
            }),
            gpuDeviceSample(15, node1, "gpu:1", {
                name: "AMD Radeon 780M Graphics",
                vendor: "amd",
                is_integrated_uma: true,
                backend_hint: "vulkan",
                dedicated_total_bytes: 512 * MIB,
                shared_total_bytes: 31 * GIB,
                effective_vram_mib: 512 + 31 * 1024,
                effective_free_vram_mib: 10 * 1024,
            }),
            at(18, "model.load.completed", {
                producer: node1,
                attributes: { model: "qwen3-80b-moe", resident: true, active_devices: ["Vulkan0", "Vulkan1"] },
            }),
            backendSample(25, node1, null, {
                dedicated_bytes: 15 * GIB,
                shared_bytes: 22 * GIB,
                spill_threshold_bytes: 256 * MIB,
                samples: 1,
            }),
        ]).events;
        const hybridActive = deriveGpuMemory(hybridActiveEvents);
        expect(hybridActive.backends).toHaveLength(1);
        expect(hybridActive.backends[0]!.memoryMode).toBe("hybrid-uma");
        expect(hybridActive.backends[0]!.latest?.spilled).toBe(false);
        expect(hybridActive.backends[0]!.latest?.umaIntentionalShared).toBe(true);

        // 3. Hybrid Node1 running DISCRETE-ONLY (780M idle): process-level spill MUST still trigger!
        const hybridDiscreteOnlyEvents = orderEvents([
            gpuDeviceSample(10, node1, "gpu:0", {
                name: "AMD Radeon RX 9060 XT",
                vendor: "amd",
                is_integrated_uma: false,
                backend_hint: "vulkan",
                dedicated_total_bytes: 16 * GIB,
                dedicated_free_bytes: 512 * MIB,
            }),
            gpuDeviceSample(15, node1, "gpu:1", {
                name: "AMD Radeon 780M Graphics",
                vendor: "amd",
                is_integrated_uma: true,
                backend_hint: "vulkan",
                dedicated_total_bytes: 512 * MIB,
                shared_total_bytes: 31 * GIB,
                effective_vram_mib: 512 + 31 * 1024,
                // Idle compositor usage only (128 MiB).
                effective_free_vram_mib: 512 + 31 * 1024 - 128,
            }),
            backendSample(25, node1, null, {
                dedicated_bytes: 15.5 * GIB,
                shared_bytes: 768 * MIB,
                spill_threshold_bytes: 256 * MIB,
                samples: 1,
            }),
        ]).events;
        const hybridDiscreteOnly = deriveGpuMemory(hybridDiscreteOnlyEvents);
        expect(hybridDiscreteOnly.backends[0]!.latest?.spilled).toBe(true);

        // 4. Per-device Vulkan1 / Vulkan0 correlation on hybrid host without repeating is_integrated_uma on backend samples.
        const perVulkanEvents = orderEvents([
            gpuDeviceSample(10, node1, "gpu:0", {
                name: "AMD Radeon RX 9060 XT",
                vendor: "amd",
                is_integrated_uma: false,
                backend_hint: "vulkan",
                dedicated_total_bytes: 16 * GIB,
                dedicated_free_bytes: 512 * MIB,
            }),
            gpuDeviceSample(15, node1, "gpu:1", {
                name: "AMD Radeon 780M Graphics",
                vendor: "amd",
                is_integrated_uma: true,
                backend_hint: "vulkan",
                dedicated_total_bytes: 512 * MIB,
                shared_total_bytes: 31 * GIB,
                effective_vram_mib: 512 + 31 * 1024,
                effective_free_vram_mib: 12 * 1024,
            }),
            backendSample(20, node1, "Vulkan0", {
                dedicated_bytes: 15.5 * GIB,
                shared_bytes: 600 * MIB,
                spill_threshold_bytes: 256 * MIB,
                samples: 1,
            }),
            backendSample(25, node1, "Vulkan1", {
                dedicated_bytes: 512 * MIB,
                shared_bytes: 20 * GIB,
                spill_threshold_bytes: 256 * MIB,
                samples: 1,
            }),
        ]).events;
        const perVulkan = deriveGpuMemory(perVulkanEvents);
        expect(perVulkan.backends).toHaveLength(2);
        const v0 = perVulkan.backends.find((b) => b.deviceId === "Vulkan0")!;
        const v1 = perVulkan.backends.find((b) => b.deviceId === "Vulkan1")!;
        expect(v0.memoryMode).toBe("discrete-gddr");
        expect(v0.deviceName).toBe("AMD Radeon RX 9060 XT");
        expect(v0.latest?.spilled).toBe(true);
        expect(v1.memoryMode).toBe("integrated-uma");
        expect(v1.deviceName).toBe("AMD Radeon 780M Graphics");
        expect(v1.latest?.spilled).toBe(false);

        // 5. gpuMemoryAt index parity at every cursor + live token append caching.
        for (let c = 0; c <= perVulkanEvents.length; c += 1) {
            expect(gpuMemoryAt(perVulkanEvents, c)).toEqual(deriveGpuMemory(perVulkanEvents.slice(0, c)));
        }
        const store = new SessionStore();
        store.reset("live", "hybrid-parity");
        store.append(perVulkanEvents.slice(0, 3));
        const cached = gpuMemoryAt(store.events);
        store.append([at(22, "inference.token.generated", { producer: node1 })]);
        expect(gpuMemoryAt(store.events)).toBe(cached);
        store.append(perVulkanEvents.slice(3));
        expect(gpuMemoryAt(store.events)).toEqual(deriveGpuMemory(store.events));
    });
});
