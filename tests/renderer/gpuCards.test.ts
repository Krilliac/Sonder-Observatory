import { describe, expect, it } from "vitest";
import type { GpuMetrics } from "../../src/query/gpuMemory";
import { deriveGpuMemory } from "../../src/query/gpuMemory";
import { GPU_WARNING_EXPLANATIONS, gpuCardModels, gpuCardText, gpuChartPaths, gpuWarningExplanation, renderGpuCards } from "../../src/renderer/gpuCards";
import { at } from "../helpers";

function metrics(overrides: Partial<GpuMetrics["backends"][number]> = {}): GpuMetrics {
    return {
        backends: [{
            key: "llama-1", backend: "llamaserver", producer: "sonder-inference", nodeId: "node-1", instanceId: "a", synthetic: false,
            samples: [
                { eventId: "s1", monoNs: 10, wallTime: "2026-09-30T00:00:00Z", dedicatedBytes: 100, sharedBytes: 20, spillThresholdBytes: 256, sharedBaselineBytes: 0, spillLimitBytes: 256, spilled: false, fittedCtx: 73728, sampleCount: 1, status: "ok", epoch: 0 },
                { eventId: "s-gap", monoNs: 15, wallTime: "2026-09-30T00:00:00Z", dedicatedBytes: null, sharedBytes: null, spillThresholdBytes: 256, sharedBaselineBytes: 0, spillLimitBytes: 256, spilled: null, fittedCtx: null, sampleCount: 2, status: "ok", epoch: 0 },
                { eventId: "s2", monoNs: 20, wallTime: "2026-09-30T00:00:01Z", dedicatedBytes: null, sharedBytes: 300, spillThresholdBytes: 256, sharedBaselineBytes: 0, spillLimitBytes: 256, spilled: true, fittedCtx: 65536, sampleCount: 3, status: "spill", epoch: 1 },
                { eventId: "s3", monoNs: 30, wallTime: "2026-09-30T00:00:02Z", dedicatedBytes: 110, sharedBytes: 310, spillThresholdBytes: 256, sharedBaselineBytes: 0, spillLimitBytes: 256, spilled: true, fittedCtx: 65536, sampleCount: 4, status: "spill", epoch: 1 },
            ],
            latest: null, fittedCtx: 65536, contextChanges: [{ eventId: "c", monoNs: 20, fittedCtx: 65536, fitOutcome: "auto_fit" }], warnings: [], ...overrides,
        }],
    };
}

