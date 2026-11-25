import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveIngestStatus } from "../../src/ingest/live/client";
import type { ProducerHealth, ProducerNode } from "../../src/ingest/live/health";
import { LiveConnectionManager, probeProducer, type ProducerConnection } from "../../src/ingest/live/manager";
import type { ProducerDiscovery } from "../../src/protocol/discovery";
import type { ObservatoryEvent } from "../../src/protocol/events";
import { deriveExecutionRoutes } from "../../src/query/executionRoute";
import { deriveMetrics } from "../../src/query/metrics";
import { stripSeries } from "../../src/query/series";
import { SessionStore } from "../../src/replay/session";
import { describeProbe } from "../../src/renderer/connectionPanel";
import { LiveController, liveNodeSnapshotOf, liveNodesForStore } from "../../src/renderer/liveController";
import { stripItems } from "../../src/renderer/metricStrip";
import {
    embedCardModel,
    liveNodeCardModels,
    renderEmbedCard,
    renderLiveNodeCards,
    renderOverviewCards,
} from "../../src/renderer/overviewCards";
import { producerCardModel, producerNodeSummary, ProducersPanel } from "../../src/renderer/producersPanel";
import { renderRouteCards, routeCardModel, stripBreakdownSummary, stripRouteSummary } from "../../src/renderer/routeBadges";
import { at } from "../helpers";

class FakeNode {
    parentNode: FakeElement | null = null;
    private text = "";

    get textContent(): string {
        return this.text;
    }

    set textContent(value: string) {
        this.text = value;
    }

    remove(): void {
        if (!this.parentNode) {
            return;
        }
        const idx = this.parentNode.childNodes.indexOf(this);
        if (idx >= 0) {
            this.parentNode.childNodes.splice(idx, 1);
        }
        this.parentNode = null;
    }
}

class FakeText extends FakeNode {
    constructor(data: string) {
        super();
        this.textContent = data;
    }
}

class FakeElement extends FakeNode {
    readonly tagName: string;
    readonly childNodes: FakeNode[] = [];
    readonly attrs = new Map<string, string>();
    readonly listeners = new Map<string, ((ev: { preventDefault(): void }) => void)[]>();
    readonly dataset: Record<string, string | undefined>;
    hidden = false;
    value = "";

    constructor(tagName: string, private readonly owner: FakeDocument) {
        super();
        this.tagName = tagName.toUpperCase();
        this.dataset = new Proxy<Record<string, string | undefined>>(
            {},
            {
                get: (_t, prop) => (typeof prop === "string" ? this.attrs.get(`data-${prop}`) : undefined),
                set: (_t, prop, val) => {
                    if (typeof prop === "string") {
                        this.setAttribute(`data-${prop}`, String(val));
                    }
                    return true;
                },
                deleteProperty: (_t, prop) => {
                    if (typeof prop === "string") {
                        this.removeAttribute(`data-${prop}`);
                    }
                    return true;
                },
            },
        );
    }

    get id(): string {
        return this.attrs.get("id") ?? "";
    }

    get className(): string {
        return this.attrs.get("class") ?? "";
    }

    set className(v: string) {
        this.attrs.set("class", v);
    }

    get children(): FakeElement[] {
        return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
    }

    override get textContent(): string {
        if (this.childNodes.length === 0) {
            return super.textContent;
        }
        return this.childNodes.map((n) => n.textContent).join("");
    }

    override set textContent(v: string) {
        this.childNodes.length = 0;
        super.textContent = v;
    }

    setAttribute(name: string, value: string): void {
        if (name === "hidden") {
            this.hidden = true;
        }
        if (name === "id") {
            this.owner.byIdMap.set(value, this);
        }
        this.attrs.set(name, value);
    }

    getAttribute(name: string): string | null {
        return this.attrs.get(name) ?? null;
    }

    removeAttribute(name: string): void {
        if (name === "hidden") {
            this.hidden = false;
        }
        this.attrs.delete(name);
    }

    append(...nodes: (FakeNode | string)[]): void {
        for (const item of nodes) {
            const node = typeof item === "string" ? new FakeText(item) : item;
            node.remove();
            node.parentNode = this;
            this.childNodes.push(node);
        }
    }

    insertBefore(node: FakeNode, ref: FakeNode | null): FakeNode {
        node.remove();
        node.parentNode = this;
        const idx = ref ? this.childNodes.indexOf(ref) : -1;
        if (idx >= 0) {
            this.childNodes.splice(idx, 0, node);
        } else {
            this.childNodes.push(node);
        }
        return node;
    }

