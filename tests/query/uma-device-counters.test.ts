/**
 * UMA `device.memory.sample` attribute parsing (`src/query/attributes.ts`) and
 * per-`(device_id, kind)` session counter isolation (`src/query/sessionCounters.ts`).
 *
 * Ensures integrated UMA iGPUs (e.g. AMD Radeon 780M emitting
 * `effective_vram_mib` / `effective_free_vram_mib` / `shared_total_bytes` /
 * `dedicated_total_bytes` without generic `total_bytes`) are never dropped to
 * null, and interleaved CPU RAM + discrete GPU + integrated UMA GPU samples
 * never overwrite each other's latest/peak records.
 */
import { describe, expect, it } from "vitest";
import { detectResourcePressure } from "../../src/diagnostics/detectors/resource";
import { DEFAULT_CONFIG } from "../../src/diagnostics/types";
import type { ObservatoryEvent } from "../../src/protocol/events";
import { deviceMemoryKind, memoryUsage } from "../../src/query/attributes";
import {
    cloneCounters,
    deviceMemoryByKind,
    deviceMemoryKey,
    deviceMemoryRecord,
    deviceMemoryRecords,
    newCounters,
    stepCounters,
    summarizeDeviceMemory,
} from "../../src/query/sessionCounters";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function memEvent(
    seq: number,
    deviceId: string | null,
    attributes: Record<string, unknown>,
    monoNs = 1_000_000_000 + seq * 1_000_000,
): ObservatoryEvent {
    const base: ObservatoryEvent = {
        schema: "sonder.observatory.event/1",
        event_id: `ev-${seq}`,
        sequence: seq,
        event_type: "device.memory.sample",
        wall_time: "2026-11-25T08:00:00.000Z",
        mono_ns: monoNs,
        session_id: "ses-uma-test",
        producer: {
            name: "sonder-inference",
            version: "0.4.0",
            node_id: "node1",
            instance_id: "inst-node1",
            role: "inference",
            synthetic: false,
        },
        attributes,
    };
    if (deviceId !== null) {
        base.device_id = deviceId;
    }
    return base;
}

