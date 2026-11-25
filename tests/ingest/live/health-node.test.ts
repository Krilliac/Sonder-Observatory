/**
 * Producer health GPU inventory (`gpus[]`, `gpu_pool`, `combined_gpu_vram_mib`),
 * `/v1/sonder/node` (`links.node`) parsing, strict SSRF host/origin/redirect
 * guards, and LiveConnectionManager integration.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
    MAX_NODE_BYTES,
    fetchProducerNode,
    healthUrl,
    isAllowedNodeHost,
    nodeUrl,
    parseGpuInventory,
    parseGpuPool,
    parseHealth,
    parseNode,
} from "../../../src/ingest/live/health";
import { LiveConnectionManager } from "../../../src/ingest/live/manager";
import type { ProducerDiscovery } from "../../../src/protocol/discovery";
import { SessionStore } from "../../../src/replay/session";

const NODE1_GPUS = [
    {
        id: "gpu:0",
        name: "AMD Radeon RX 9060 XT",
        vendor: "AMD",
        vendor_id: 0x1002,
        device_id: 0x7590,
        dedicated_total_mib: 16_384,
        dedicated_free_mib: 14_336,
        shared_total_mib: 16_384,
        effective_vram_mib: 16_384,
        effective_free_vram_mib: 14_336,
        is_integrated_uma: false,
        backend_hint: "Vulkan0",
        source: "dxgi",
    },
    {
        id: "gpu:1",
        name: "AMD Radeon 780M Graphics",
        vendor: "AMD",
        vendor_id: 0x1002,
        device_id: 0x15bf,
        dedicated_total_mib: 512,
        dedicated_free_mib: 14_000,
        shared_total_mib: 16_384,
        effective_vram_mib: 16_384,
        effective_free_vram_mib: 14_000,
        is_integrated_uma: true,
        backend_hint: "Vulkan1",
        source: "dxgi",
    },
];

const NODE1_POOL = {
    discrete_vram_mib: 16_384,
    integrated_uma_vram_mib: 16_384,
    combined_gpu_vram_mib: 32_768,
    discrete_free_vram_mib: 14_336,
    integrated_uma_free_vram_mib: 14_000,
    combined_free_gpu_vram_mib: 28_336,
    discrete_gpu_count: 1,
    integrated_uma_gpu_count: 1,
    hybrid_vulkan_pool_available: true,
    recommended_devices: ["Vulkan0", "Vulkan1"],
    llama_arg_device: "Vulkan0,Vulkan1",
};

const NODE1_DOC = {
    schema: "sonder.inference.node/1",
    node_id: "node1",
    instance_id: "inf-node1-001",
    platform: "windows",
    version: "0.4.0",
    synthetic: false,
    gpus: NODE1_GPUS,
    combined_gpu_vram_mib: 32_768,
    gpu_pool: NODE1_POOL,
    backends: [{ name: "llamaserver", available: true, capabilities: ["streaming", "vulkan"] }],
    models: [{ id: "qwen3:32b", backend: "llamaserver" }],
    capabilities: {
        hybrid_gpu_spread: true,
        multi_gpu: true,
        uma_telemetry: true,
    },
};

function discoveryDoc(links: Record<string, string>): ProducerDiscovery {
    return {
        schema: "sonder.telemetry.producer/1",
        producer: {
            name: "sonder-inference",
            version: "0.4.0",
            node_id: "node1",
            instance_id: "inf-node1-001",
            role: "inference",
            synthetic: false,
        },
        event_schema: "sonder.observatory.event/1",
        streams: [{ transport: "sse", url: "/events/sse" }],
        resume: { header: "Last-Event-ID", query: "last_event_id", retained_events: 0, oldest_sequence: 0, next_sequence: 0 },
        auth: { required: false, schemes: ["bearer"] },
        clock: { mono_ns: "host-monotonic" },
        links,
    };
}

function openEmptySse(signal: AbortSignal | undefined): Response {
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(": connected\n\n"));
            signal?.addEventListener("abort", () => {
                try {
                    controller.error(new DOMException("aborted", "AbortError"));
                } catch {
                    // closed
                }
            });
        },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

const managers: LiveConnectionManager[] = [];

afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.disconnectAll()));
});

async function waitFor(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await new Promise((r) => setTimeout(r, 5));
    }
}

describe("parseHealth / parseGpuInventory / parseGpuPool / parseNode", () => {
    it("omits optional GPU fields from legacy /v1/sonder/health responses without gpus[]", () => {
        const parsed = parseHealth({
            status: "ready",
            backends: [{ name: "ollama", available: true, capabilities: ["streaming"] }],
            models: [{ id: "qwen3:14b", backend: "ollama" }],
            telemetry: { level: "standard" },
        });
        expect(parsed).toEqual({
            backends: [{ name: "ollama", available: true, capabilities: ["streaming"] }],
            models: [{ id: "qwen3:14b", backend: "ollama" }],
            telemetryLevel: "standard",
        });
        expect("gpus" in parsed!).toBe(false);
        expect("gpuPool" in parsed!).toBe(false);
        expect("combinedGpuVramMib" in parsed!).toBe(false);
    });

    it("parses gpus[], gpu_pool, and combined_gpu_vram_mib from /v1/sonder/health", () => {
        const parsed = parseHealth({
            backends: [{ name: "llamaserver", available: true, capabilities: ["vulkan"] }],
            models: [{ id: "qwen3:32b", backend: "llamaserver" }],
            telemetry: { level: "full" },
            gpus: NODE1_GPUS,
            gpu_pool: NODE1_POOL,
            combined_gpu_vram_mib: 32_768,
        });
        expect(parsed).not.toBeNull();
        expect(parsed!.gpus).toHaveLength(2);
        expect(parsed!.gpus![0]).toMatchObject({
            id: "gpu:0",
            name: "AMD Radeon RX 9060 XT",
            effectiveVramMib: 16_384,
            isIntegratedUma: false,
            backendHint: "Vulkan0",
        });
        expect(parsed!.gpus![1]).toMatchObject({
            id: "gpu:1",
            name: "AMD Radeon 780M Graphics",
            dedicatedTotalMib: 512,
            sharedTotalMib: 16_384,
            effectiveVramMib: 16_384,
            effectiveFreeVramMib: 14_000,
            isIntegratedUma: true,
            backendHint: "Vulkan1",
        });
        expect(parsed!.gpuPool).toMatchObject({
            discreteVramMib: 16_384,
            integratedUmaVramMib: 16_384,
            combinedGpuVramMib: 32_768,
            hybridVulkanPoolAvailable: true,
            recommendedDevices: ["Vulkan0", "Vulkan1"],
            llamaArgDevice: "Vulkan0,Vulkan1",
        });
        expect(parsed!.combinedGpuVramMib).toBe(32_768);
    });

    it("parses full sonder.inference.node/1 documents and rejects invalid shapes/schemas", () => {
        const node = parseNode(NODE1_DOC);
        expect(node).not.toBeNull();
        expect(node!.schema).toBe("sonder.inference.node/1");
        expect(node!.nodeId).toBe("node1");
        expect(node!.instanceId).toBe("inf-node1-001");
        expect(node!.platform).toBe("windows");
        expect(node!.version).toBe("0.4.0");
        expect(node!.synthetic).toBe(false);
        expect(node!.gpus).toHaveLength(2);
        expect(node!.combinedGpuVramMib).toBe(32_768);
        expect(node!.gpuPool?.hybridVulkanPoolAvailable).toBe(true);
        expect(node!.capabilities).toEqual({
            hybrid_gpu_spread: true,
            multi_gpu: true,
            uma_telemetry: true,
        });

        expect(parseNode(null)).toBeNull();
        expect(parseNode({})).toBeNull();
        expect(parseNode({ schema: "other.service/1", gpus: NODE1_GPUS })).toBeNull();
        expect(parseGpuPool({})).toBeNull();
    });

    it("caps oversized GPU arrays, recommended_devices lists, and text fields cleanly", () => {
        const manyGpus = Array.from({ length: 100 }, (_, i) => ({
            id: `gpu:${i}`,
            name: "X".repeat(500),
            effective_vram_mib: 1024,
        }));
        const gpus = parseGpuInventory(manyGpus);
        expect(gpus).toHaveLength(64);
        expect(gpus[0]!.name.length).toBe(256);

        const pool = parseGpuPool({
            recommended_devices: Array.from({ length: 80 }, (_, i) => `Vulkan${i}`),
        });
        expect(pool?.recommendedDevices).toHaveLength(32);
    });
});

describe("SSRF host and URL guards (isAllowedNodeHost, nodeUrl, healthUrl, fetchProducerNode)", () => {
    it("allows loopback, RFC 1918 private IPv4, RFC 4193 IPv6 ULA, and .local / .home.arpa hosts", () => {
        const allowedHosts = [
            "localhost",
            "127.0.0.1",
            "127.255.255.254",
            "::1",
            "[::1]",
            "10.0.0.1",
            "10.77.0.2",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.0.1",
            "192.168.1.50",
            "[fc00::1]",
            "[fd12:3456:789a::1]",
            "node1.local",
            "box.home.arpa",
        ];
        for (const host of allowedHosts) {
            expect(isAllowedNodeHost(host), `expected ${host} to be allowed`).toBe(true);
        }

        expect(nodeUrl("http://127.0.0.1:11437/.well-known/sonder-telemetry", "/v1/sonder/node")).toBe(
            "http://127.0.0.1:11437/v1/sonder/node",
        );
        expect(nodeUrl("http://localhost:11437/.well-known/sonder-telemetry", "/v1/sonder/node")).toBe(
            "http://localhost:11437/v1/sonder/node",
        );
        expect(nodeUrl("http://[::1]:11437/.well-known/sonder-telemetry", "/v1/sonder/node")).toBe(
            "http://[::1]:11437/v1/sonder/node",
        );
        expect(nodeUrl("https://10.77.0.2:8443/.well-known/sonder-telemetry", "/v1/sonder/node")).toBe(
            "https://10.77.0.2:8443/v1/sonder/node",
        );
        expect(nodeUrl("https://node1.local:8443/.well-known/sonder-telemetry", "/v1/sonder/node")).toBe(
            "https://node1.local:8443/v1/sonder/node",
        );
        expect(nodeUrl("https://[fd00::1]:8443/.well-known/sonder-telemetry", "/v1/sonder/node")).toBe(
            "https://[fd00::1]:8443/v1/sonder/node",
        );
    });

    it("rejects cloud IMDS, IPv4-mapped IPv6 bypasses, link-local, public IPs/domains, and malformed hosts", () => {
        const blockedHosts = [
            "",
            "169.254.169.254",
            "169.254.0.1",
            "metadata.google.internal",
            "metadata",
            "instance-data",
            "0.0.0.0",
            "0.1.2.3",
            "::",
            "[::]",
            "[fe80::1]",
            "[fe80::1%eth0]",
            "[fc00::1%eth0]",
            "[::ffff:169.254.169.254]",
            "[::ffff:a9fe:a9fe]",
            "[::ffff:8.8.8.8]",
            "[::ffff:0808:0808]",
            "[::ffff:0.0.0.0]",
            "8.8.8.8",
            "1.1.1.1",
            "172.15.255.255",
            "172.32.0.1",
            "192.169.0.1",
            "100.64.0.1",
            "example.com",
            "localhost.evil.com",
            "127.0.0.1.evil.com",
            "node1.internal",
            "node1.local.",
            ".local",
            "..local",
            "-bad.local",
            "127.999.0.1",
            "0177.0.0.1",
        ];
        for (const host of blockedHosts) {
            expect(isAllowedNodeHost(host), `expected ${host} to be rejected`).toBe(false);
        }
    });

    it("rejects cross-origin, plain-HTTP non-loopback, credential/token URLs, and IMDS links in nodeUrl/healthUrl", () => {
        const baseLoopback = "http://127.0.0.1:11437/.well-known/sonder-telemetry";
        const baseNode1 = "https://10.77.0.2:8443/.well-known/sonder-telemetry";

        // Cross-origin & protocol-relative links
        expect(nodeUrl(baseLoopback, "http://127.0.0.1:9/v1/sonder/node")).toBeNull();
        expect(nodeUrl(baseLoopback, "https://10.77.0.2:8443/v1/sonder/node")).toBeNull();
        expect(nodeUrl(baseLoopback, "//evil.example/v1/sonder/node")).toBeNull();
        expect(nodeUrl(baseLoopback, "file:///etc/passwd")).toBeNull();
        expect(nodeUrl(baseLoopback, "javascript:alert(1)")).toBeNull();

        // Plain HTTP to private non-loopback host violates endpoint policy
        expect(nodeUrl("http://10.77.0.2:8443/.well-known/sonder-telemetry", "/v1/sonder/node")).toBeNull();

        // Cloud IMDS & IPv4-mapped IPv6 even when same-origin with discovery URL
        expect(nodeUrl("https://169.254.169.254/.well-known/sonder-telemetry", "/latest/meta-data/")).toBeNull();
        expect(nodeUrl("https://[::ffff:169.254.169.254]/.well-known/sonder-telemetry", "/v1/sonder/node")).toBeNull();
        expect(nodeUrl("https://metadata.google.internal/.well-known/sonder-telemetry", "/v1/sonder/node")).toBeNull();
        expect(nodeUrl("https://example.com/.well-known/sonder-telemetry", "/v1/sonder/node")).toBeNull();

        // Credentials & secret query parameters (including semicolon separator)
        expect(nodeUrl(baseLoopback, "/v1/sonder/node?token=secret")).toBeNull();
        expect(nodeUrl(baseLoopback, "/v1/sonder/node?a=1;api_key=secret")).toBeNull();
        expect(nodeUrl("http://user:pass@127.0.0.1:11437/.well-known/sonder-telemetry", "/v1/sonder/node")).toBeNull();
        expect(healthUrl(baseLoopback, "/v1/sonder/health?access_token=secret")).toBeNull();
        expect(healthUrl(baseNode1, "https://other.local:8443/v1/sonder/health")).toBeNull();
    });

    it("fetchProducerNode makes 0 fetch calls on SSRF/policy-blocked URLs and enforces redirect/size/credential guards", async () => {
        const fetchedUrls: string[] = [];
        const blockedUrls = [
            "https://169.254.169.254/latest/meta-data/",
            "https://[::ffff:169.254.169.254]/v1/sonder/node",
            "https://[::ffff:8.8.8.8]/v1/sonder/node",
            "https://metadata.google.internal/computeMetadata/v1/",
            "https://8.8.8.8/v1/sonder/node",
            "https://example.com/v1/sonder/node",
            "http://10.77.0.2:8443/v1/sonder/node",
            "http://127.0.0.1:11437/v1/sonder/node?token=leak",
            "http://127.0.0.1:11437/v1/sonder/node?x=1;api_key=leak",
            "file:///etc/passwd",
        ];

        for (const bad of blockedUrls) {
            const res = await fetchProducerNode(bad, {
                token: "super-secret",
                fetch: async (input) => {
                    fetchedUrls.push(input);
                    return Response.json(NODE1_DOC);
                },
            });
            expect(res, `expected ${bad} to return null`).toBeNull();
        }
        expect(fetchedUrls).toEqual([]);

        // Refuses HTTP 302 redirect without following.
        const redirectResult = await fetchProducerNode("https://10.77.0.2:8443/v1/sonder/node", {
            token: "secret",
            fetch: async (_input, init) => {
                expect(init?.redirect).toBe("manual");
                expect(init?.credentials).toBe("omit");
                expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer secret");
                return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest" } });
            },
        });
        expect(redirectResult).toBeNull();

        // Refuses oversized response (> MAX_NODE_BYTES).
        const hugeResult = await fetchProducerNode("http://127.0.0.1:11437/v1/sonder/node", {
            fetch: async () => new Response(" ".repeat(MAX_NODE_BYTES + 64), { status: 200 }),
        });
        expect(hugeResult).toBeNull();

        // Succeeds on valid private HTTPS node endpoint.
        const okResult = await fetchProducerNode("https://10.77.0.2:8443/v1/sonder/node", {
            token: "node1-token",
            fetch: async () => Response.json(NODE1_DOC),
        });
        expect(okResult?.nodeId).toBe("node1");
        expect(okResult?.combinedGpuVramMib).toBe(32_768);
        expect(okResult?.gpuPool?.hybridVulkanPoolAvailable).toBe(true);
    });
});

describe("LiveConnectionManager — discovery links.health gpus[] and links.node integration", () => {
    it("populates health.gpus[] and connection.node from same-origin discovery links with bearer token", async () => {
        const base = "https://10.77.0.2:8443";
        const calls: { url: string; auth?: string; redirect?: RequestRedirect; credentials?: RequestCredentials }[] = [];
        const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
            const headers = (init?.headers as Record<string, string> | undefined) ?? {};
            calls.push({ url: input, auth: headers.Authorization, redirect: init?.redirect, credentials: init?.credentials });
            if (input === `${base}/.well-known/sonder-telemetry`) {
                return Response.json(discoveryDoc({ health: "/v1/sonder/health", node: "/v1/sonder/node" }));
            }
            if (input === `${base}/v1/sonder/health`) {
                return Response.json({
                    backends: [{ name: "llamaserver", available: true, capabilities: ["vulkan"] }],
                    models: [{ id: "qwen3:32b", backend: "llamaserver" }],
                    telemetry: { level: "standard" },
                    gpus: NODE1_GPUS,
                    gpu_pool: NODE1_POOL,
                    combined_gpu_vram_mib: 32_768,
                });
            }
            if (input === `${base}/v1/sonder/node`) {
                return Response.json(NODE1_DOC);
            }
            if (input === `${base}/events/sse`) {
                return openEmptySse(init?.signal ?? undefined);
            }
            throw new TypeError(`unexpected url ${input}`);
        };

        const m = new LiveConnectionManager(new SessionStore(), { fetch });
        managers.push(m);
        await m.add({ url: base, token: "node1-secret" });

        await waitFor(() => m.list()[0]?.health !== null && m.list()[0]?.node !== undefined, "health + node");
        const conn = m.list()[0]!;
        expect(conn.health?.gpus).toHaveLength(2);
        expect(conn.health?.combinedGpuVramMib).toBe(32_768);
        expect(conn.node?.nodeId).toBe("node1");
        expect(conn.node?.gpus[1]?.isIntegratedUma).toBe(true);
        expect(conn.node?.gpuPool?.recommendedDevices).toEqual(["Vulkan0", "Vulkan1"]);
        expect(conn.node?.capabilities.hybrid_gpu_spread).toBe(true);

        const nodeCall = calls.find((c) => c.url === `${base}/v1/sonder/node`);
        expect(nodeCall).toBeDefined();
        expect(nodeCall!.auth).toBe("Bearer node1-secret");
        expect(nodeCall!.redirect).toBe("manual");
        expect(nodeCall!.credentials).toBe("omit");
    });

    it("never fetches a cross-origin or SSRF links.node and never leaks the bearer token", async () => {
        const base = "http://127.0.0.1:11437";
        const calledUrls: string[] = [];
        const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
            calledUrls.push(input);
            if (input === `${base}/.well-known/sonder-telemetry`) {
                return Response.json(discoveryDoc({ node: "https://169.254.169.254/latest/meta-data/" }));
            }
            if (input === `${base}/events/sse`) {
                return openEmptySse(init?.signal ?? undefined);
            }
            throw new TypeError(`unexpected url ${input}`);
        };

        const m = new LiveConnectionManager(new SessionStore(), { fetch });
        managers.push(m);
        await m.add({ url: base, token: "do-not-leak" });
        await waitFor(() => calledUrls.includes(`${base}/events/sse`), "stream");

        expect(calledUrls.some((u) => u.includes("169.254.169.254"))).toBe(false);
        expect(m.list()[0]!.node).toBeUndefined();
    });
});