    replaceChildren(...nodes: (FakeNode | string)[]): void {
        for (const existing of [...this.childNodes]) {
            existing.parentNode = null;
        }
        this.childNodes.length = 0;
        this.append(...nodes);
    }

    contains(node: FakeNode | null): boolean {
        let cur: FakeNode | null = node;
        while (cur) {
            if (cur === this) {
                return true;
            }
            cur = cur.parentNode;
        }
        return false;
    }

    addEventListener(type: string, fn: (ev: { preventDefault(): void }) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(fn);
        this.listeners.set(type, list);
    }

    focus(): void {
        this.owner.activeElement = this;
    }

    findAll(pred: (el: FakeElement) => boolean): FakeElement[] {
        const out: FakeElement[] = [];
        const walk = (el: FakeElement) => {
            if (pred(el)) {
                out.push(el);
            }
            for (const child of el.children) {
                walk(child);
            }
        };
        walk(this);
        return out;
    }

    find(pred: (el: FakeElement) => boolean): FakeElement | null {
        return this.findAll(pred)[0] ?? null;
    }
}

class FakeDocument {
    activeElement: FakeElement | null = null;
    readonly byIdMap = new Map<string, FakeElement>();

    createElement(tag: string): FakeElement {
        return new FakeElement(tag, this);
    }

    createElementNS(_ns: string, tag: string): FakeElement {
        return new FakeElement(tag, this);
    }

    createTextNode(text: string): FakeText {
        return new FakeText(text);
    }

    getElementById(id: string): FakeElement | null {
        return this.byIdMap.get(id) ?? null;
    }
}

const HYBRID_NODE: ProducerNode = {
    schema: "sonder.inference.node/1",
    nodeId: "NODE1",
    instanceId: "inf-node1-001",
    platform: "windows",
    version: "0.4.0",
    synthetic: false,
    gpus: [
        {
            id: "gpu:0",
            name: "AMD Radeon RX 9060 XT",
            vendor: "AMD",
            vendorId: 0x1002,
            deviceId: 0x7590,
            dedicatedTotalMib: 16_384,
            dedicatedFreeMib: 12_288,
            sharedTotalMib: 16_384,
            effectiveVramMib: 16_384,
            effectiveFreeVramMib: 12_288,
            isIntegratedUma: false,
            backendHint: "Vulkan0",
            source: "dxgi",
        },
        {
            id: "gpu:1",
            name: "AMD Radeon 780M Graphics",
            vendor: "AMD",
            vendorId: 0x1002,
            deviceId: 0x15bf,
            dedicatedTotalMib: 512,
            dedicatedFreeMib: 10_240,
            sharedTotalMib: 16_384,
            effectiveVramMib: 16_384,
            effectiveFreeVramMib: 10_240,
            isIntegratedUma: true,
            backendHint: "Vulkan1",
            source: "dxgi",
        },
    ],
    combinedGpuVramMib: 32_768,
    gpuPool: {
        discreteVramMib: 16_384,
        integratedUmaVramMib: 16_384,
        combinedGpuVramMib: 32_768,
        discreteFreeVramMib: 12_288,
        integratedUmaFreeVramMib: 10_240,
        combinedFreeGpuVramMib: 22_528,
        discreteGpuCount: 1,
        integratedUmaGpuCount: 1,
        hybridVulkanPoolAvailable: true,
        recommendedDevices: ["Vulkan0", "Vulkan1"],
        llamaArgDevice: "Vulkan0,Vulkan1",
    },
    capabilities: {
        hybrid_gpu_spread: true,
        multi_gpu: true,
        uma_telemetry: true,
        disabled_flag: false,
    },
    backends: [
        { name: "llamaserver", available: true, capabilities: ["streaming", "vulkan"] },
        { name: "ollama", available: false, capabilities: ["streaming"] },
    ],
    models: [
        { id: "qwen3:80b-a3b", backend: "llamaserver" },
        { id: "nomic-embed-v1.5", backend: "llamaserver" },
    ],
};