describe("memoryUsage — UMA and discrete GPU attribute parsing", () => {
    it("parses Radeon 780M integrated UMA samples from effective_vram_mib + effective_free_vram_mib", () => {
        const e = memEvent(1, "gpu:1", {
            kind: "gpu",
            name: "AMD Radeon 780M Graphics",
            is_integrated_uma: true,
            dedicated_total_bytes: 512 * MIB,
            dedicated_free_bytes: 12_288 * MIB,
            shared_total_bytes: 16_384 * MIB,
            effective_vram_mib: 16_384,
            effective_free_vram_mib: 12_288,
        });

        const usage = memoryUsage(e);
        expect(usage).not.toBeNull();
        expect(usage!.source).toBe("effective_vram_mib");
        expect(usage!.totalBytes).toBe(16_384 * MIB);
        expect(usage!.usedBytes).toBe(4_096 * MIB);
        expect(usage!.fraction).toBeCloseTo(0.25, 6);
        expect(deviceMemoryKind(e)).toBe("gpu");
    });

    it("falls back to uma_bytes (dedicated_total_bytes + shared_total_bytes) when effective_vram_mib is omitted", () => {
        const e = memEvent(2, "gpu:1", {
            kind: "gpu",
            is_integrated_uma: true,
            dedicated_total_bytes: 512 * MIB,
            shared_total_bytes: 16_384 * MIB,
            dedicated_free_bytes: 12_672 * MIB,
        });

        const usage = memoryUsage(e);
        expect(usage).not.toBeNull();
        expect(usage!.source).toBe("uma_bytes");
        expect(usage!.totalBytes).toBe((512 + 16_384) * MIB);
        expect(usage!.usedBytes).toBe(4_224 * MIB);
        expect(usage!.fraction).toBeCloseTo(4_224 / (512 + 16_384), 6);
    });

    it("falls back to shared_total_bytes alone on UMA when dedicated_total_bytes is omitted", () => {
        const e = memEvent(3, "gpu:1", {
            kind: "gpu",
            is_integrated_uma: true,
            shared_total_bytes: 16 * GIB,
            dedicated_free_bytes: 4 * GIB,
        });

        const usage = memoryUsage(e);
        expect(usage).not.toBeNull();
        expect(usage!.source).toBe("uma_bytes");
        expect(usage!.totalBytes).toBe(16 * GIB);
        expect(usage!.usedBytes).toBe(12 * GIB);
        expect(usage!.fraction).toBeCloseTo(0.75, 6);
    });

    it("uses effective_vram_mib as UMA total with dedicated_free_bytes when effective_free_vram_mib is absent", () => {
        const e = memEvent(4, "gpu:1", {
            kind: "gpu",
            is_integrated_uma: true,
            effective_vram_mib: 16_384,
            dedicated_free_bytes: 8_192 * MIB,
        });

        const usage = memoryUsage(e);
        expect(usage).not.toBeNull();
        expect(usage!.source).toBe("uma_bytes");
        expect(usage!.totalBytes).toBe(16_384 * MIB);
        expect(usage!.usedBytes).toBe(8_192 * MIB);
        expect(usage!.fraction).toBeCloseTo(0.5, 6);
    });

    it("parses discrete GPU samples with dedicated_total_bytes + dedicated_free_bytes", () => {
        const e = memEvent(5, "gpu:0", {
            kind: "gpu",
            name: "AMD Radeon RX 9060 XT",
            is_integrated_uma: false,
            dedicated_total_bytes: 16 * GIB,
            dedicated_free_bytes: 2 * GIB,
            shared_total_bytes: 16 * GIB,
        });

        const usage = memoryUsage(e);
        expect(usage).not.toBeNull();
        expect(usage!.source).toBe("dedicated_bytes");
        // Discrete GPU must NOT add shared_total_bytes into dedicated VRAM.
        expect(usage!.totalBytes).toBe(16 * GIB);
        expect(usage!.usedBytes).toBe(14 * GIB);
        expect(usage!.fraction).toBeCloseTo(14 / 16, 6);
    });

    it("preserves priority order: used_bytes > available_bytes > effective_vram_mib > uma/dedicated > used_fraction", () => {
        const withUsed = memEvent(10, "gpu:0", {
            total_bytes: 16 * GIB,
            used_bytes: 8 * GIB,
            available_bytes: 4 * GIB,
            effective_vram_mib: 16_384,
            effective_free_vram_mib: 1_024,
            used_fraction: 0.99,
        });
        expect(memoryUsage(withUsed)?.source).toBe("used_bytes");
        expect(memoryUsage(withUsed)?.fraction).toBeCloseTo(0.5, 6);

        const withAvail = memEvent(11, "cpu:0", {
            total_bytes: 32 * GIB,
            available_bytes: 8 * GIB,
            effective_vram_mib: 16_384,
            effective_free_vram_mib: 1_024,
            used_fraction: 0.1,
        });
        expect(memoryUsage(withAvail)?.source).toBe("available_bytes");
        expect(memoryUsage(withAvail)?.fraction).toBeCloseTo(0.75, 6);

        const withFractionOnly = memEvent(12, "gpu:1", {
            used_fraction: 0.62,
        });
        expect(memoryUsage(withFractionOnly)).toEqual({
            usedBytes: null,
            totalBytes: null,
            fraction: 0.62,
            source: "used_fraction",
        });
    });

    it("rejects anomalous, underflowing, zero-total, or incomplete UMA/dedicated readings without fabricating zero", () => {
        const cases: Record<string, unknown>[] = [
            // effective_free > effective_vram (would underflow)
            { is_integrated_uma: true, effective_vram_mib: 16_384, effective_free_vram_mib: 16_500 },
            // zero effective_vram_mib
            { is_integrated_uma: true, effective_vram_mib: 0, effective_free_vram_mib: 0 },
            // missing free count (total only)
            { is_integrated_uma: true, effective_vram_mib: 16_384, shared_total_bytes: 16 * GIB },
            // UMA dedicated_free_bytes > umaTotal
            { is_integrated_uma: true, dedicated_total_bytes: 512 * MIB, shared_total_bytes: 16 * GIB, dedicated_free_bytes: 20 * GIB },
            // Discrete dedicated_free_bytes > dedicated_total_bytes
            { is_integrated_uma: false, dedicated_total_bytes: 16 * GIB, dedicated_free_bytes: 17 * GIB },
            // Negative / NaN / Infinity / overflow MiB
            { is_integrated_uma: true, effective_vram_mib: -1024, effective_free_vram_mib: 512 },
            { is_integrated_uma: true, effective_vram_mib: Number.NaN, effective_free_vram_mib: 512 },
            { is_integrated_uma: true, effective_vram_mib: Number.POSITIVE_INFINITY, effective_free_vram_mib: 512 },
            { is_integrated_uma: true, effective_vram_mib: Number.MAX_SAFE_INTEGER, effective_free_vram_mib: 0 },
            // Negative used_bytes
            { total_bytes: 16 * GIB, used_bytes: -1 },
            // available_bytes > total_bytes
            { total_bytes: 16 * GIB, available_bytes: 18 * GIB },
        ];
        for (const [idx, attrs] of cases.entries()) {
            expect(memoryUsage(memEvent(100 + idx, "gpu:1", attrs))).toBeNull();
        }
    });

    it("normalizes deviceMemoryKind and trims blanks to null", () => {
        expect(deviceMemoryKind(memEvent(20, "gpu:1", { kind: " gpu " }))).toBe("gpu");
        expect(deviceMemoryKind(memEvent(21, "gpu:1", { kind: "   " }))).toBeNull();
        expect(deviceMemoryKind(memEvent(22, "gpu:1", {}))).toBeNull();
        expect(deviceMemoryKind(memEvent(23, "gpu:1", { kind: 42 }))).toBeNull();
    });

    it("surfaces high Radeon 780M UMA pressure through detectResourcePressure instead of dropping samples", () => {
        const events: ObservatoryEvent[] = [
            memEvent(1, "gpu:1", {
                kind: "gpu",
                name: "AMD Radeon 780M Graphics",
                is_integrated_uma: true,
                effective_vram_mib: 16_384,
                effective_free_vram_mib: 1_024, // 93.75% used -> warning/critical
            }),
            memEvent(2, "gpu:1", {
                kind: "gpu",
                name: "AMD Radeon 780M Graphics",
                is_integrated_uma: true,
                effective_vram_mib: 16_384,
                effective_free_vram_mib: 512, // 96.875% used -> critical
            }),
        ];
        const findings = detectResourcePressure(events, DEFAULT_CONFIG);
        expect(findings).toHaveLength(1);
        expect(findings[0]!.kind).toBe("resource-pressure");
        expect(findings[0]!.severity).toBe("critical");
        expect(findings[0]!.summary).toContain("gpu:1/gpu");
    });
});

