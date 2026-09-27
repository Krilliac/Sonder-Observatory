/**
 * Hand-built event sequences for the 3D Inference view (tests and e2e).
 *
 * - `ollamaPoolFixture()` mirrors what a live Sonder Runtime plus two
 *   Sonder-Inference `serve` instances over Ollama emit (a workstation
 *   serving qwen3:14b and deepseek-r1:14b, and a second node `node1` serving
 *   qwen3:14b): chunk output, backend token counts, scheduler and logical KV
 *   events. Shapes follow Sonder-Inference docs/TELEMETRY.md; it is not a
 *   recording and its numbers are made up. Unit tests use it unmarked to
 *   exercise the real-producer paths; anything that displays it (e2e) must
 *   pass `{ synthetic: true }` so the synthetic badge and banner show.
 * - `deepSyntheticFixture()` is a synthetic producer (`producer.synthetic:
 *   true`) that emits the reserved `backend.layer.*` / `backend.operator.*`
 *   events and `inference.sampling.candidates` in the *proposed* shapes of
 *   docs/TELEMETRY_PROTOCOL.md ("3D Inference: reserved and proposed
 *   events"). No Sonder Inference backend emits these yet.
 *
 * Deterministic: no randomness, fixed clocks.
 */
import { SCHEMA_ID, type ObservatoryEvent, type Producer, type SamplingLevel } from "../protocol/events";

interface Stream {
    producer: Producer;
    seq: number;
}

function stream(producer: Producer): Stream {
    return { producer, seq: 0 };
}

interface EventInit {
    type: string;
    ns: number;
    session: string;
    run?: string | null;
    request?: string | null;
    model?: string | null;
    device?: string | null;
    level?: SamplingLevel;
    attributes?: Record<string, unknown>;
}

const T0 = Date.UTC(2026, 8, 27, 9, 0, 0);
const BASE_NS = 7_000_000_000_000;

function make(s: Stream, init: EventInit): ObservatoryEvent {
    const seq = s.seq++;
    const instance = s.producer.instance_id ?? s.producer.name;
    return {
        schema: SCHEMA_ID,
        event_id: `${instance}-${seq}`,
        sequence: seq,
        event_type: init.type,
        wall_time: new Date(T0 + (init.ns - BASE_NS) / 1e6).toISOString(),
        mono_ns: init.ns,
        session_id: init.session,
        run_id: init.run ?? null,
        request_id: init.request ?? null,
        agent_id: null,
        task_id: null,
        model_instance_id: init.model ?? null,
        device_id: init.device ?? null,
        producer: { ...s.producer },
        sampling: { level: init.level ?? "metrics", sampled: true },
        attributes: init.attributes ?? {},
    };
}

const ms = (n: number) => BASE_NS + Math.round(n * 1e6);

interface InferenceRequestPlan {
    s: Stream;
    session: string;
    model: string;
    request: string;
    parent: string | null;
    startMs: number;
    chunks: number;
    promptTokens: number;
    completionTokens: number;
    /** Stop after this phase (to leave the request open at the end of the fixture). */
    until?: "queued" | "decoding" | "failed" | "done";
}