function makeStatus(overrides: Partial<LiveIngestStatus> = {}): LiveIngestStatus {
    return {
        state: "open",
        url: "http://127.0.0.1:11437/v1/telemetry/sse",
        transport: "sse",
        loopback: true,
        warning: null,
        attempts: 1,
        reconnects: 0,
        retryInMs: null,
        lastEventId: null,
        resumeRequested: false,
        received: 10,
        appended: 10,
        dropped: 0,
        rejected: 0,
        buffered: 0,
        bufferCapacity: 20_000,
        batches: 1,
        lastError: null,
        ...overrides,
    };
}

function makeConnection(overrides: Partial<ProducerConnection> = {}): ProducerConnection {
    return {
        id: "producer-1",
        url: "http://127.0.0.1:11437",
        label: null,
        hasToken: false,
        streamUrl: "http://127.0.0.1:11437/v1/telemetry/sse",
        discovery: null,
        health: null,
        identity: {
            name: "sonder-inference",
            version: "0.4.0",
            node_id: "NODE1",
            instance_id: "inf-node1-001",
            role: "inference",
            synthetic: false,
        },
        status: makeStatus(),
        ...overrides,
    };
}

function makeDiscovery(links?: Record<string, string>): ProducerDiscovery {
    return {
        schema: "sonder.telemetry.producer/1",
        producer: {
            name: "sonder-inference",
            version: "0.4.0",
            node_id: "NODE1",
            instance_id: "inf-node1-001",
            role: "inference",
            synthetic: false,
        },
        event_schema: "sonder.observatory.event/1",
        streams: [{ transport: "sse", url: "/events/sse" }],
        resume: { header: "Last-Event-ID", query: "last_event_id", retained_events: 10, oldest_sequence: 0, next_sequence: 10 },
        auth: { required: false, schemes: ["bearer"] },
        clock: { mono_ns: "host-monotonic" },
        ...(links ? { links } : {}),
    };
}

const managers: LiveConnectionManager[] = [];

