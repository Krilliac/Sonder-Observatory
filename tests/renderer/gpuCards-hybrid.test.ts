/**
 * Renderer tests for discrete GDDR vs integrated UMA vs hybrid multi-GPU cards
 * (`src/renderer/gpuCards.ts`).
 */
import { describe, expect, it } from "vitest";
import { deriveGpuMemory } from "../../src/query/gpuMemory";
import {
    gpuCardModels,
    gpuCardText,
    gpuChartPaths,
    gpuMemoryModeLabel,
    gpuPoolDetail,
    renderGpuCards,
} from "../../src/renderer/gpuCards";
import { at } from "../helpers";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const node1 = { name: "sonder-inference", version: "0.4.0", node_id: "NODE1", instance_id: "tel-node1", synthetic: false };
const apuHost = { name: "sonder-inference", version: "0.4.0", node_id: "apu-mini", instance_id: "tel-apu", synthetic: false };

class FakeElement {
    readonly attrs: Record<string, string> = {};
    textContent = "";
    readonly children: (FakeElement | string)[] = [];
    constructor(readonly tag: string) {}
    set className(v: string) {
        this.attrs.class = v;
    }
    setAttribute(k: string, v: string): void {
        this.attrs[k] = v;
    }
    append(...kids: (FakeElement | string)[]): void {
        this.children.push(...kids);
    }
}

function collectText(node: FakeElement | string): string {
    if (typeof node === "string") return node;
    return [node.textContent, ...node.children.map(collectText)].filter(Boolean).join(" ");
}

function findByClass(node: FakeElement, cls: string): FakeElement[] {
    const out: FakeElement[] = [];
    const classes = (node.attrs.class ?? "").split(/\s+/);
    if (classes.includes(cls)) {
        out.push(node);
    }
    for (const child of node.children) {
        if (typeof child !== "string") {
            out.push(...findByClass(child, cls));
        }
    }
    return out;
}

function withFakeDom<T>(fn: () => T): T {
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: {
            createElement: (tag: string) => new FakeElement(tag),
            createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
        },
    });
    try {
        return fn();
    } finally {
        if (original) Object.defineProperty(globalThis, "document", original);
        else Reflect.deleteProperty(globalThis, "document");
    }
}