describe("sessionCounters — per-(device_id, kind) memory isolation", () => {
    it("isolates interleaved CPU RAM, discrete RX 9060 XT, and integrated Radeon 780M UMA without clobbering", () => {
        const c = newCounters();

        // 1. Host CPU RAM: 16 / 32 GiB (50%)
        stepCounters(
            c,
            memEvent(1, "cpu:0", {
                kind: "cpu",
                name: "System RAM",
                total_bytes: 32 * GIB,
                available_bytes: 16 * GIB,
            }),
        );
        // 2. Discrete RX 9060 XT: 14 / 16 GiB (87.5%) — peak discrete
        stepCounters(
            c,
            memEvent(2, "gpu:0", {
                kind: "gpu",
                name: "AMD Radeon RX 9060 XT",
                is_integrated_uma: false,
                effective_vram_mib: 16_384,
                effective_free_vram_mib: 2_048,
            }),
        );
        // 3. Integrated Radeon 780M UMA: 12 / 16 GiB (75%) — peak UMA
        stepCounters(
            c,
            memEvent(3, "gpu:1", {
                kind: "gpu",
                name: "AMD Radeon 780M Graphics",
                is_integrated_uma: true,
                effective_vram_mib: 16_384,
                effective_free_vram_mib: 4_096,
            }),
        );
        // 4. Discrete RX 9060 XT drops to 8 / 16 GiB (50%)
        stepCounters(
            c,
            memEvent(4, "gpu:0", {
                kind: "gpu",
                name: "AMD Radeon RX 9060 XT",
                is_integrated_uma: false,
                effective_vram_mib: 16_384,
                effective_free_vram_mib: 8_192,
            }),
        );
        // 5. Integrated Radeon 780M UMA drops to 6 / 16 GiB (37.5%)
        stepCounters(
            c,
            memEvent(5, "gpu:1", {
                kind: "gpu",
                name: "AMD Radeon 780M Graphics",
                is_integrated_uma: true,
                effective_vram_mib: 16_384,
                effective_free_vram_mib: 10_240,
            }),
        );
        // 6. Host CPU RAM rises to 20 / 32 GiB (62.5%) — latest overall sample is CPU RAM!
        stepCounters(
            c,
            memEvent(6, "cpu:0", {
                kind: "cpu",
                name: "System RAM",
                total_bytes: 32 * GIB,
                available_bytes: 12 * GIB,
            }),
        );

        // Legacy scalar fields keep exact backward-compatible semantics.
        expect(c.latest?.deviceId).toBe("cpu:0");
        expect(c.latest?.fraction).toBeCloseTo(20 / 32, 6);
        expect(c.peak?.deviceId).toBe("gpu:0");
        expect(c.peak?.fraction).toBeCloseTo(14 / 16, 6);

        // Isolated per-(device_id, kind) records retain independent latest & peak.
        expect(deviceMemoryRecords(c)).toHaveLength(3);

        const cpu = deviceMemoryRecord(c, "cpu:0", "cpu")!;
        expect(cpu).not.toBeNull();
        expect(cpu.samples).toBe(2);
        expect(cpu.name).toBe("System RAM");
        expect(cpu.isIntegratedUma).toBeNull();
        expect(cpu.latest.fraction).toBeCloseTo(20 / 32, 6);
        expect(cpu.peak.fraction).toBeCloseTo(20 / 32, 6);

        const dgpu = deviceMemoryRecord(c, "gpu:0", "gpu")!;
        expect(dgpu).not.toBeNull();
        expect(dgpu.samples).toBe(2);
        expect(dgpu.name).toBe("AMD Radeon RX 9060 XT");
        expect(dgpu.isIntegratedUma).toBe(false);
        expect(dgpu.latest.fraction).toBeCloseTo(0.5, 6);
        expect(dgpu.peak.fraction).toBeCloseTo(0.875, 6);

        const uma = deviceMemoryRecord(c, "gpu:1", "gpu")!;
        expect(uma).not.toBeNull();
        expect(uma.samples).toBe(2);
        expect(uma.name).toBe("AMD Radeon 780M Graphics");
        expect(uma.isIntegratedUma).toBe(true);
        expect(uma.latest.fraction).toBeCloseTo(0.375, 6);
        expect(uma.peak.fraction).toBeCloseTo(0.75, 6);

        // Kind filtering & summary view separate host RAM from GPU VRAM cleanly.
        expect(deviceMemoryByKind(c, "GPU").map((r) => r.deviceId)).toEqual(["gpu:0", "gpu:1"]);
        expect(deviceMemoryByKind(c, "cpu").map((r) => r.deviceId)).toEqual(["cpu:0"]);

        const summary = summarizeDeviceMemory(c);
        expect(summary.latest).toEqual(c.latest);
        expect(summary.peak).toEqual(c.peak);
        expect(summary.byDevice).toHaveLength(3);
        expect(summary.hostLatest?.deviceId).toBe("cpu:0");
        expect(summary.hostPeak?.fraction).toBeCloseTo(20 / 32, 6);
        expect(summary.gpuLatest?.deviceId).toBe("gpu:1");
        expect(summary.gpuLatest?.fraction).toBeCloseTo(0.375, 6);
        expect(summary.gpuPeak?.deviceId).toBe("gpu:0");
        expect(summary.gpuPeak?.fraction).toBeCloseTo(0.875, 6);
    });

    it("separates distinct kinds emitted under the same device_id without collision", () => {
        const c = newCounters();
        stepCounters(c, memEvent(1, "node1", { kind: "ram", total_bytes: 32 * GIB, used_bytes: 8 * GIB }));
        stepCounters(c, memEvent(2, "node1", { kind: "vram", total_bytes: 16 * GIB, used_bytes: 12 * GIB }));

        expect(deviceMemoryRecords(c)).toHaveLength(2);
        expect(deviceMemoryRecord(c, "node1", "ram")?.latest.fraction).toBeCloseTo(0.25, 6);
        expect(deviceMemoryRecord(c, "node1", "vram")?.latest.fraction).toBeCloseTo(0.75, 6);

        const summary = summarizeDeviceMemory(c);
        expect(summary.hostLatest?.fraction).toBeCloseTo(0.25, 6);
        expect(summary.gpuLatest?.fraction).toBeCloseTo(0.75, 6);

        // Collision resistance of canonical keys.
        expect(deviceMemoryKey("a/b", "c")).not.toBe(deviceMemoryKey("a", "b/c"));
        expect(deviceMemoryKey(null, "gpu")).not.toBe(deviceMemoryKey("null", "gpu"));
    });

    it("deep-clones device memory records in cloneCounters so replay checkpoints never alias", () => {
        const base = newCounters();
        stepCounters(
            base,
            memEvent(1, "gpu:1", {
                kind: "gpu",
                name: "AMD Radeon 780M Graphics",
                is_integrated_uma: true,
                effective_vram_mib: 16_384,
                effective_free_vram_mib: 12_288, // 25%
            }),
        );

        const checkpoint = cloneCounters(base);

        // Advance `base` with a higher-usage sample on the same device.
        stepCounters(
            base,
            memEvent(2, "gpu:1", {
                kind: "gpu",
                name: "AMD Radeon 780M Graphics",
                is_integrated_uma: true,
                effective_vram_mib: 16_384,
                effective_free_vram_mib: 2_048, // 87.5%
            }),
        );

        const cpRec = deviceMemoryRecord(checkpoint, "gpu:1", "gpu")!;
        const liveRec = deviceMemoryRecord(base, "gpu:1", "gpu")!;

        expect(cpRec.samples).toBe(1);
        expect(cpRec.latest.fraction).toBeCloseTo(0.25, 6);
        expect(cpRec.peak.fraction).toBeCloseTo(0.25, 6);

        expect(liveRec.samples).toBe(2);
        expect(liveRec.latest.fraction).toBeCloseTo(0.875, 6);
        expect(liveRec.peak.fraction).toBeCloseTo(0.875, 6);
    });
});