function inferenceRequest(p: InferenceRequestPlan): ObservatoryEvent[] {
    const out: ObservatoryEvent[] = [];
    const base = { session: p.session, run: p.parent ?? p.session, request: p.request, model: p.model, device: "cpu:0" };
    const parent = p.parent ? { parent_request_id: p.parent } : {};
    let t = p.startMs;
    out.push(
        make(p.s, {
            ...base,
            type: "request.queued",
            ns: ms(t),
            attributes: { kind: "chat", priority: 0, workload: "interactive_user", prompt_bytes: p.promptTokens * 4, messages: 2, ...parent },
        }),
    );
    out.push(
        make(p.s, {
            ...base,
            type: "scheduler.enqueued",
            ns: ms((t += 1)),
            attributes: {
                scheduler_request_id: out.length,
                workload: "interactive_user",
                priority_rank: 0,
                prompt_tokens: p.promptTokens,
                exact_prompt_tokens: false,
                max_new_tokens: 2048,
                context_limit: 8192,
            },
        }),
    );
    out.push(
        make(p.s, {
            ...base,
            type: "request.started",
            ns: ms((t += 1)),
            attributes: { kind: "chat", scheduled: true, sampler: "backend", chat_template: "native", ...parent },
        }),
    );
    if (p.until === "queued") {
        return out;
    }
    out.push(
        make(p.s, {
            ...base,
            type: "scheduler.admitted",
            ns: ms((t += 40)),
            attributes: { scheduler_request_id: 1, step: 1, queue_ms: 40, resumed: false, reserved_blocks: 8 },
        }),
    );
    out.push(
        make(p.s, {
            ...base,
            type: "kv.allocated",
            ns: ms((t += 1)),
            level: "standard",
            attributes: { scheduler_request_id: 1, blocks: Math.ceil(p.promptTokens / 16), tokens: p.promptTokens },
        }),
    );
    out.push(
        make(p.s, {
            ...base,
            type: "scheduler.prefill.completed",
            ns: ms((t += 2)),
            attributes: { scheduler_request_id: 1, context_tokens: p.promptTokens, prompt_tokens: p.promptTokens, reused_tokens: 0, recompute: false },
        }),
    );
    if (p.until === "failed") {
        out.push(
            make(p.s, {
                ...base,
                type: "request.failed",
                ns: ms((t += 900)),
                attributes: {
                    outcome: "failed",
                    stop_reason: "error",
                    error_code: "backend_unavailable",
                    error: "backend stopped responding",
                    prompt_tokens: p.promptTokens,
                    completion_tokens: 0,
                    chunks: 0,
                    token_counts_from_backend: false,
                    total_ms: t - p.startMs,
                    ...parent,
                },
            }),
        );
        out.push(
            make(p.s, {
                ...base,
                type: "kv.freed",
                ns: ms(t + 1),
                attributes: { scheduler_request_id: 1, blocks: Math.ceil(p.promptTokens / 16), reason: "failed" },
            }),
        );
        return out;
    }
    const ttft = t + 380 - p.startMs;
    out.push(make(p.s, { ...base, type: "inference.decode.started", ns: ms((t += 380)), attributes: { ttft_ms: ttft } }));
    for (let i = 0; i < p.chunks; i++) {
        out.push(
            make(p.s, {
                ...base,
                type: "inference.token.generated",
                ns: ms((t += 90 + (i % 3) * 25)),
                level: "standard",
                attributes: { index: i, bytes: 18 + ((i * 7) % 40), elapsed_ms: t - p.startMs, unit: "chunk" },
            }),
        );
    }
    if (p.until === "decoding") {
        return out;
    }
    const total = t + 20 - p.startMs;
    const evalMs = t - (p.startMs + ttft) + 200;
    out.push(
        make(p.s, {
            ...base,
            type: "inference.prefill.completed",
            ns: ms((t += 10)),
            attributes: { prompt_tokens: p.promptTokens, token_counts_from_backend: true, ttft_ms: ttft, backend_prompt_eval_ms: 210, reused_prompt_tokens: 0 },
        }),
    );
    out.push(
        make(p.s, {
            ...base,
            type: "inference.decode.completed",
            ns: ms((t += 1)),
            attributes: {
                completion_tokens: p.completionTokens,
                chunks: p.chunks,
                decode_wall_ms: evalMs,
                backend_eval_ms: evalMs,
                backend_tokens_per_sec: (p.completionTokens / evalMs) * 1000,
            },
        }),
    );
    out.push(
        make(p.s, {
            ...base,
            type: "request.completed",
            ns: ms((t += 9)),
            attributes: {
                outcome: "completed",
                stop_reason: "stop",
                prompt_tokens: p.promptTokens,
                completion_tokens: p.completionTokens,
                chunks: p.chunks,
                token_counts_from_backend: true,
                ttft_ms: ttft,
                total_ms: total,
                scheduled: true,
                sampler: "backend",
                ...parent,
            },
        }),
    );
    out.push(
        make(p.s, {
            ...base,
            type: "kv.freed",
            ns: ms(t + 1),
            attributes: { scheduler_request_id: 1, blocks: Math.ceil(p.promptTokens / 16), reason: "completed" },
        }),
    );
    return out;
}