describe("Wave 3 live /v1/sonder/node and Wave 2 metrics UI integration", () => {
    let prevDocument: unknown;
    let fakeDoc: FakeDocument;
    let panel: ProducersPanel | null = null;

    beforeEach(() => {
        prevDocument = (globalThis as { document?: unknown }).document;
        fakeDoc = new FakeDocument();
        (globalThis as { document?: unknown }).document = fakeDoc;
    });

    afterEach(async () => {
        panel?.dispose();
        panel = null;
        await Promise.all(managers.splice(0).map((m) => m.disconnectAll()));
        if (prevDocument === undefined) {
            delete (globalThis as { document?: unknown }).document;
        } else {
            (globalThis as { document?: unknown }).document = prevDocument;
        }
    });

    it("probeProducer fetches SSRF-allowed links.node and describeProbe summarizes hardware", async () => {
        const base = "http://127.0.0.1:11437";
        const fetchedUrls: string[] = [];
        const fetch = async (input: string): Promise<Response> => {
            fetchedUrls.push(input);
            if (input === `${base}/.well-known/sonder-telemetry`) {
                return Response.json(makeDiscovery({ node: "/v1/sonder/node" }));
            }
            if (input === `${base}/v1/sonder/node`) {
                return Response.json({
                    schema: "sonder.inference.node/1",
                    node_id: "NODE1",
                    instance_id: "inf-node1-001",
                    platform: "windows",
                    version: "0.4.0",
                    gpus: [
                        { id: "gpu:0", name: "RX 9060 XT", is_integrated_uma: false, effective_vram_mib: 16_384, backend_hint: "Vulkan0" },
                        { id: "gpu:1", name: "Radeon 780M", is_integrated_uma: true, effective_vram_mib: 16_384, backend_hint: "Vulkan1" },
                    ],
                    combined_gpu_vram_mib: 32_768,
                    gpu_pool: {
                        discrete_gpu_count: 1,
                        integrated_uma_gpu_count: 1,
                        combined_gpu_vram_mib: 32_768,
                        hybrid_vulkan_pool_available: true,
                        recommended_devices: ["Vulkan0", "Vulkan1"],
                        llama_arg_device: "Vulkan0,Vulkan1",
                    },
                    models: [{ id: "qwen3:80b-a3b", backend: "llamaserver" }],
                });
            }
            throw new TypeError(`unexpected ${input}`);
        };

        const res = await probeProducer(base, { fetch });
        expect(res.ok).toBe(true);
        expect(res.node?.nodeId).toBe("NODE1");
        expect(res.node?.combinedGpuVramMib).toBe(32_768);
        expect(fetchedUrls).toEqual([`${base}/.well-known/sonder-telemetry`, `${base}/v1/sonder/node`]);

        const report = describeProbe(base, res, false);
        expect(report.ok).toBe(true);
        expect(report.lines.at(-1)).toContain("Node (windows):");
        expect(report.lines.at(-1)).toContain("2 GPUs (1 discrete, 1 UMA)");
        expect(report.lines.at(-1)).toContain("32.0 GiB combined VRAM");
        expect(report.lines.at(-1)).toContain("Hybrid Vulkan pool (Vulkan0,Vulkan1)");
        expect(report.lines.at(-1)).toContain("1 model");

        // SSRF-blocked links.node makes zero fetches to the blocked host and still succeeds probe.
        const blockedCalls: string[] = [];
        const blockedRes = await probeProducer(base, {
            fetch: async (input: string) => {
                blockedCalls.push(input);
                if (input === `${base}/.well-known/sonder-telemetry`) {
                    return Response.json(makeDiscovery({ node: "https://169.254.169.254/latest/meta-data/" }));
                }
                throw new TypeError(`unexpected ${input}`);
            },
        });
        expect(blockedRes.ok).toBe(true);
        expect(blockedRes.node).toBeUndefined();
        expect(blockedCalls).toEqual([`${base}/.well-known/sonder-telemetry`]);
    });

    it("LiveConnectionManager deep-clones node snapshots so renderer mutations cannot corrupt manager state", async () => {
        const base = "http://127.0.0.1:11437";
        const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
            if (input === `${base}/.well-known/sonder-telemetry`) {
                return Response.json(makeDiscovery({ node: "/v1/sonder/node" }));
            }
            if (input === `${base}/v1/sonder/node`) {
                return Response.json({
                    schema: "sonder.inference.node/1",
                    node_id: "NODE1",
                    gpus: [{ id: "gpu:0", name: "RX 9060 XT", is_integrated_uma: false, effective_vram_mib: 16_384 }],
                    combined_gpu_vram_mib: 16_384,
                    gpu_pool: { recommended_devices: ["Vulkan0"] },
                });
            }
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(": ok\n\n"));
                    init?.signal?.addEventListener("abort", () => {
                        try {
                            controller.error(new DOMException("aborted", "AbortError"));
                        } catch {
                            // closed
                        }
                    });
                },
            });
            return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
        };

        const m = new LiveConnectionManager(new SessionStore(), { fetch });
        managers.push(m);
        await m.add({ url: base });

        const deadline = Date.now() + 2000;
        while (!m.list()[0]?.node && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 5));
        }
        const snap = m.list()[0]!;
        expect(snap.node?.gpus[0]?.name).toBe("RX 9060 XT");
        snap.node!.gpus[0]!.name = "MUTATED";
        snap.node!.gpuPool!.recommendedDevices.push("EVIL");
        expect(m.list()[0]!.node!.gpus[0]!.name).toBe("RX 9060 XT");
        expect(m.list()[0]!.node!.gpuPool!.recommendedDevices).toEqual(["Vulkan0"]);
    });

    it("renders live /v1/sonder/node hybrid GPU topology, residency, and capabilities in ProducersPanel cleanly and safely", () => {
        panel = new ProducersPanel(
            {
                onDisconnect: vi.fn(),
                onReconnect: vi.fn(),
                onEdit: vi.fn(),
                onRemove: vi.fn(),
            },
            { now: () => 10_000 },
        );

        const hybridConn = makeConnection({ id: "producer-1", node: HYBRID_NODE });
        const cpuOnlyNode: ProducerNode = {
            schema: "sonder.inference.node/1",
            nodeId: "cpu-box",
            instanceId: "inf-cpu-1",
            platform: "linux",
            version: "0.4.0",
            synthetic: false,
            gpus: [],
            combinedGpuVramMib: null,
            gpuPool: null,
            capabilities: {},
            backends: [{ name: "llamaserver", available: true, capabilities: ["cpu"] }],
            models: [{ id: "qwen3:1.7b", backend: "llamaserver" }],
        };
        const cpuConn = makeConnection({
            id: "producer-2",
            identity: { name: "sonder-inference", version: "0.4.0", node_id: "cpu-box", instance_id: "inf-cpu-1", role: "inference", synthetic: false },
            node: cpuOnlyNode,
        });
        const plainConn = makeConnection({ id: "producer-3" });

        const hybridModel = producerCardModel(hybridConn);
        expect(hybridModel.nodeHardware).not.toBeNull();
        expect(hybridModel.nodeHardware!.topologyLabel).toBe("2 GPUs (1 discrete + 1 UMA) · 32.0 GiB VRAM");
        expect(hybridModel.nodeHardware!.hybridPoolAvailable).toBe(true);
        expect(hybridModel.nodeHardware!.residencyLabel).toBe("2 models · 1/2 backends · Vulkan0,Vulkan1 · windows");
        expect(hybridModel.nodeHardware!.activeCapabilities).toEqual(["hybrid_gpu_spread", "multi_gpu", "uma_telemetry"]);

        const cpuSummary = producerNodeSummary(cpuConn)!;
        expect(cpuSummary.topologyLabel).toBe("CPU-only (0 GPUs)");
        expect(cpuSummary.residencyLabel).toBe("1 model · 1/1 backend · linux");
        expect(producerNodeSummary(plainConn)).toBeNull();

        panel.update([hybridModel, producerCardModel(cpuConn), producerCardModel(plainConn)]);

        const root = panel.element as unknown as FakeElement;
        const cards = root.findAll((el) => el.getAttribute("data-testid") === "producer-card");
        expect(cards).toHaveLength(3);

        const [hybridCard, cpuCard, plainCard] = cards as [FakeElement, FakeElement, FakeElement];
        const hwBox = hybridCard.find((el) => el.getAttribute("data-testid") === "producer-node-hw")!;
        expect(hwBox.hidden).toBe(false);
        expect(hwBox.getAttribute("data-source")).toBe("node");
        expect(hybridCard.find((el) => el.getAttribute("data-testid") === "producer-hw-topology")!.textContent).toBe(
            "2 GPUs (1 discrete + 1 UMA) · 32.0 GiB VRAM",
        );
        expect(hybridCard.find((el) => el.getAttribute("data-testid") === "producer-hw-hybrid")!.hidden).toBe(false);
        const gpuRows = hybridCard.findAll((el) => el.className === "producer-hw-gpu");
        expect(gpuRows).toHaveLength(2);
        expect(gpuRows[0]!.getAttribute("data-gpu-class")).toBe("discrete");
        expect(gpuRows[0]!.textContent).toContain("AMD Radeon RX 9060 XT");
        expect(gpuRows[1]!.getAttribute("data-gpu-class")).toBe("integrated-uma");
        expect(gpuRows[1]!.textContent).toContain("UMA");
        expect(hybridCard.find((el) => el.getAttribute("data-testid") === "producer-hw-residency")!.textContent).toContain("2 models · 1/2 backends");
        expect(hybridCard.find((el) => el.getAttribute("data-testid") === "producer-hw-caps")!.textContent).toContain("hybrid_gpu_spread");

        expect(cpuCard.find((el) => el.getAttribute("data-testid") === "producer-hw-topology")!.textContent).toBe("CPU-only (0 GPUs)");
        expect(cpuCard.find((el) => el.getAttribute("data-testid") === "producer-hw-hybrid")!.hidden).toBe(true);
        expect(plainCard.find((el) => el.getAttribute("data-testid") === "producer-node-hw")!.hidden).toBe(true);

        // DOM node identity survives subsequent counter/node patches (buttons stay stable).
        const disconnectBtn = hybridCard.find((el) => el.getAttribute("data-action") === "disconnect")!;
        panel.update([producerCardModel(makeConnection({ id: "producer-1", node: HYBRID_NODE, status: makeStatus({ received: 42 }) }))]);
        expect(root.findAll((el) => el.getAttribute("data-testid") === "producer-card")[0]).toBe(hybridCard);
        expect(hybridCard.find((el) => el.getAttribute("data-action") === "disconnect")).toBe(disconnectBtn);
    });

    it("guards against XSS payloads, anomalous free > total VRAM, and oversized GPU lists", () => {
        const xss = '<img src=x onerror="alert(1)"><script>evil()</script>';
        const xssNode: ProducerNode = {
            ...HYBRID_NODE,
            nodeId: xss,
            gpus: Array.from({ length: 6 }, (_, i) => ({
                id: `gpu:${i}`,
                name: i === 0 ? xss : `GPU ${i}`,
                vendor: "AMD",
                vendorId: null,
                deviceId: null,
                dedicatedTotalMib: 1024,
                dedicatedFreeMib: 9999, // anomalous free > total
                sharedTotalMib: 2048,
                effectiveVramMib: 1024,
                effectiveFreeVramMib: 9999, // anomalous free > total
                isIntegratedUma: i === 1,
                backendHint: `Vulkan${i}`,
                source: "dxgi",
            })),
            capabilities: {
                [xss]: true,
                cap_a: true,
                cap_b: true,
                cap_c: true,
                cap_d: true,
            },
            models: [{ id: xss, backend: xss }],
        };
        const conn = makeConnection({ node: xssNode });
        panel = new ProducersPanel({
            onDisconnect: vi.fn(),
            onReconnect: vi.fn(),
            onEdit: vi.fn(),
            onRemove: vi.fn(),
        });
        panel.update([producerCardModel(conn)]);
        const root = panel.element as unknown as FakeElement;

        // Zero injected <img> or <script> tags anywhere in the DOM tree.
        expect(root.findAll((el) => el.tagName === "IMG" || el.tagName === "SCRIPT")).toEqual([]);
        // Inline GPU list is capped to 4 + "+2 more GPUs".
        expect(root.findAll((el) => el.className === "producer-hw-gpu")).toHaveLength(4);
        expect(root.textContent).toContain("+2 more GPUs");
        // Anomalous free > total never renders negative numbers, NaN, or bogus free > total text.
        const vramEls = root.findAll((el) => el.className.includes("producer-hw-vram"));
        expect(vramEls.map((el) => el.textContent)).toEqual(["1.0 GiB", "1.0 GiB", "1.0 GiB", "1.0 GiB"]);
        expect(root.textContent).not.toMatch(/\bNaN\b|\bInfinity\b/);

        // Overview Live Node card also escapes XSS and clamps/guards anomalous VRAM safely.
        const snap = liveNodeSnapshotOf(conn)!;
        const models = liveNodeCardModels([snap]);
        expect(models[0]!.gpus[0]!.usedPercent).toBeNull();
        expect(models[0]!.gpus[0]!.usageText).toBe("1.0 GiB VRAM total");
        const rendered = renderLiveNodeCards([snap]) as unknown as FakeElement[];
        expect(rendered[0]!.findAll((el) => el.tagName === "IMG" || el.tagName === "SCRIPT")).toEqual([]);
        expect(rendered[0]!.textContent).toContain(xss);
    });

    it("falls back to GPU-enriched /v1/sonder/health when links.node is absent, and returns null for legacy health", () => {
        const legacyHealth: ProducerHealth = {
            backends: [{ name: "ollama", available: true, capabilities: ["streaming"] }],
            models: [{ id: "qwen3:14b", backend: "ollama" }],
            telemetryLevel: "standard",
        };
        expect(liveNodeSnapshotOf(makeConnection({ health: legacyHealth }))).toBeNull();

        const gpuHealth: ProducerHealth = {
            ...legacyHealth,
            gpus: HYBRID_NODE.gpus,
            gpuPool: HYBRID_NODE.gpuPool,
            combinedGpuVramMib: 32_768,
        };
        const snap = liveNodeSnapshotOf(makeConnection({ health: gpuHealth }))!;
        expect(snap.source).toBe("health");
        expect(snap.gpus).toHaveLength(2);
        expect(snap.combinedGpuVramMib).toBe(32_768);
        expect(snap.modelCount).toBe(1);
    });

    it("tracks live nodes per SessionStore via LiveController and clears on offline replacement", () => {
        const store = new SessionStore();
        const ctrl = new LiveController(store, {
            onAppend: vi.fn(),
            onBeforeAddProducer: vi.fn(),
            onEditFill: vi.fn(),
            onRender: vi.fn(),
            onQueueRender: vi.fn(),
        });
        ctrl.subscribe();
        expect(liveNodesForStore(store)).toEqual([]);
        expect(ctrl.nodeSnapshots()).toEqual([]);
        expect(ctrl.nodeByInstance().map.size).toBe(0);

        let loaded = false;
        ctrl.afterLiveStopped(() => {
            loaded = true;
        });
        expect(loaded).toBe(true);
        expect(liveNodesForStore(store)).toEqual([]);
    });

    it("renders Wave 2 execution_route breakdown, orchestration spans, embeddings card, and live node card in overviewCards and metricStrip", () => {
        const rt = { name: "sonder-runtime", version: "0.9.0", node_id: "workstation", instance_id: "rt-1", role: "runtime" };
        const inf = { name: "sonder-inference", version: "0.4.0", node_id: "NODE1", instance_id: "inf-node1-001", role: "inference" };
        const events: ObservatoryEvent[] = [
            // Route + request with latency
            at(0, "route.selected", {
                producer: rt,
                request_id: "turn-ens",
                attributes: {
                    execution_route: {
                        mode: "ensemble",
                        band: "hard",
                        difficulty_score: 0.81,
                        recommended_tiers: ["code", "reasoning"],
                        auto_selected: true,
                    },
                },
            }),
            at(10, "request.started", { producer: rt, request_id: "turn-ens", attributes: { kind: "chat" } }),
            at(210, "request.completed", { producer: rt, request_id: "turn-ens", attributes: { total_ms: 200 } }),

            // Fanout orchestration with 2 workers (1 ok, 1 failed)
            at(220, "fanout.started", {
                producer: rt,
                request_id: "turn-fan",
                attributes: { fanout_run_id: "fan-1", fanout_scope: "local", worker_count: 2, tiers: ["code", "fast"] },
            }),
            at(230, "fanout.worker.started", { producer: rt, request_id: "turn-fan", attributes: { fanout_run_id: "fan-1" } }),
            at(235, "fanout.worker.started", { producer: rt, request_id: "turn-fan", attributes: { fanout_run_id: "fan-1" } }),
            at(300, "fanout.worker.failed", { producer: rt, request_id: "turn-fan", attributes: { fanout_run_id: "fan-1" } }),
            at(360, "fanout.worker.completed", { producer: rt, request_id: "turn-fan", attributes: { fanout_run_id: "fan-1" } }),
            at(420, "fanout.completed", { producer: rt, request_id: "turn-fan", attributes: { fanout_run_id: "fan-1" } }),

            // Embeddings: queued fallback, upgraded started, failed, and outcome-only (excluded from latency)
            at(500, "request.queued", {
                producer: inf,
                request_id: "emb-1",
                model_instance_id: "nomic-embed-v1.5",
                attributes: { kind: "embed", inputs: 4 },
            }),
            at(530, "request.completed", {
                producer: inf,
                request_id: "emb-1",
                attributes: { kind: "embed", total_ms: 30 },
            }),
            at(550, "request.queued", { producer: inf, request_id: "emb-2", attributes: { kind: "embed" } }),
            at(570, "request.failed", { producer: inf, request_id: "emb-2", attributes: { kind: "embed", total_ms: 20 } }),
            at(600, "request.cancelled", { producer: inf, request_id: "emb-3", attributes: { endpoint: "/v1/embeddings" } }),
        ];

        const m = deriveMetrics(events);
        const routes = deriveExecutionRoutes(events);
        const series = stripSeries(events, m);

        // Embeddings model & card
        const embModel = embedCardModel(m)!;
        expect(embModel.total).toBe(3);
        expect(embModel.completed).toBe(1);
        expect(embModel.failed).toBe(1);
        expect(embModel.cancelled).toBe(1);
        expect(embModel.measurableCount).toBe(2);
        expect(embModel.p50Ms).toBe(20);
        expect(embModel.p95Ms).toBe(30);
        expect(embModel.tone).toBe("tone-error");
        expect(embModel.models).toEqual([["nomic-embed-v1.5", 1]]);
        const embEl = renderEmbedCard(m) as unknown as FakeElement;
        expect(embEl.getAttribute("data-testid")).toBe("embed-metrics-card");
        expect(embEl.textContent).toContain("3 embed req");
        expect(embEl.textContent).toContain("Span reconstruction: queued ×2 · outcome-only ×1");

        // Route + Orchestration model & card
        const rcModel = routeCardModel(routes, { breakdown: m.executionRoutes, orchestration: m.orchestration })!;
        expect(rcModel.bandStats.map((b) => [b.band, b.count, b.p50Ms])).toEqual([["hard", 1, 200]]);
        expect(rcModel.modeLatencies).toEqual([{ mode: "ensemble", label: "Ensemble", count: 1, p50Ms: 200, p95Ms: 200, maxMs: 200 }]);
        expect(rcModel.orchestrationKinds).toHaveLength(1);
        expect(rcModel.orchestrationKinds[0]!.summaryText).toBe("×1 · 1 ok");
        expect(rcModel.orchestrationSpans[0]!.participantsText).toBe("1/2 ok, 1 failed workers");
        const rcEls = renderRouteCards(routes, { breakdown: m.executionRoutes, orchestration: m.orchestration }) as unknown as FakeElement[];
        expect(rcEls[0]!.find((el) => el.getAttribute("data-testid") === "route-breakdown")).not.toBeNull();
        expect(rcEls[0]!.find((el) => el.getAttribute("data-testid") === "orchestration-summary")).not.toBeNull();
        expect(rcEls[0]!.find((el) => el.getAttribute("data-testid") === "orchestration-spans")!.textContent).toContain("1/2 ok, 1 failed workers");

        // Metric strip integrates embed count and orchestration summary while keeping exact 6 cards.
        const items = stripItems(m, series, { routes });
        expect(items).toHaveLength(6);
        const byId = Object.fromEntries(items.map((i) => [i.id, i]));
        expect(byId["latency-p50"]!.sub).toContain("3 embed");
        expect(byId.agents!.sub).toContain("orch 1 done");
        expect(stripRouteSummary(routes, m.orchestration)).toContain("orch 1 done");
        expect(stripBreakdownSummary(m.executionRoutes, m.orchestration)).toContain("1 ensemble");
        expect(stripBreakdownSummary(m.executionRoutes, m.orchestration)).toContain("orch 1 done");

        // Full renderOverviewCards mounts live node card, route+orchestration card, and embed card into #cards.
        const cardsHost = fakeDoc.createElement("div");
        cardsHost.setAttribute("id", "cards");
        const liveSnap = liveNodeSnapshotOf(makeConnection({ node: HYBRID_NODE }))!;
        renderOverviewCards(m, events, events.length, { rejectedCount: 0, droppedByRetention: 0, source: "live" }, [liveSnap]);

        expect(cardsHost.find((el) => el.getAttribute("data-testid") === "embed-metrics-card")).not.toBeNull();
        expect(cardsHost.find((el) => el.getAttribute("data-testid") === "execution-route-card")).not.toBeNull();
        const liveNodeCard = cardsHost.find((el) => el.getAttribute("data-testid") === "live-node-card")!;
        expect(liveNodeCard).not.toBeNull();
        expect(liveNodeCard.getAttribute("data-live-node")).toBe("NODE1");
        expect(liveNodeCard.find((el) => el.getAttribute("data-testid") === "live-node-pool")!.textContent).toContain("Hybrid Vulkan Pool Ready");
        expect(liveNodeCard.find((el) => el.getAttribute("data-testid") === "live-node-residency")!.textContent).toContain("Models: 2");
        expect(liveNodeCard.find((el) => el.getAttribute("data-testid") === "live-node-residency")!.textContent).toContain("Backends: 1/2 available");
        // Verify UMA GPU row never emits false spill warnings.
        const umaRow = liveNodeCard.find((el) => el.getAttribute("data-gpu-class") === "integrated-uma")!;
        expect(umaRow.textContent).toContain("512.0 MiB carveout + 16.0 GiB shared GTT");
        expect(umaRow.textContent).not.toMatch(/SPILL/i);
    });

    it("renders orchestration-only streams without route.selected events and returns null for empty streams", () => {
        const emptyMetrics = deriveMetrics([]);
        expect(embedCardModel(emptyMetrics)).toBeNull();
        expect(renderEmbedCard(emptyMetrics)).toBeNull();
        expect(stripBreakdownSummary(emptyMetrics.executionRoutes, emptyMetrics.orchestration)).toBeNull();

        const rt = { name: "sonder-runtime", version: "0.9.0", node_id: "ws", instance_id: "rt-1", role: "runtime" };
        const orchOnlyEvents = [
            at(10, "ensemble.started", { producer: rt, run_id: "r1", attributes: { ensemble: { mode: "code", count: 2 } } }),
            at(50, "ensemble.candidate.started", { producer: rt, run_id: "r1" }),
        ];
        const m = deriveMetrics(orchOnlyEvents);
        const emptyRoutes = deriveExecutionRoutes([]);
        const card = routeCardModel(emptyRoutes, { breakdown: m.executionRoutes, orchestration: m.orchestration })!;
        expect(card.value).toBe("Ensemble ×1");
        expect(card.sub).toContain("1 orchestration run");
        expect(card.sub).toContain("orch 1 active");
        expect(card.latestBadge).toBeNull();
        expect(card.orchestrationSpans[0]!.durationText).toBe("in flight");
    });
});
