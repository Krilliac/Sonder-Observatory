import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type TestInfo } from "@playwright/test";
import type { ObservatoryEvent } from "../src/protocol/events";
import { confirmQueryConnects } from "./helpers";

const A11Y_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

interface MockNodeProducer {
    baseUrl: string;
    close(): Promise<void>;
}

function buildWave2LiveEvents(): ObservatoryEvent[] {
    const rt = {
        name: "sonder-runtime",
        version: "0.9.0",
        node_id: "workstation",
        instance_id: "rt-w3-e2e",
        role: "runtime",
        synthetic: true,
    } as const;
    const inf = {
        name: "sonder-inference",
        version: "0.4.0",
        node_id: "NODE1",
        instance_id: "inf-w3-e2e",
        role: "inference",
        synthetic: true,
    } as const;
    const baseWall = Date.parse("2026-11-25T11:00:00.000Z");
    let seqInf = 0;
    let seqRt = 0;

    const ev = (
        ms: number,
        producer: typeof rt | typeof inf,
        event_type: string,
        extra: Partial<ObservatoryEvent> = {},
    ): ObservatoryEvent => {
        const sequence = producer === inf ? seqInf++ : seqRt++;
        return {
            schema: "sonder.observatory.event/1",
            event_id: `${producer.instance_id}-${sequence}`,
            sequence,
            event_type,
            wall_time: new Date(baseWall + ms).toISOString(),
            mono_ns: Math.round(ms * 1_000_000),
            session_id: "ses-w3-e2e",
            run_id: "run-w3-e2e",
            request_id: null,
            agent_id: null,
            task_id: null,
            model_instance_id: null,
            device_id: null,
            producer,
            attributes: {},
            ...extra,
        };
    };

    return [
        ev(0, inf, "session.started", { attributes: { text_capture: "none", role: "inference" } }),
        ev(5, inf, "session.created", { attributes: { model: "qwen3-80b-a3b-q4_k_m" } }),

        // Turn 1: Hard Ensemble route + finished request (200 ms) + ensemble orchestration lifecycle
        ev(100, rt, "route.selected", {
            request_id: "turn-ens",
            attributes: {
                execution_route: {
                    mode: "ensemble",
                    band: "hard",
                    difficulty_score: 0.84,
                    recommended_tiers: ["code", "reasoning"],
                    ensemble_mode: "code",
                    auto_selected: true,
                    reason: "hard architecture prompt routed to parallel ensemble",
                },
            },
        }),
        ev(105, rt, "request.started", { request_id: "turn-ens", attributes: { kind: "chat" } }),
        ev(110, rt, "ensemble.started", {
            request_id: "turn-ens",
            attributes: { ensemble: { id: "ens-1", mode: "code", tiers: ["code", "reasoning"], count: 2 } },
        }),
        ev(120, rt, "ensemble.candidate.started", { request_id: "turn-ens", attributes: { ensemble_id: "ens-1" } }),
        ev(125, rt, "ensemble.candidate.started", { request_id: "turn-ens", attributes: { ensemble_id: "ens-1" } }),
        ev(240, rt, "ensemble.candidate.completed", { request_id: "turn-ens", attributes: { ensemble_id: "ens-1" } }),
        ev(260, rt, "ensemble.candidate.completed", { request_id: "turn-ens", attributes: { ensemble_id: "ens-1" } }),
        ev(290, rt, "ensemble.completed", { request_id: "turn-ens", attributes: { ensemble_id: "ens-1" } }),
        ev(305, rt, "request.completed", { request_id: "turn-ens", attributes: { total_ms: 200 } }),

        // Turn 2: Multi-Scope Fanout route + finished request (350 ms) + fanout orchestration (1 ok, 1 failed)
        ev(400, rt, "route.selected", {
            request_id: "turn-fan",
            attributes: {
                execution_route: {
                    mode: "fanout",
                    band: "multi_scope",
                    difficulty_score: 0.91,
                    fanout_scope: "local",
                    auto_selected: true,
                    reason: "multi-module review routed to bounded local fanout",
                },
            },
        }),
        ev(405, rt, "request.started", { request_id: "turn-fan", attributes: { kind: "chat" } }),
        ev(410, rt, "fanout.started", {
            request_id: "turn-fan",
            attributes: { fanout_run_id: "fan-1", fanout_scope: "local", worker_count: 2, tiers: ["code", "fast"] },
        }),
        ev(420, rt, "fanout.worker.started", { request_id: "turn-fan", attributes: { fanout_run_id: "fan-1" } }),
        ev(425, rt, "fanout.worker.started", { request_id: "turn-fan", attributes: { fanout_run_id: "fan-1" } }),
        ev(520, rt, "fanout.worker.failed", { request_id: "turn-fan", attributes: { fanout_run_id: "fan-1" } }),
        ev(680, rt, "fanout.worker.completed", { request_id: "turn-fan", attributes: { fanout_run_id: "fan-1" } }),
        ev(730, rt, "fanout.completed", { request_id: "turn-fan", attributes: { fanout_run_id: "fan-1" } }),
        ev(755, rt, "request.completed", { request_id: "turn-fan", attributes: { total_ms: 350 } }),

        // Embeddings requests: legacy Session::embed queued -> completed + upgraded queued -> started -> completed
        ev(800, inf, "request.queued", {
            request_id: "emb-legacy",
            model_instance_id: "nomic-embed-v1.5",
            attributes: { kind: "embed", inputs: 4 },
        }),
        ev(835, inf, "request.completed", {
            request_id: "emb-legacy",
            attributes: { kind: "embed", total_ms: 35 },
        }),
        ev(900, inf, "request.queued", {
            request_id: "emb-modern",
            model_instance_id: "nomic-embed-v1.5",
            attributes: { kind: "embed", inputs: 2, model: "nomic-embed-v1.5" },
        }),
        ev(905, inf, "request.started", {
            request_id: "emb-modern",
            attributes: { kind: "embed" },
        }),
        ev(925, inf, "request.completed", {
            request_id: "emb-modern",
            attributes: { kind: "embed", total_ms: 20 },
        }),
    ];
}