function engineStart(s: Stream, atMs: number, engine: string, sessions: readonly { id: string; model: string }[]): ObservatoryEvent[] {
    return [
        make(s, {
            type: "engine.started",
            ns: ms(atMs),
            session: engine,
            run: engine,
            attributes: {
                version: "0.1.0",
                commit: "fixture",
                platform: "windows-x86_64",
                device_count: 1,
                text_capture: "off",
                server: { host: "127.0.0.1", port: 11437, api_version: 1 },
            },
        }),
        make(s, {
            type: "backend.registered",
            ns: ms(atMs + 1),
            session: engine,
            run: engine,
            attributes: { backend: "ollama", description: "Ollama over loopback HTTP", capabilities: ["streaming", "remote_process"] },
        }),
        make(s, {
            type: "scheduler.configured",
            ns: ms(atMs + 2),
            session: engine,
            run: engine,
            attributes: {
                kv_block_size_tokens: 16,
                kv_num_blocks: 4096,
                prefix_caching: true,
                max_running_sequences: 64,
                max_step_sequences: 64,
                max_step_tokens: 2048,
                prefill_chunk_tokens: 512,
                admission_watermark_blocks: 4,
                max_requeue_count: 8,
            },
        }),
        make(s, {
            type: "device.memory.sample",
            ns: ms(atMs + 3),
            session: engine,
            run: engine,
            device: "cpu:0",
            attributes: { kind: "cpu", name: "host", logical_cores: 24, total_bytes: 33_285_996_544, available_bytes: 14_000_000_000 },
        }),
        ...sessions.map((x, i) =>
            make(s, {
                type: "session.created",
                ns: ms(atMs + 5 + i),
                session: x.id,
                run: engine,
                attributes: {
                    model: x.model,
                    backend: "ollama",
                    priority: 0,
                    workload: "interactive_user",
                    text_capture: "off",
                    sampling: { temperature: 0.8, top_k: 40, top_p: 0.95 },
                },
            }),
        ),
    ];
}

function byTime(events: ObservatoryEvent[]): ObservatoryEvent[] {
    return events.sort((a, b) => a.mono_ns - b.mono_ns || a.sequence - b.sequence);
}

/** Live-like pool: Runtime + Inference on `workstation` (qwen3:14b, deepseek-r1:14b) and Inference on `node1` (qwen3:14b). */
export function ollamaPoolFixture(options: { synthetic?: boolean } = {}): ObservatoryEvent[] {
    const synthetic = options.synthetic === true;
    const runtime = stream({ name: "sonder-runtime", version: "0.1.0", node_id: "workstation", instance_id: "rt-0a1b2c3d4e5f", role: "runtime", synthetic });
    const ws = stream({ name: "sonder-inference", version: "0.1.0", node_id: "workstation", instance_id: "tel-ws0000000001", role: "inference", synthetic });
    const n1 = stream({ name: "sonder-inference", version: "0.1.0", node_id: "node1", instance_id: "tel-n10000000001", role: "inference", synthetic });
    const rts = "rts-0a1b2c3d4e5f";
    const events: ObservatoryEvent[] = [
        make(runtime, { type: "session.started", ns: ms(0), session: rts, attributes: { role: "runtime", version: "0.1.0", text_capture: "none" } }),
        ...engineStart(ws, 1, "engine-ws", [
            { id: "sess-ws-qwen", model: "qwen3:14b" },
            { id: "sess-ws-deepseek", model: "deepseek-r1:14b" },
        ]),
        ...engineStart(n1, 2, "engine-n1", [{ id: "sess-n1-qwen", model: "qwen3:14b" }]),
    ];
    const turn = (id: string, atMs: number, model: string, endMs: number | null, outcome: "completed" | "failed" = "completed") => {
        events.push(
            make(runtime, {
                type: "request.started",
                ns: ms(atMs),
                session: rts,
                run: id,
                request: id,
                attributes: { surface: "http.chat_completions", kind: "chat", stream: true, requested_model: model, workload: "interactive_user" },
            }),
        );
        events.push(
            make(runtime, {
                type: "route.selected",
                ns: ms(atMs + 2),
                session: rts,
                run: id,
                request: id,
                attributes: { provider: "sonder_inference", operation: "chat", model, attempt: 1 },
            }),
        );
        if (endMs !== null) {
            events.push(
                make(runtime, {
                    type: outcome === "completed" ? "request.completed" : "request.failed",
                    ns: ms(endMs),
                    session: rts,
                    run: id,
                    request: id,
                    attributes: {
                        outcome,
                        total_ms: endMs - atMs,
                        http_status: outcome === "completed" ? 200 : 503,
                        provider: "sonder_inference",
                        model,
                        attempts: 1,
                    },
                }),
            );
        }
    };
    turn("turn-1", 100, "qwen3:14b", 2200);
    events.push(
        ...inferenceRequest({
            s: ws,
            session: "sess-ws-qwen",
            model: "model-qwen3-14b",
            request: "req-ws-1",
            parent: "turn-1",
            startMs: 104,
            chunks: 15,
            promptTokens: 212,
            completionTokens: 463,
        }),
    );
    turn("turn-2", 600, "deepseek-r1:14b", null);
    events.push(
        ...inferenceRequest({
            s: ws,
            session: "sess-ws-deepseek",
            model: "model-deepseek-r1-14b",
            request: "req-ws-2",
            parent: "turn-2",
            startMs: 604,
            chunks: 12,
            promptTokens: 380,
            completionTokens: 0,
            until: "decoding",
        }),
    );
    events.push(
        ...inferenceRequest({
            s: n1,
            session: "sess-n1-qwen",
            model: "model-qwen3-14b-n1",
            request: "req-n1-1",
            parent: null,
            startMs: 300,
            chunks: 9,
            promptTokens: 150,
            completionTokens: 201,
        }),
    );
    events.push(
        ...inferenceRequest({
            s: n1,
            session: "sess-n1-qwen",
            model: "model-qwen3-14b-n1",
            request: "req-n1-2",
            parent: null,
            startMs: 1400,
            chunks: 0,
            promptTokens: 90,
            completionTokens: 0,
            until: "failed",
        }),
    );
    turn("turn-3", 2500, "qwen3:14b", null);
    events.push(
        ...inferenceRequest({
            s: ws,
            session: "sess-ws-qwen",
            model: "model-qwen3-14b",
            request: "req-ws-3",
            parent: "turn-3",
            startMs: 2504,
            chunks: 0,
            promptTokens: 64,
            completionTokens: 0,
            until: "queued",
        }),
    );
    return byTime(events);
}

