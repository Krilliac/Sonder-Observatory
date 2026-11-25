/**
 * Resource pressure detector tests for UMA vs discrete GDDR spill semantics
 * (`src/diagnostics/detectors/resource.ts`).
 *
 * Verifies:
 * - Single discrete GPU genuine VRAM spills trigger `resource-pressure` findings.
 * - Pure iGPU UMA intentional shared pools do NOT trigger false VRAM spill findings
 *   and BIOS carveout usage does not falsely trigger when the unified pool is healthy.
 * - Genuine iGPU UMA pool exhaustion STILL triggers `resource-pressure`.
 * - Hybrid discrete + iGPU UMA hosts (Node1 RX 9060 XT + Radeon 780M) suppress false
 *   VRAM spill findings on intentional hybrid UMA usage while still detecting genuine
 *   discrete VRAM spills and isolating multi-node `device_id` series.
 */
import { describe, expect, it } from "vitest";
import type { ObservatoryEvent } from "../../src/protocol/events";
import { at } from "../helpers";
import { assertEvidence, detect, runDiagnostics } from "./helpers";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const node1 = { name: "sonder-inference", version: "0.4.0", node_id: "NODE1", instance_id: "tel-node1", synthetic: false };
const ws = { name: "sonder-inference", version: "0.4.0", node_id: "workstation", instance_id: "tel-ws", synthetic: false };
const apuHost = { name: "sonder-inference", version: "0.4.0", node_id: "apu-mini", instance_id: "tel-apu", synthetic: false };