async function startMockNodeProducer(allowedOrigin: string, events: readonly ObservatoryEvent[]): Promise<MockNodeProducer> {
    const nodeDoc = {
        schema: "sonder.inference.node/1",
        node_id: "NODE1",
        instance_id: "inf-w3-e2e",
        platform: "windows",
        version: "0.4.0",
        synthetic: true,
        gpus: [
            {
                id: "gpu:0",
                name: "AMD Radeon RX 9060 XT",
                vendor: "AMD",
                vendor_id: 0x1002,
                device_id: 0x7590,
                dedicated_total_mib: 16_384,
                dedicated_free_mib: 12_288,
                shared_total_mib: 16_384,
                effective_vram_mib: 16_384,
                effective_free_vram_mib: 12_288,
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
                dedicated_free_mib: 10_240,
                shared_total_mib: 16_384,
                effective_vram_mib: 16_384,
                effective_free_vram_mib: 10_240,
                is_integrated_uma: true,
                backend_hint: "Vulkan1",
                source: "dxgi",
            },
        ],
        combined_gpu_vram_mib: 32_768,
        gpu_pool: {
            discrete_vram_mib: 16_384,
            integrated_uma_vram_mib: 16_384,
            combined_gpu_vram_mib: 32_768,
            discrete_free_vram_mib: 12_288,
            integrated_uma_free_vram_mib: 10_240,
            combined_free_gpu_vram_mib: 22_528,
            discrete_gpu_count: 1,
            integrated_uma_gpu_count: 1,
            hybrid_vulkan_pool_available: true,
            recommended_devices: ["Vulkan0", "Vulkan1"],
            llama_arg_device: "Vulkan0,Vulkan1",
        },
        backends: [{ name: "llamaserver", available: true, capabilities: ["streaming", "vulkan"] }],
        models: [
            { id: "qwen3-80b-a3b-q4_k_m", backend: "llamaserver" },
            { id: "nomic-embed-v1.5", backend: "llamaserver" },
        ],
        capabilities: {
            hybrid_gpu_spread: true,
            multi_gpu: true,
            uma_telemetry: true,
        },
    };

    const discoveryDoc = {
        schema: "sonder.telemetry.producer/1",
        producer: {
            name: "sonder-inference",
            version: "0.4.0",
            node_id: "NODE1",
            instance_id: "inf-w3-e2e",
            role: "inference",
            synthetic: true,
        },
        event_schema: "sonder.observatory.event/1",
        streams: [{ transport: "sse", url: "/events/sse" }],
        resume: {
            header: "Last-Event-ID",
            query: "last_event_id",
            retained_events: events.length,
            oldest_sequence: 0,
            next_sequence: events.length,
        },
        auth: { required: false, schemes: ["bearer"] },
        clock: { mono_ns: "host-monotonic" },
        links: {
            health: "/v1/sonder/health",
            node: "/v1/sonder/node",
        },
    };

    const sockets = new Set<import("node:net").Socket>();
    const server: Server = createServer((req, res) => {
        const origin = req.headers.origin;
        const cors: Record<string, string> =
            typeof origin === "string" && origin === allowedOrigin
                ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
                : { Vary: "Origin" };

        if (req.method === "OPTIONS") {
            res.writeHead(204, {
                ...cors,
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "Accept, Authorization, Cache-Control, Content-Type, Last-Event-ID",
            });
            res.end();
            return;
        }
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/.well-known/sonder-telemetry") {
            res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors });
            res.end(JSON.stringify(discoveryDoc));
            return;
        }
        if (url.pathname === "/v1/sonder/node") {
            res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors });
            res.end(JSON.stringify(nodeDoc));
            return;
        }
        if (url.pathname === "/v1/sonder/health") {
            res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors });
            res.end(
                JSON.stringify({
                    backends: nodeDoc.backends,
                    models: nodeDoc.models,
                    telemetry: { level: "standard" },
                    gpus: nodeDoc.gpus,
                    gpu_pool: nodeDoc.gpu_pool,
                    combined_gpu_vram_mib: nodeDoc.combined_gpu_vram_mib,
                }),
            );
            return;
        }
        if (url.pathname === "/events/sse") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-store",
                Connection: "keep-alive",
                ...cors,
            });
            res.write("retry: 2000\n\n");
            for (const e of events) {
                res.write(`id: ${e.event_id}\ndata: ${JSON.stringify(e)}\n\n`);
            }
            const timer = setInterval(() => res.write(": keepalive\n\n"), 15_000);
            timer.unref();
            req.on("close", () => clearInterval(timer));
            return;
        }
        res.writeHead(404, { "Content-Type": "text/plain", ...cors });
        res.end("not found");
    });

    server.on("connection", (s) => {
        sockets.add(s);
        s.on("close", () => sockets.delete(s));
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as { port: number };
    return {
        baseUrl: `http://127.0.0.1:${addr.port}`,
        async close() {
            for (const s of sockets) {
                s.destroy();
            }
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

function pageOrigin(testInfo: TestInfo): string {
    return new URL(String(testInfo.project.use.baseURL ?? "http://127.0.0.1:4173")).origin;
}

test.describe("live /v1/sonder/node and Wave 2 metrics panels", () => {
    let producer: MockNodeProducer;
    const events = buildWave2LiveEvents();

    // eslint-disable-next-line no-empty-pattern
    test.beforeAll(async ({}, testInfo) => {
        producer = await startMockNodeProducer(pageOrigin(testInfo), events);
    });

    test.afterAll(async () => {
        await producer?.close();
    });

    test("probes and connects a live hybrid-GPU node, renders node hardware + Wave 2 route/orchestration/embed panels without console errors", async ({
        page,
    }) => {
        const pageErrors: string[] = [];
        const consoleErrors: string[] = [];
        page.on("pageerror", (err) => pageErrors.push(err.message));
        page.on("console", (msg) => {
            if (msg.type() === "error") {
                consoleErrors.push(msg.text());
            }
        });

        // 1. Test button in Sources probes discovery + /v1/sonder/node and displays node hardware summary.
        await page.goto("./?fixture=0&view=overview");
        await page.locator("#ws-url").fill(producer.baseUrl);
        await page.locator("#probe-btn").click();
        const probeResult = page.locator("#probe-result");
        await expect(probeResult).toHaveAttribute("data-tone", "ok");
        await expect(probeResult).toContainText("2 GPUs (1 discrete, 1 UMA)");
        await expect(probeResult).toContainText("32.0 GiB combined VRAM");
        await expect(probeResult).toContainText("Hybrid Vulkan pool (Vulkan0,Vulkan1)");

        // 2. Connect producer and verify producer card + Overview live node + Wave 2 metric panels.
        await page.locator("#connect-btn").click();
        const producerCard = page.locator('[data-testid="producer-card"][data-producer="sonder-inference"]');
        await expect(producerCard).toBeVisible();
        await expect(producerCard.locator('[data-testid="producer-state"]')).toHaveText("live");
        await expect(page.locator("#cursor-label")).toContainText(`${events.length}/${events.length} events`);
        await expect(page.locator("#warnings .warning")).toHaveCount(0);

        // Inline producer card hardware block
        const hwBlock = producerCard.locator('[data-testid="producer-node-hw"]');
        await expect(hwBlock).toBeVisible();
        await expect(hwBlock.locator('[data-testid="producer-hw-topology"]')).toContainText("2 GPUs (1 discrete + 1 UMA)");
        await expect(hwBlock.locator('[data-testid="producer-hw-hybrid"]')).toBeVisible();
        await expect(hwBlock.locator('[data-testid="producer-hw-residency"]')).toContainText("2 models · 1/1 backend");

        // Overview Live Node card
        const liveNodeCard = page.locator('[data-testid="live-node-card"][data-live-node="NODE1"]');
        await expect(liveNodeCard).toBeVisible();
        await expect(liveNodeCard).toContainText("2 GPUs · Discrete + UMA");
        const poolBanner = liveNodeCard.locator('[data-testid="live-node-pool"]');
        await expect(poolBanner).toHaveAttribute("data-hybrid-vulkan", "true");
        await expect(poolBanner).toContainText("Hybrid Vulkan Pool Ready");
        await expect(poolBanner).toContainText("--device Vulkan0,Vulkan1");
        await expect(poolBanner).toContainText("32.0 GiB combined");
        await expect(liveNodeCard.locator('[data-live-gpu="gpu:0"][data-gpu-class="discrete"]')).toContainText("AMD Radeon RX 9060 XT");
        const umaRow = liveNodeCard.locator('[data-live-gpu="gpu:1"][data-gpu-class="integrated-uma"]');
        await expect(umaRow).toContainText("AMD Radeon 780M Graphics");
        await expect(umaRow).toContainText("512.0 MiB carveout + 16.0 GiB shared GTT");
        await expect(liveNodeCard.locator('[data-testid="live-node-model-count"]')).toHaveText("Models: 2");
        await expect(liveNodeCard.locator('[data-testid="live-node-backend-count"]')).toHaveText("Backends: 1/1 available");
        await expect(liveNodeCard.locator('[data-testid="live-node-residency"]')).toContainText("hybrid_gpu_spread");

        // Overview Execution routing + Wave 2 breakdown + orchestration lifecycle
        const routeCard = page.locator('[data-testid="execution-route-card"]');
        await expect(routeCard).toBeVisible();
        await expect(routeCard.locator('[data-testid="route-breakdown"]')).toBeVisible();
        await expect(routeCard.locator('[data-route-band="hard"]')).toContainText("Hard ×1");
        await expect(routeCard.locator('[data-route-band="multi_scope"]')).toContainText("Multi-Scope ×1");
        await expect(routeCard.locator('[data-route-latency="ensemble"]')).toContainText("Ensemble p50 200 ms");
        await expect(routeCard.locator('[data-route-latency="fanout"]')).toContainText("Fanout p50 350 ms");
        const orchSummary = routeCard.locator('[data-testid="orchestration-summary"]');
        await expect(orchSummary).toBeVisible();
        await expect(orchSummary.locator('[data-orch-kind="fanout"]')).toContainText("Fanout ×1 · 1 ok");
        await expect(orchSummary.locator('[data-orch-kind="ensemble"]')).toContainText("Ensemble ×1 · 1 ok");
        await expect(orchSummary.locator('[data-orch-span="fan-1"]')).toContainText("1/2 ok, 1 failed workers");
        await expect(orchSummary.locator('[data-orch-span="ens-1"]')).toContainText("2/2 ok candidates");

        // Overview Embeddings card
        const embedCard = page.locator('[data-testid="embed-metrics-card"]');
        await expect(embedCard).toBeVisible();
        await expect(embedCard).toContainText("2 embed req");
        await expect(embedCard).toContainText("nomic-embed-v1.5");
        await expect(embedCard).toContainText("queued ×1");

        // Metric strip keeps 6 cards and surfaces embed + orchestration counters
        await expect(page.locator("#metric-strip .strip-card")).toHaveCount(6);
        await expect(page.locator('#metric-strip [data-metric="latency-p50"] .strip-sub')).toContainText("2 embed");
        await expect(page.locator('#metric-strip [data-metric="agents"] .strip-sub')).toContainText("orch 2 done");

        // 3. Disconnecting removes the active live node card from Overview while keeping final producer card state.
        await producerCard.getByRole("button", { name: "Disconnect sonder-inference" }).click();
        await expect(producerCard.locator('[data-testid="producer-state"]')).toHaveText("disconnected");
        await expect(page.locator('[data-testid="live-node-card"]')).toHaveCount(0);

        expect(pageErrors, "uncaught page errors").toEqual([]);
        expect(consoleErrors, "console.error messages").toEqual([]);
    });

    for (const theme of ["dark", "light"] as const) {
        test(`a11y + responsive layout in ${theme} theme`, async ({ page }) => {
            const pageErrors: string[] = [];
            page.on("pageerror", (err) => pageErrors.push(err.message));

            await page.setViewportSize({ width: 1440, height: 960 });
            await page.goto(`./?fixture=0&theme=${theme}&view=overview&connect=${encodeURIComponent(producer.baseUrl)}`);
            await confirmQueryConnects(page);

            await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
            await expect(page.locator('[data-testid="live-node-card"][data-live-node="NODE1"]')).toBeVisible();
            await expect(page.locator('[data-testid="orchestration-summary"]')).toBeVisible();
            await expect(page.locator('[data-testid="embed-metrics-card"]')).toBeVisible();

            // WCAG 2.0/2.1/2.2 A/AA axe-core verification
            const axe = await new AxeBuilder({ page }).withTags(A11Y_TAGS).analyze();
            expect(axe.violations, `axe violations in ${theme} theme`).toEqual([]);

            // Desktop horizontal overflow check
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

            // Optional artifact screenshot capture when requested via env var
            const shotDir = process.env.NODE_PANELS_SHOT_DIR?.trim();
            if (shotDir) {
                mkdirSync(shotDir, { recursive: true });
                await page.screenshot({
                    path: path.join(shotDir, `node-panels-overview-${theme}-1440.png`),
                    fullPage: true,
                    animations: "disabled",
                });
                await page.locator('[data-testid="live-node-card"][data-live-node="NODE1"]').scrollIntoViewIfNeeded();
                await page.locator('[data-testid="live-node-card"][data-live-node="NODE1"]').screenshot({
                    path: path.join(shotDir, `node-panels-live-node-${theme}.png`),
                    animations: "disabled",
                });
            }

            // Narrow viewport responsive check (zero horizontal overflow)
            await page.setViewportSize({ width: 420, height: 900 });
            await expect(page.locator('[data-testid="live-node-card"][data-live-node="NODE1"]')).toBeVisible();
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

            expect(pageErrors, "uncaught page errors").toEqual([]);
        });
    }
});