const WORDS = ["the", "pipeline", "stage", "shows", "each", "request", "as", "it", "moves", "through", "queue", "and", "decode"];

/**
 * SYNTHETIC deep-telemetry producer: layer/operator events and token
 * candidates in the proposed shapes. Text capture is on and the text is
 * synthetic filler.
 */
export function deepSyntheticFixture(layerCount = 8, stepsPerRequest = 6): ObservatoryEvent[] {
    const s = stream({
        name: "sonder-observatory-deep-fixture",
        version: "0.1.0",
        node_id: "fixture",
        instance_id: "syn-deep",
        role: "inference",
        synthetic: true,
    });
    const engine = "engine-syn-deep";
    const session = "sess-syn-deep";
    const model = "model-synthetic-8l";
    const events: ObservatoryEvent[] = [
        make(s, {
            type: "engine.started",
            ns: ms(0),
            session: engine,
            run: engine,
            attributes: { version: "0.1.0", commit: "synthetic", platform: "fixture", device_count: 1, text_capture: "on", synthetic: true },
        }),
        make(s, {
            type: "backend.registered",
            ns: ms(1),
            session: engine,
            run: engine,
            attributes: {
                backend: "synthetic-deep",
                description: "SYNTHETIC backend for the 3D view; performs no inference",
                capabilities: ["tokenization", "streaming", "token_logits", "layer_telemetry"],
            },
        }),
        make(s, { type: "scheduler.configured", ns: ms(2), session: engine, run: engine, attributes: { kv_block_size_tokens: 16, kv_num_blocks: 256 } }),
        make(s, {
            type: "session.created",
            ns: ms(3),
            session,
            run: engine,
            attributes: { model: "synthetic-tiny-8l", backend: "synthetic-deep", text_capture: "on", synthetic: true },
        }),
        make(s, {
            type: "model.load.completed",
            ns: ms(4),
            session,
            run: engine,
            model,
            attributes: { backend: "synthetic-deep", model: "synthetic-tiny-8l", resident: true },
        }),
    ];
    for (let r = 0; r < 2; r++) {
        const request = `req-syn-${r + 1}`;
        const base = { session, run: engine, request, model, device: "gpu:0" };
        let t = 20 + r * 400;
        events.push(
            make(s, {
                ...base,
                type: "request.queued",
                ns: ms(t),
                attributes: { kind: "generate", priority: 0, workload: "interactive_user", prompt_bytes: 64 },
            }),
        );
        events.push(make(s, { ...base, type: "request.started", ns: ms((t += 1)), attributes: { kind: "generate", scheduled: false, sampler: "sonder" } }));
        events.push(
            make(s, {
                ...base,
                type: "sampling.configured",
                ns: ms((t += 1)),
                attributes: { sampler: "sonder", selector: "distribution", stages: ["top_k", "top_p", "temperature", "dist"], seed: 7, vocab_size: 32000 },
            }),
        );
        events.push(
            make(s, { ...base, type: "kv.allocated", ns: ms((t += 1)), level: "standard", attributes: { scheduler_request_id: r + 1, blocks: 2, tokens: 24 } }),
        );
        for (let layer = 0; layer < layerCount; layer++) {
            events.push(
                make(s, {
                    ...base,
                    type: "backend.layer.exited",
                    ns: ms((t += 2)),
                    level: "deep",
                    attributes: { layer, layer_count: layerCount, phase: "prefill", step: 0, tokens: 24, duration_ms: 1.5 + layer * 0.1 },
                }),
            );
        }
        events.push(make(s, { ...base, type: "inference.decode.started", ns: ms((t += 3)), attributes: { ttft_ms: t - 20 - r * 400 } }));
        for (let step = 0; step < stepsPerRequest; step++) {
            for (let layer = 0; layer < layerCount; layer++) {
                events.push(
                    make(s, {
                        ...base,
                        type: "backend.layer.exited",
                        ns: ms((t += 1)),
                        level: "deep",
                        attributes: {
                            layer,
                            layer_count: layerCount,
                            phase: "decode",
                            step,
                            tokens: 1,
                            duration_ms: 0.4 + ((layer * 3 + step) % 5) * 0.05,
                            activation_rms: 1 + ((layer * 7 + step * 3) % 11) / 10,
                            attention_entropy: 0.5 + ((layer + step) % 6) / 5,
                        },
                    }),
                );
                if (layer % 4 === 0) {
                    for (const operator of ["attention", "mlp"]) {
                        events.push(
                            make(s, {
                                ...base,
                                type: "backend.operator.completed",
                                ns: ms(t + 0.2),
                                level: "deep",
                                attributes: { operator, layer, phase: "decode", step, duration_ms: operator === "attention" ? 0.2 : 0.15 },
                            }),
                        );
                    }
                }
            }
            const word = WORDS[(r * stepsPerRequest + step) % WORDS.length]!;
            const p = 0.55 + ((step * 13 + r * 5) % 40) / 100;
            const alts = [word, ...WORDS.filter((w) => w !== word).slice(step % 5, (step % 5) + 4)].map((w, i) => ({
                token_id: 100 + WORDS.indexOf(w),
                probability: i === 0 ? p : Number(((1 - p) / (i + 1.5)).toFixed(4)),
                text: w,
            }));
            events.push(
                make(s, {
                    ...base,
                    type: "inference.sampling.candidates",
                    ns: ms((t += 1)),
                    level: "deep",
                    attributes: { index: step, sampled_token_id: 100 + WORDS.indexOf(word), candidates: alts },
                }),
            );
            events.push(
                make(s, {
                    ...base,
                    type: "inference.token.generated",
                    ns: ms((t += 1)),
                    level: "standard",
                    attributes: {
                        index: step,
                        bytes: word.length + 1,
                        elapsed_ms: t - 20 - r * 400,
                        unit: "token",
                        count: 1,
                        token_id: 100 + WORDS.indexOf(word),
                        probability: p,
                        text: ` ${word}`,
                    },
                }),
            );
        }
        if (r === 0) {
            events.push(
                make(s, {
                    ...base,
                    type: "inference.decode.completed",
                    ns: ms((t += 1)),
                    attributes: { completion_tokens: stepsPerRequest, chunks: stepsPerRequest, decode_wall_ms: 60, backend_eval_ms: 55 },
                }),
            );
            events.push(
                make(s, {
                    ...base,
                    type: "request.completed",
                    ns: ms((t += 1)),
                    attributes: {
                        outcome: "completed",
                        stop_reason: "length",
                        prompt_tokens: 24,
                        completion_tokens: stepsPerRequest,
                        chunks: stepsPerRequest,
                        token_counts_from_backend: true,
                        ttft_ms: 30,
                        total_ms: t - 20,
                    },
                }),
            );
            events.push(make(s, { ...base, type: "kv.freed", ns: ms(t + 1), attributes: { scheduler_request_id: 1, blocks: 2, reason: "completed" } }));
        }
    }
    return byTime(events);
}

/** NDJSON text of a fixture (e2e uploads it as a recording). */
export function toNdjson(events: readonly ObservatoryEvent[]): string {
    return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}