describe("hybrid discrete GDDR vs integrated UMA GPU cards", () => {
    it("maps GPU memory modes to clear display badges", () => {
        expect(gpuMemoryModeLabel("discrete-gddr")).toBe("Discrete GDDR");
        expect(gpuMemoryModeLabel("integrated-uma")).toBe("Integrated UMA");
        expect(gpuMemoryModeLabel("hybrid-uma")).toBe("Hybrid Discrete + UMA");
        expect(gpuMemoryModeLabel("unknown")).toBeNull();
    });

    it("renders pure integrated UMA cards with unified pool semantics and no false SPILL banner", () => {
        const metrics = deriveGpuMemory([
            at(10, "device.memory.sample", {
                producer: apuHost,
                device_id: "gpu:0",
                attributes: {
                    kind: "gpu",
                    name: "AMD Radeon 780M Graphics",
                    is_integrated_uma: true,
                    dedicated_total_bytes: 512 * MIB,
                    shared_total_bytes: 31 * GIB,
                    effective_vram_mib: 512 + 31 * 1024,
                    effective_free_vram_mib: 10 * 1024,
                },
            }),
            at(20, "backend.gpu_memory.sample", {
                producer: apuHost,
                device_id: "gpu:0",
                attributes: {
                    backend: "llamaserver",
                    status: "ok",
                    is_integrated_uma: true,
                    dedicated_bytes: 512 * MIB,
                    shared_bytes: 20 * GIB,
                    spill_threshold_bytes: 256 * MIB,
                    samples: 1,
                    fitted_ctx: 65536,
                },
            }),
        ]);

        const models = gpuCardModels(metrics);
        expect(models).toHaveLength(1);
        const card = models[0]!;
        expect(card.title).toBe("AMD Radeon 780M Graphics");
        expect(card.deviceId).toBe("gpu:0");
        expect(card.memoryMode).toBe("integrated-uma");
        expect(card.modeLabel).toBe("Integrated UMA");
        expect(card.spilled).toBe(false);

        const text = gpuCardText(card);
        expect(text.status).toBe("UMA Unified Pool");
        expect(text.spillDetail).toBeNull();
        expect(text.memory).toContain("UMA pool");
        expect(text.memory).toContain("carveout");
        expect(text.memory).toContain("shared GTT");
        expect(gpuPoolDetail(card)).toContain("not VRAM spill");

        // Chart omits misleading discrete spill threshold on UMA cards.
        const umaPaths = gpuChartPaths(card.points, { includeThreshold: false });
        expect(umaPaths.threshold).toBe("");

        withFakeDom(() => {
            const els = renderGpuCards(metrics) as unknown as FakeElement[];
            expect(els).toHaveLength(1);
            const el = els[0]!;
            expect(el.attrs["data-gpu-mode"]).toBe("integrated-uma");
            expect(el.attrs["data-gpu-device"]).toBe("gpu:0");
            expect(el.attrs["data-gpu-spilled"]).toBe("false");
            expect(findByClass(el, "gpu-status-spill")).toHaveLength(0);
            expect(findByClass(el, "gpu-status-uma")).toHaveLength(1);
            expect(findByClass(el, "gpu-chart-threshold")).toHaveLength(0);
            expect(findByClass(el, "gpu-chart-uma-shared")).toHaveLength(1);
            expect(findByClass(el, "gpu-mode-integrated-uma")).toHaveLength(1);
            const fullText = collectText(el);
            expect(fullText).toContain("Integrated UMA");
            expect(fullText).toContain("UMA Unified Pool");
            expect(fullText).not.toContain("SPILL");
            expect(fullText).not.toContain("Spill limit:");
        });
    });

    it("renders hybrid discrete RX 9060 XT + integrated Radeon 780M cards distinctly without cross-contaminating spill state", () => {
        const metrics = deriveGpuMemory([
            at(10, "backend.gpu_memory.sample", {
                producer: node1,
                device_id: "gpu:0",
                attributes: {
                    backend: "llamaserver",
                    name: "AMD Radeon RX 9060 XT",
                    is_integrated_uma: false,
                    dedicated_total_bytes: 16 * GIB,
                    dedicated_bytes: 15.5 * GIB,
                    shared_bytes: 768 * MIB,
                    spill_threshold_bytes: 256 * MIB,
                    samples: 1,
                },
            }),
            at(15, "backend.gpu_memory.sample", {
                producer: node1,
                device_id: "gpu:1",
                attributes: {
                    backend: "llamaserver",
                    name: "AMD Radeon 780M Graphics",
                    is_integrated_uma: true,
                    dedicated_total_bytes: 512 * MIB,
                    shared_total_bytes: 31 * GIB,
                    dedicated_bytes: 512 * MIB,
                    shared_bytes: 24 * GIB,
                    spill_threshold_bytes: 256 * MIB,
                    samples: 1,
                },
            }),
        ]);

        const models = gpuCardModels(metrics);
        expect(models).toHaveLength(2);

        const discreteCard = models.find((m) => m.deviceId === "gpu:0")!;
        const umaCard = models.find((m) => m.deviceId === "gpu:1")!;

        expect(discreteCard.modeLabel).toBe("Discrete GDDR");
        expect(discreteCard.spilled).toBe(true);
        expect(gpuCardText(discreteCard)).toMatchObject({
            status: "SPILL",
            spillDetail: "overflow in shared system RAM; decode 2-15x slower",
        });
        expect(gpuCardText(discreteCard).memory).toContain("dedicated GDDR");

        expect(umaCard.modeLabel).toBe("Integrated UMA");
        expect(umaCard.spilled).toBe(false);
        expect(gpuCardText(umaCard)).toMatchObject({
            status: "UMA Unified Pool",
            spillDetail: null,
        });

        withFakeDom(() => {
            const els = renderGpuCards(metrics) as unknown as FakeElement[];
            expect(els).toHaveLength(2);
            const discreteEl = els.find((e) => e.attrs["data-gpu-device"] === "gpu:0")!;
            const umaEl = els.find((e) => e.attrs["data-gpu-device"] === "gpu:1")!;

            expect(discreteEl.attrs["data-gpu-mode"]).toBe("discrete-gddr");
            expect(discreteEl.attrs["data-gpu-spilled"]).toBe("true");
            expect(findByClass(discreteEl, "gpu-status-spill")).toHaveLength(1);
            expect(findByClass(discreteEl, "gpu-chart-threshold")).toHaveLength(1);

            expect(umaEl.attrs["data-gpu-mode"]).toBe("integrated-uma");
            expect(umaEl.attrs["data-gpu-spilled"]).toBe("false");
            expect(findByClass(umaEl, "gpu-status-spill")).toHaveLength(0);
            expect(findByClass(umaEl, "gpu-status-uma")).toHaveLength(1);
            expect(findByClass(umaEl, "gpu-chart-threshold")).toHaveLength(0);
        });
    });

    it("renders host-level hybrid-uma cards calmly without a false SPILL warning banner", () => {
        const metrics = deriveGpuMemory([
            at(10, "backend.gpu_memory.sample", {
                producer: node1,
                attributes: {
                    backend: "llamaserver",
                    uma_mode: "hybrid",
                    dedicated_bytes: 15 * GIB,
                    shared_bytes: 24 * GIB,
                    spill_threshold_bytes: 256 * MIB,
                    effective_vram_mib: 48 * 1024,
                    samples: 1,
                },
            }),
        ]);

        const card = gpuCardModels(metrics)[0]!;
        expect(card.memoryMode).toBe("hybrid-uma");
        expect(card.modeLabel).toBe("Hybrid Discrete + UMA");
        expect(card.spilled).toBe(false);
        expect(gpuCardText(card)).toMatchObject({
            status: "Hybrid UMA Pool",
            spillDetail: null,
        });
        expect(gpuCardText(card).memory).toContain("dedicated GDDR");
        expect(gpuCardText(card).memory).toContain("UMA shared");
        expect(gpuPoolDetail(card)).toContain("Hybrid discrete GDDR + iGPU UMA");

        withFakeDom(() => {
            const el = (renderGpuCards(metrics) as unknown as FakeElement[])[0]!;
            expect(el.attrs["data-gpu-mode"]).toBe("hybrid-uma");
            expect(el.attrs["data-gpu-spilled"]).toBe("false");
            expect(findByClass(el, "gpu-status-spill")).toHaveLength(0);
            expect(findByClass(el, "gpu-status-hybrid")).toHaveLength(1);
            expect(findByClass(el, "gpu-mode-hybrid-uma")).toHaveLength(1);
            expect(findByClass(el, "gpu-chart-threshold")).toHaveLength(0);
        });
    });
});