describe("resource-pressure detector — UMA vs discrete GDDR spill semantics", () => {
    it("triggers warning/critical VRAM spill findings on genuine single discrete GPU spills", () => {
        const events: ObservatoryEvent[] = [
            at(100, "backend.gpu_memory.sample", {
                producer: ws,
                device_id: "gpu:0",
                attributes: {
                    backend: "llamaserver",
                    is_integrated_uma: false,
                    dedicated_bytes: 15.2 * GIB,
                    shared_bytes: 128 * MIB,
                    spill_threshold_bytes: 256 * MIB,
                    samples: 1,
                },
            }),
            at(200, "backend.gpu_memory.sample", {
                producer: ws,
                device_id: "gpu:0",
                attributes: {
                    backend: "llamaserver",
                    is_integrated_uma: false,
                    dedicated_bytes: 15.8 * GIB,
                    shared_bytes: 384 * MIB,
                    spill_threshold_bytes: 256 * MIB,
                    samples: 2,
                },
            }),
            at(300, "backend.gpu_memory.sample", {
                producer: ws,
                device_id: "gpu:0",
                attributes: {
                    backend: "llamaserver",
                    is_integrated_uma: false,
                    dedicated_bytes: 15.1 * GIB,
                    shared_bytes: 128 * MIB,
                    spill_threshold_bytes: 256 * MIB,
                    samples: 3,
                },
            }),
            // Second episode with severe spill (>= 2x limit -> critical).
            at(400, "backend.gpu_memory.sample", {
                producer: ws,
                device_id: "gpu:0",
                attributes: {
                    backend: "llamaserver",
                    is_integrated_uma: false,
                    dedicated_bytes: 15.9 * GIB,
                    shared_bytes: 1024 * MIB,
                    spill_threshold_bytes: 256 * MIB,
                    samples: 4,
                },
            }),
        ];

        const findings = detect("resource-pressure", events);
        assertEvidence(findings, events);
        expect(findings).toHaveLength(2);
        expect(findings[0]!.severity).toBe("warning");
        expect(findings[0]!.facts.signal).toBe("vram-spill");
        expect(findings[0]!.facts.memory_mode).toBe("discrete-gddr");
        expect(findings[0]!.evidenceEventIds).toEqual([events[1]!.event_id]);

        expect(findings[1]!.severity).toBe("critical");
        expect(findings[1]!.facts.signal).toBe("vram-spill");
        expect(findings[1]!.evidenceEventIds).toEqual([events[3]!.event_id]);
    });

    it("emits zero false-positive VRAM spill or BIOS-carveout findings on pure iGPU UMA hosts", () => {
        const events: ObservatoryEvent[] = [
            // BIOS carveout (512 MiB) reported as total_bytes/used_bytes (97.7%),
            // while unified effective UMA pool (32 GiB) is only ~38% used.
            at(100, "device.memory.sample", {
                producer: apuHost,
                device_id: "gpu:0",
                attributes: {
                    kind: "gpu",
                    name: "AMD Radeon 780M Graphics",
                    is_integrated_uma: true,
                    dedicated_total_bytes: 512 * MIB,
                    total_bytes: 512 * MIB,
                    used_bytes: 500 * MIB,
                    shared_total_bytes: 31 * GIB,
                    effective_vram_mib: 512 + 31 * 1024,
                    effective_free_vram_mib: 20 * 1024,
                },
            }),
            // Heavy intentional UMA shared allocation (24 GiB >> 256 MiB threshold).
            at(200, "backend.gpu_memory.sample", {
                producer: apuHost,
                device_id: "gpu:0",
                attributes: {
                    backend: "llamaserver",
                    is_integrated_uma: true,
                    dedicated_bytes: 512 * MIB,
                    shared_bytes: 24 * GIB,
                    spill_threshold_bytes: 256 * MIB,
                    spilled: true, // even a legacy/broken producer flag on UMA is suppressed
                    samples: 1,
                },
            }),
            at(300, "backend.gpu_memory.sample", {
                producer: apuHost,
                attributes: {
                    backend: "llamaserver",
                    uma_mode: true,
                    dedicated_bytes: 512 * MIB,
                    shared_bytes: 25 * GIB,
                    spill_threshold_bytes: 256 * MIB,
                    samples: 2,
                },
            }),
        ];

        expect(detect("resource-pressure", events)).toEqual([]);
    });

    it("still detects genuine unified UMA pool exhaustion even when BIOS carveout used_bytes is small", () => {
        const events: ObservatoryEvent[] = [
            at(100, "device.memory.sample", {
                producer: apuHost,
                device_id: "gpu:0",
                attributes: {
                    kind: "gpu",
                    name: "AMD Radeon 780M Graphics",
                    is_integrated_uma: true,
                    dedicated_total_bytes: 512 * MIB,
                    used_bytes: 500 * MIB, // carveout only — must NOT hide 96.9% unified exhaustion
                    shared_total_bytes: 16 * GIB,
                    effective_vram_mib: 16_384,
                    effective_free_vram_mib: 512,
                },
            }),
        ];

        const findings = detect("resource-pressure", events);
        assertEvidence(findings, events);
        expect(findings).toHaveLength(1);
        expect(findings[0]!.severity).toBe("critical");
        expect(findings[0]!.summary).toContain("gpu:0/gpu");
    });

    it("suppresses false VRAM spill findings on hybrid discrete+iGPU UMA hosts while catching real discrete spills", () => {
        // Hybrid Node1 running an 80B spread cleanly across RX 9060 XT + Radeon 780M: ZERO spill findings.
        const healthyHybrid: ObservatoryEvent[] = [
            at(100, "device.memory.sample", {
                producer: node1,
                device_id: "gpu:0",
                attributes: {
                    kind: "gpu",
                    name: "AMD Radeon RX 9060 XT",
                    is_integrated_uma: false,
                    backend_hint: "vulkan",
                    dedicated_total_bytes: 16 * GIB,
                    dedicated_free_bytes: 3 * GIB, // 81.25% (< 85% warnFraction)
                },
            }),
            at(110, "device.memory.sample", {
                producer: node1,
                device_id: "gpu:1",
                attributes: {
                    kind: "gpu",
                    name: "AMD Radeon 780M Graphics",
                    is_integrated_uma: true,
                    backend_hint: "vulkan",
                    dedicated_total_bytes: 512 * MIB,
                    shared_total_bytes: 31 * GIB,
                    effective_vram_mib: 512 + 31 * 1024,
                    effective_free_vram_mib: 12 * 1024, // ~62% (< 85%)
                },
            }),
            at(120, "model.load.completed", {
                producer: node1,
                attributes: { model: "qwen3-80b-moe", resident: true, active_devices: ["Vulkan0", "Vulkan1"] },
            }),
            at(200, "backend.gpu_memory.sample", {
                producer: node1,
                attributes: {
                    backend: "llamaserver",
                    dedicated_bytes: 13 * GIB,
                    shared_bytes: 20 * GIB,
                    spill_threshold_bytes: 256 * MIB,
                    samples: 1,
                },
            }),
            at(210, "backend.gpu_memory.sample", {
                producer: node1,
                device_id: "gpu:1",
                attributes: {
                    backend: "llamaserver",
                    dedicated_bytes: 512 * MIB,
                    shared_bytes: 20 * GIB,
                    spill_threshold_bytes: 256 * MIB,
                    samples: 1,
                },
            }),
        ];
        expect(detect("resource-pressure", healthyHybrid)).toEqual([]);

        // Now add a genuine discrete GDDR spill on gpu:0 alongside healthy UMA on gpu:1:
        // ONLY gpu:0 triggers a VRAM spill finding.
        const discreteSpillOnHybrid: ObservatoryEvent[] = [
            ...healthyHybrid,
            at(300, "backend.gpu_memory.sample", {
                producer: node1,
                device_id: "gpu:0",
                attributes: {
                    backend: "llamaserver",
                    dedicated_bytes: 15.8 * GIB,
                    shared_bytes: 768 * MIB,
                    spill_threshold_bytes: 256 * MIB,
                    samples: 2,
                },
            }),
        ];
        const findings = detect("resource-pressure", discreteSpillOnHybrid);
        assertEvidence(findings, discreteSpillOnHybrid);
        expect(findings).toHaveLength(1);
        expect(findings[0]!.facts.signal).toBe("vram-spill");
        expect(findings[0]!.facts.scope).toBe("gpu:0/llamaserver");
        expect(findings[0]!.severity).toBe("critical");
        expect(findings[0]!.evidenceEventIds).toEqual([discreteSpillOnHybrid.at(-1)!.event_id]);

        // Order independence via runDiagnostics.
        const forward = runDiagnostics(discreteSpillOnHybrid, { kinds: ["resource-pressure"] });
        const reversed = runDiagnostics([...discreteSpillOnHybrid].reverse(), { kinds: ["resource-pressure"] });
        expect(reversed).toEqual(forward);
    });

    it("isolates per-node device.memory.sample series when two hosts share device_id gpu:0", () => {
        const events: ObservatoryEvent[] = [
            at(100, "device.memory.sample", {
                producer: node1,
                device_id: "gpu:0",
                attributes: { kind: "gpu", is_integrated_uma: false, dedicated_total_bytes: 16 * GIB, dedicated_free_bytes: 512 * MIB },
            }),
            // Interleaved idle workstation gpu:0 sample must NOT fracture Node1's contiguous pressure episode.
            at(150, "device.memory.sample", {
                producer: ws,
                device_id: "gpu:0",
                attributes: { kind: "gpu", is_integrated_uma: false, dedicated_total_bytes: 16 * GIB, dedicated_free_bytes: 14 * GIB },
            }),
            at(200, "device.memory.sample", {
                producer: node1,
                device_id: "gpu:0",
                attributes: { kind: "gpu", is_integrated_uma: false, dedicated_total_bytes: 16 * GIB, dedicated_free_bytes: 256 * MIB },
            }),
        ];

        const findings = detect("resource-pressure", events);
        assertEvidence(findings, events);
        expect(findings).toHaveLength(1);
        expect(findings[0]!.evidenceEventIds).toEqual([events[0]!.event_id, events[2]!.event_id]);
        expect(findings[0]!.severity).toBe("critical");
    });
});