describe("GPU cards", () => {
    it("gates empty telemetry and never invents zero memory", () => {
        expect(gpuCardModels({ backends: [] })).toEqual([]);
        expect(renderGpuCards({ backends: [] })).toEqual([]);
        expect(gpuCardModels(deriveGpuMemory([at(1, "request.started")]))).toEqual([]);
        const model = gpuCardModels(metrics({ samples: [], latest: null, warnings: [], contextChanges: [] }))[0];
        expect(model).toBeUndefined();
        const absent = gpuCardModels(metrics({ samples: [{ ...metrics().backends[0]!.samples[0]!, dedicatedBytes: null, sharedBytes: null }], latest: null }))[0]!;
        expect(absent.hasTelemetry).toBe(false);
        expect(absent.latestDedicatedBytes).toBeNull();
        expect(gpuCardText(absent).memory).toBe("no GPU telemetry");
    });

    it("keeps spill wording, context changes, null gaps, epoch breaks, and real time spacing", () => {
        const card = gpuCardModels(metrics())[0]!;
        expect(card.spilled).toBe(true);
        expect(gpuCardText(card)).toMatchObject({ status: "SPILL", spillDetail: "overflow in shared system RAM; decode 2-15x slower" });
        expect(card.fittedCtx).toBe(65536);
        expect(card.contextChanges).toHaveLength(1);
        expect(gpuWarningExplanation({ code: "vram_spill", message: null })).toContain("shared system RAM");
        expect(card.points).toHaveLength(4);
        expect(card.points[1]!.dedicatedBytes).toBeNull();
        expect(card.points[2]!.epoch).not.toBe(card.points[1]!.epoch);
        expect(card.points[0]!.monoNs).toBe(10);
        expect(card.points[3]!.monoNs).toBe(30);
        const paths = gpuChartPaths(card.points);
        expect(paths.dedicated.match(/[ML]/g)).toEqual(["M", "M"]);
        expect(paths.shared.match(/[ML]/g)).toEqual(["M", "M", "L"]);
        expect(paths.threshold.match(/[ML]/g)).toEqual(["M", "L", "M", "L"]);
        const positions = [...paths.shared.matchAll(/[ML]([\d.]+),/g)].map((m) => Number(m[1]));
        expect(positions[1]! - positions[0]!).toBeCloseTo((positions[2]! - positions[0]!) / 2);
    });

    it("explains every warning code and preserves unknown producer messages", () => {
        expect(Object.keys(GPU_WARNING_EXPLANATIONS)).toHaveLength(10);
        for (const explanation of Object.values(GPU_WARNING_EXPLANATIONS)) expect(explanation.length).toBeGreaterThan(10);
        expect(GPU_WARNING_EXPLANATIONS.kv_kernel_f16_fallback).toContain("matched q4_0/q4_0 or q8_0/q8_0");
        const warning = { code: "future_code", message: "future producer detail", severity: null, source: null, count: 1, firstSeenNs: 1, lastSeenNs: 1, firstSeenWallTime: "first", lastSeenWallTime: "last", firstEventId: "e", lastEventId: "e" };
        const model = gpuCardModels(metrics({ warnings: [warning] }))[0]!;
        expect(gpuWarningExplanation(model.warnings[0]!)).toBe("future producer detail");
        expect(model.warnings[0]!.code).toBe("future_code");
        expect(model.warnings[0]).toMatchObject({ firstSeenWallTime: "first", lastSeenWallTime: "last", count: 1 });
        expect(gpuWarningExplanation({ code: "__proto__", message: "unrecognized" })).toBe("unrecognized");
        expect(gpuWarningExplanation({ code: "constructor", message: null })).toBe("Backend reported a GPU warning.");
    });

    it("labels synthetic cards", () => {
        expect(gpuCardModels(metrics({ synthetic: true }))[0]!.synthetic).toBe(true);
    });

    it("shows measured zero, partial memory, and a warning-only backend without invented readings", () => {
        const b = metrics().backends[0]!;
        const zero = { ...b.samples[0]!, dedicatedBytes: 0, sharedBytes: 0 };
        expect(gpuCardText(gpuCardModels(metrics({ samples: [zero], latest: zero }))[0]!).memory).toBe("0 B dedicated · 0 B shared");
        const partial = { ...zero, dedicatedBytes: null, sharedBytes: 1024 };
        expect(gpuCardText(gpuCardModels(metrics({ samples: [partial], latest: partial }))[0]!).memory).toBe("unknown dedicated · 1.0 KiB shared");
        const warningOnly = gpuCardModels(deriveGpuMemory([at(1, "backend.warning", { attributes: { backend: "llamaserver", code: "no_gpu_device" } })]))[0]!;
        expect(gpuCardText(warningOnly)).toEqual({ memory: "no GPU telemetry", status: "Spill state unavailable", spillDetail: null });
        expect(warningOnly.fittedCtx).toBeNull();
    });

    it("does not revive older measurements after an unavailable latest sample", () => {
        const b = metrics().backends[0]!;
        const unavailable = { ...b.samples[0]!, dedicatedBytes: null, sharedBytes: null, spilled: null, status: "error" };
        const card = gpuCardModels(metrics({ latest: unavailable, samples: [...b.samples, unavailable] }))[0]!;
        expect(gpuCardText(card)).toEqual({ memory: "no GPU telemetry", status: "Spill state unavailable", spillDetail: null });
    });

    it("clears the active SPILL badge on recovery even with historical spill warnings", () => {
        const data = deriveGpuMemory([
            at(1, "backend.gpu_memory.sample", { attributes: { spilled: true } }),
            at(2, "backend.warning", { attributes: { code: "vram_spill" } }),
            at(3, "backend.gpu_memory.sample", { attributes: { shared_bytes: 0, spilled: false } }),
        ]);
        const card = gpuCardModels(data)[0]!;
        expect(card.warnings).toHaveLength(1);
        expect(gpuCardText(card)).toMatchObject({ status: "No spill reported", spillDetail: null });
    });

    it("keeps null series empty and includes the reported spill limit in chart scale", () => {
        const point = gpuCardModels(metrics())[0]!.points[0]!;
        expect(gpuChartPaths([point]).maxBytes).toBe(256);
        const absent = { ...point, dedicatedBytes: null, sharedBytes: null, spillLimitBytes: null };
        expect(gpuChartPaths([absent])).toEqual({ dedicated: "", shared: "", threshold: "", maxBytes: 1 });
        expect(gpuChartPaths([point, { ...point, monoNs: 30, epoch: 1 }]).shared.match(/[ML]/g)).toEqual(["M", "M"]);
        expect(gpuChartPaths([point]).dedicated).not.toMatch(/NaN|Infinity/);
    });

    it("bounds chart and context display while retaining totals and the latest observation", () => {
        const sample = metrics().backends[0]!.samples[0]!;
        const samples = Array.from({ length: 1000 }, (_, i) => ({ ...sample, monoNs: i }));
        const contextChanges = samples.map((s, i) => ({ eventId: `ctx-${i}`, monoNs: s.monoNs, fittedCtx: 8192 + i, fitOutcome: "fitted" }));
        const card = gpuCardModels(metrics({ samples, contextChanges }))[0]!;
        expect(card.points).toHaveLength(240);
        expect(card.points[0]?.monoNs).toBe(760);
        expect(card.points.at(-1)?.monoNs).toBe(999);
        expect(card.totalSamples).toBe(1000);
        expect(card.contextChanges).toHaveLength(8);
        expect(card.contextChangeCount).toBe(999);
        expect(card.latestWallTime).toBe(sample.wallTime);
    });
});
