import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { ObservatoryEvent } from "../src/protocol/events";
import { scrubTo } from "./helpers";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const NODE1_INF = {
    name: "sonder-inference",
    version: "0.4.0",
    node_id: "NODE1",
    instance_id: "tel-e2e-node1",
    role: "inference",
    synthetic: true,
} as const;

const WORKSTATION_INF = {
    name: "sonder-inference",
    version: "0.4.0",
    node_id: "workstation",
    instance_id: "tel-e2e-ws",
    role: "inference",
    synthetic: true,
} as const;

const WORKSTATION_RT = {
    name: "sonder-runtime",
    version: "0.9.0",
    node_id: "workstation",
    instance_id: "rt-e2e-ws",
    role: "runtime",
    synthetic: true,
} as const;

function buildSyntheticSession(): ObservatoryEvent[] {
    let seqInf1 = 0;
    let seqInfWs = 0;
    let seqRt = 0;
    const baseWall = Date.parse("2026-11-25T08:00:00.000Z");

    const ev = (
        ms: number,
        producer: typeof NODE1_INF | typeof WORKSTATION_INF | typeof WORKSTATION_RT,
        event_type: string,
        extra: Partial<ObservatoryEvent> = {},
    ): ObservatoryEvent => {
        const sequence =
            producer === NODE1_INF ? seqInf1++ : producer === WORKSTATION_INF ? seqInfWs++ : seqRt++;
        return {
            schema: "sonder.observatory.event/1",
            event_id: `${producer.instance_id}-${sequence}`,
            sequence,
            event_type,
            wall_time: new Date(baseWall + ms).toISOString(),
            mono_ns: Math.round(ms * 1_000_000),
            session_id: "ses-e2e-wave2",
            run_id: "run-e2e-wave2",
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
        ev(0, WORKSTATION_RT, "session.started", {
            attributes: { text_capture: "none", role: "runtime" },
        }),
        ev(10, NODE1_INF, "session.created", {
            attributes: { model: "qwen3-80b-a3b-q4_k_m" },
        }),

        // NODE1 hybrid dual-GPU VRAM samples: discrete RX 9060 XT + integrated Radeon 780M UMA.
        ev(50, NODE1_INF, "device.memory.sample", {
            device_id: "gpu:0",
            attributes: {
                kind: "gpu",
                name: "AMD Radeon RX 9060 XT",
                vendor: "AMD",
                is_integrated_uma: false,
                backend_hint: "Vulkan0",
                dedicated_total_bytes: 16 * GIB,
                dedicated_free_bytes: 2 * GIB,
                model_weights_bytes: 13 * GIB,
                carrying_model_weights: true,
                active_devices: ["Vulkan0", "Vulkan1"],
                combined_gpu_vram_mib: 48640,
            },
        }),
        ev(55, NODE1_INF, "device.memory.sample", {
            device_id: "gpu:1",
            attributes: {
                kind: "gpu",
                name: "AMD Radeon 780M",
                vendor: "AMD",
                is_integrated_uma: true,
                backend_hint: "Vulkan1",
                dedicated_total_bytes: 512 * MIB,
                shared_total_bytes: 31744 * MIB,
                effective_vram_mib: 32256,
                effective_free_vram_mib: 12256,
                model_weights_bytes: 18 * GIB,
                carrying_model_weights: true,
                active_devices: ["Vulkan0", "Vulkan1"],
                combined_gpu_vram_mib: 48640,
            },
        }),

        // Workstation single discrete GPU (verifies per-node isolation).
        ev(60, WORKSTATION_INF, "device.memory.sample", {
            device_id: "gpu:0",
            attributes: {
                kind: "gpu",
                name: "NVIDIA GeForce RTX 5070 Ti",
                vendor: "NVIDIA",
                is_integrated_uma: false,
                backend_hint: "CUDA0",
                dedicated_total_bytes: 16 * GIB,
                dedicated_free_bytes: 6 * GIB,
                carrying_model_weights: true,
            },
        }),

        // Turn 1: Hard Ensemble route + cold model reload request (500 tok/s prefill, 50 tok/s decode).
        ev(100, WORKSTATION_RT, "route.selected", {
            request_id: "turn-1",
            attributes: {
                provider: "sonder_inference",
                operation: "chat",
                execution_route: {
                    mode: "ensemble",
                    band: "hard",
                    difficulty_score: 0.78,
                    recommended_tiers: ["code", "reasoning"],
                    ensemble_mode: "code",
                    auto_selected: true,
                    reason: "hard architecture prompt auto-routed to parallel ensemble",
                },
            },
        }),
        ev(110, NODE1_INF, "request.started", {
            request_id: "req-reload",
            model_instance_id: "qwen3-80b-a3b-q4_k_m",
            attributes: { kind: "chat" },
        }),
        ev(3310, NODE1_INF, "backend.model.load.reported", {
            request_id: "req-reload",
            attributes: { load_duration_ns: 3_200_000_000 },
        }),
        ev(5310, NODE1_INF, "inference.prefill.completed", {
            request_id: "req-reload",
            attributes: {
                prompt_tokens: 1000,
                backend_cached_tokens: 0,
                backend_prompt_eval_ms: 2000,
                ttft_ms: 5200,
            },
        }),
        ev(5310, NODE1_INF, "inference.token.generated", {
            request_id: "req-reload",
            attributes: { unit: "chunk" },
        }),
        ev(7310, NODE1_INF, "inference.decode.completed", {
            request_id: "req-reload",
            attributes: { completion_tokens: 100, backend_eval_ms: 2000 },
        }),
        ev(7310, NODE1_INF, "request.completed", {
            request_id: "req-reload",
            attributes: {
                completion_tokens: 100,
                token_counts_from_backend: true,
                ttft_ms: 5200,
                total_ms: 7200,
            },
        }),

        // Turn 2: Multi-scope Fanout route + warm steady-prefill request (50% prefix cache hit -> 1000 tok/s prefill, 80 tok/s decode).
        ev(8000, WORKSTATION_RT, "route.selected", {
            request_id: "turn-2",
            attributes: {
                execution_mode: "fanout",
                difficulty_band: "multi_scope",
                difficulty_score: 0.92,
                fanout_scope: "local",
                worker_count: 3,
                auto_selected: true,
                route_reason: "multi-scope audit routed to bounded local fanout",
            },
        }),
        ev(8010, WORKSTATION_RT, "fanout.started", {
            request_id: "turn-2",
            attributes: { fanout_run_id: "fan-e2e-1", fanout_scope: "local", worker_count: 3 },
        }),
        ev(8020, NODE1_INF, "request.started", {
            request_id: "req-steady",
            model_instance_id: "qwen3-80b-a3b-q4_k_m",
            attributes: { kind: "chat" },
        }),
        ev(8540, NODE1_INF, "inference.prefill.completed", {
            request_id: "req-steady",
            attributes: {
                prompt_tokens: 1000,
                backend_cached_tokens: 500,
                backend_prompt_eval_ms: 500,
                ttft_ms: 520,
            },
        }),
        ev(8540, NODE1_INF, "inference.token.generated", {
            request_id: "req-steady",
            attributes: { unit: "chunk" },
        }),
        ev(9540, NODE1_INF, "inference.decode.completed", {
            request_id: "req-steady",
            attributes: { completion_tokens: 80, backend_eval_ms: 1000 },
        }),
        ev(9540, NODE1_INF, "request.completed", {
            request_id: "req-steady",
            attributes: {
                completion_tokens: 80,
                token_counts_from_backend: true,
                ttft_ms: 520,
                total_ms: 1520,
            },
        }),
        ev(9550, WORKSTATION_RT, "fanout.completed", {
            request_id: "turn-2",
            attributes: { fanout_run_id: "fan-e2e-1" },
        }),

        // Turn 3: Quick single-tier route.
        ev(9600, WORKSTATION_RT, "route.selected", {
            request_id: "turn-3",
            attributes: {
                execution_route: {
                    mode: "single",
                    band: "quick",
                    difficulty_score: 0.14,
                    recommended_tiers: ["fast"],
                    auto_selected: true,
                },
            },
        }),
    ];
}

test("renders dual-GPU VRAM breakdown, Prefill/Decode + TTFT reload split, and execution_route badges with zero errors", async ({
    page,
}, testInfo) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("console", (msg) => {
        if (msg.type() === "error") {
            consoleErrors.push(msg.text());
        }
    });

    const events = buildSyntheticSession();
    const recordingPath = testInfo.outputPath("dual-gpu-prefill-routes.ndjson");
    writeFileSync(recordingPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    await page.goto("./?fixture=0&view=overview");
    await page.locator("#file-input").setInputFiles(recordingPath);

    await expect(page.locator("#source-badge")).toContainText("dual-gpu-prefill-routes.ndjson");
    await expect(page.locator("#cursor-label")).toContainText(`${events.length}/${events.length} events`);
    await expect(page.locator("#warnings .warning")).toHaveCount(0);

    // 1. Dual-GPU VRAM breakdown (per-node cards + hybrid discrete/UMA combined pool).
    const node1Card = page.locator('[data-testid="gpu-node-card"][data-gpu-node="NODE1"]');
    await expect(node1Card).toBeVisible();
    await expect(node1Card).toContainText("2 GPUs · Discrete + UMA");

    const combinedPool = node1Card.locator('[data-testid="combined-vram-pool"]');
    await expect(combinedPool).toBeVisible();
    await expect(combinedPool).toHaveAttribute("data-both-carrying", "true");
    await expect(combinedPool).toContainText("Combined VRAM Pool Active");
    await expect(combinedPool).toContainText("Discrete");
    await expect(combinedPool).toContainText("UMA");
    await expect(combinedPool).toContainText("both GPUs carrying weights (reported)");

    const discreteRow = node1Card.locator('[data-gpu-device="gpu:0"][data-gpu-class="discrete"]');
    await expect(discreteRow).toBeVisible();
    await expect(discreteRow).toContainText("AMD Radeon RX 9060 XT");
    await expect(discreteRow).toContainText("Discrete");
    await expect(discreteRow).toContainText("Model weights");
    await expect(discreteRow.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "88");

    const umaRow = node1Card.locator('[data-gpu-device="gpu:1"][data-gpu-class="integrated-uma"]');
    await expect(umaRow).toBeVisible();
    await expect(umaRow).toContainText("AMD Radeon 780M");
    await expect(umaRow).toContainText("Integrated UMA");
    await expect(umaRow).toContainText("UMA pool");
    await expect(umaRow).toContainText("shared GTT");
    await expect(umaRow).toContainText("Model weights");
    await expect(umaRow.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "62");

    // Workstation single GPU stays isolated on its own node card with no combined-pool banner.
    const wsCard = page.locator('[data-testid="gpu-node-card"][data-gpu-node="workstation"]');
    await expect(wsCard).toBeVisible();
    await expect(wsCard).toContainText("1 GPU · Discrete");
    await expect(wsCard).toContainText("NVIDIA GeForce RTX 5070 Ti");
    await expect(wsCard.locator('[data-testid="combined-vram-pool"]')).toHaveCount(0);

    // 2. Prefill vs Decode throughput split + TTFT steady-prefill vs model-reload breakdown.
    const pdSplit = page.locator('[data-testid="prefill-decode-split"]');
    await expect(pdSplit).toBeVisible();
    await expect(pdSplit.locator('[data-phase="prefill"]')).toContainText("600.0 tok/s");
    await expect(pdSplit.locator('[data-phase="prefill"]')).toContainText("1500 eval tok");
    await expect(pdSplit.locator('[data-phase="decode"]')).toContainText("60.0 tok/s");
    await expect(pdSplit.locator('[data-phase="decode"]')).toContainText("180 toks");
    await expect(pdSplit.locator('[data-ttft-class="reload"]')).toBeVisible();
    await expect(pdSplit.locator('[data-ttft-class="steady-prefill"]')).toBeVisible();

    const ttftBreakdown = page.locator('[data-testid="ttft-breakdown"]');
    await expect(ttftBreakdown).toBeVisible();
    await expect(ttftBreakdown).toContainText("Latest: Steady prefill");
    await expect(ttftBreakdown.locator('[data-ttft-kind="steady-prefill"]')).toContainText("1 req");
    await expect(ttftBreakdown.locator('[data-ttft-kind="reload"]')).toContainText("1 req");

    // Metric strip summarizes prefill rate and reload count.
    await expect(page.locator('#metric-strip [data-metric="tokens"] .strip-sub')).toContainText("prefill 600.0 tok/s");
    await expect(page.locator('#metric-strip [data-metric="tokens"] .strip-sub')).toContainText("1 reload");

    // 3. Execution-route card + mode badges + metric strip summary.
    const routeCard = page.locator('[data-testid="execution-route-card"]');
    await expect(routeCard).toBeVisible();
    await expect(routeCard).toContainText("Execution routing");
    await expect(routeCard.locator('[data-route-count="ensemble"]')).toHaveText("Ensemble ×1");
    await expect(routeCard.locator('[data-route-count="fanout"]')).toHaveText("Fanout ×1");
    await expect(routeCard.locator('[data-route-count="single"]')).toHaveText("Single ×1");

    await expect(routeCard.locator('[data-route-mode="ensemble"]').first()).toContainText(
        "Auto · Hard · Ensemble (code+reasoning)",
    );
    await expect(routeCard.locator('[data-route-mode="ensemble"]').first()).toContainText("score 0.78");
    await expect(routeCard.locator('[data-route-mode="fanout"]').first()).toContainText("Auto · Multi-Scope · Fanout (local)");
    await expect(routeCard.locator('[data-route-mode="fanout"]').first()).toContainText("score 0.92");
    await expect(routeCard.locator('[data-route-mode="single"]').first()).toContainText("Auto · Quick · Single (fast)");
    await expect(routeCard.locator('[data-route-mode="single"]').first()).toContainText("score 0.14");

    await expect(page.locator('#metric-strip [data-metric="agents"] .strip-sub')).toContainText(
        "Auto · Quick · Single (fast)",
    );
    await expect(page.locator('#metric-strip [data-metric="agents"] .strip-sub')).toContainText("1 ensemble");
    await expect(page.locator('#metric-strip [data-metric="agents"] .strip-sub')).toContainText("1 fanout");

    // 4. Scrub backward into the reload-only prefix and return to end cleanly.
    await scrubTo(page, 600);
    await expect(ttftBreakdown.locator('[data-ttft-kind="reload"]')).toBeVisible();
    await scrubTo(page, 1000);
    await expect(routeCard.locator('[data-route-count="single"]')).toHaveText("Single ×1");

    expect(pageErrors, "uncaught page errors").toEqual([]);
    expect(consoleErrors, "console.error messages").toEqual([]);
});
