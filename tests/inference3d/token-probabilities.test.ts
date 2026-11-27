/**
 * Backend-sampled token probabilities and top alternatives emitted by
 * Sonder-Inference (PR #131, `llamaserver` backend):
 * - capability detection for `logprobs` without `token_logits`
 * - `inference.sampling.candidates` at `standard` level or above
 * - `probability_basis` (`"post_sampling"` / `"pre_sampling"`) parsing & UI rendering
 * - backwards compatibility for older producers without `probability_basis`
 *
 * Event shapes mirror Sonder-Inference's
 * `src/backends/llamaserver/tests/test_token_probabilities.cpp`.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { derivePipeline } from "../../src/inference3d/derive";
import { deepSyntheticFixture } from "../../src/inference3d/fixtures";
import type { PanelId, PipelineModel } from "../../src/inference3d/model";
import { buildEntityRows } from "../../src/inference3d/panelEntities";
import { renderProbabilities } from "../../src/inference3d/panelViews";
import { SCHEMA_ID, type ObservatoryEvent } from "../../src/protocol/events";
import { parseNdjson } from "../../src/recording/ndjson";
import { orderEvents } from "../../src/replay/order";

const INSTANCE = "tel-llamaserver-1";
const LLAMASERVER_CAPS = [
    "streaming",
    "remote_process",
    "embeddings",
    "tool_calling",
    "multimodal",
    "logprobs",
    "speculative_decode",
    "prefix_reuse",
    "reranking",
];

function ev(
    seq: number,
    type: string,
    attributes: Record<string, unknown> = {},
    opts: { requestId?: string | null; level?: "off" | "metrics" | "standard" | "deep"; sessionId?: string } = {},
): ObservatoryEvent {
    return {
        schema: SCHEMA_ID,
        event_id: `${INSTANCE}-${seq}`,
        sequence: seq,
        event_type: type,
        wall_time: new Date(Date.UTC(2026, 10, 26, 20, 0, 0) + seq * 10).toISOString(),
        mono_ns: 9_000_000_000_000 + seq * 1_000_000,
        session_id: opts.sessionId ?? "sess-1",
        run_id: null,
        request_id: opts.requestId ?? null,
        agent_id: null,
        task_id: null,
        model_instance_id: "model-1",
        device_id: "cpu:0",
        producer: { name: "sonder-inference", version: "0.1.0", node_id: "devbox", instance_id: INSTANCE, role: "inference", synthetic: true },
        sampling: { level: opts.level ?? "metrics", sampled: true },
        attributes,
    };
}

const caps = (m: PipelineModel) => m.capabilities.find((c) => c.producer === "sonder-inference")!;
const panel = (m: PipelineModel, id: PanelId) => caps(m).panels.find((p) => p.panel === id)!;

// Minimal DOM harness matching tests/renderer/producersPanel.test.ts for Node Vitest runs.
class FakeNode {
    parentNode: FakeElement | null = null;
    private text = "";

    get textContent(): string {
        return this.text;
    }

    set textContent(value: string) {
        this.text = value;
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
    readonly listeners = new Map<string, (() => void)[]>();

    constructor(tagName: string) {
        super();
        this.tagName = tagName.toUpperCase();
    }

    override get textContent(): string {
        if (this.childNodes.length === 0) {
            return super.textContent;
        }
        return this.childNodes.map((c) => c.textContent).join("");
    }

    override set textContent(value: string) {
        this.childNodes.length = 0;
        super.textContent = value;
    }

    setAttribute(name: string, value: string): void {
        this.attrs.set(name, String(value));
    }

    getAttribute(name: string): string | null {
        return this.attrs.get(name) ?? null;
    }

    addEventListener(type: string, fn: () => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(fn);
        this.listeners.set(type, list);
    }

    append(...items: (FakeNode | string)[]): void {
        for (const item of items) {
            const node = typeof item === "string" ? new FakeText(item) : item;
            node.parentNode = this;
            this.childNodes.push(node);
        }
    }

    replaceChildren(...items: (FakeNode | string)[]): void {
        this.childNodes.length = 0;
        this.append(...items);
    }

    findAll(pred: (el: FakeElement) => boolean): FakeElement[] {
        const out: FakeElement[] = [];
        for (const child of this.childNodes) {
            if (child instanceof FakeElement) {
                if (pred(child)) {
                    out.push(child);
                }
                out.push(...child.findAll(pred));
            }
        }
        return out;
    }

    byTestId(id: string): FakeElement | undefined {
        return this.findAll((el) => el.getAttribute("data-testid") === id)[0];
    }
}

describe("Sonder-Inference token-probabilities protocol fixture", () => {
    const raw = readFileSync(new URL("../fixtures/sonder-inference-token-probabilities.jsonl", import.meta.url), "utf8");
    const parsed = parseNdjson(raw);
    const ordered = orderEvents(parsed.events);

    it("validates every envelope against the v1 schema without sequence gaps", () => {
        expect(parsed.rejected).toEqual([]);
        expect(parsed.events).toHaveLength(18);
        expect(ordered.gaps).toEqual([]);
        expect(ordered.duplicates).toBe(0);
    });

    it("parses post-sampling tokens and top alternatives at standard level without token_logits", () => {
        const postEnd = ordered.events.find((e) => e.request_id === "req-post-1" && e.event_type === "request.completed")!.mono_ns;
        const m = derivePipeline(ordered.events, { nowNs: postEnd });
        expect(caps(m).level).toBe("standard");
        expect(caps(m).backends).toEqual(["llamaserver"]);
        expect(caps(m).samplers).toEqual(["backend"]);
        expect(panel(m, "probabilities").status).toBe("available");
        expect(panel(m, "alternatives").status).toBe("available");

        expect(m.tokens).toHaveLength(2);
        expect(m.tokens[0]).toMatchObject({
            index: 0,
            tokenId: 13,
            probability: 0.75,
            probabilityBasis: "post_sampling",
            text: null,
        });
        expect(m.tokens[0]!.alternatives).toEqual([
            { tokenId: 13, probability: 0.75, text: null },
            { tokenId: 7, probability: 0.2, text: null },
            { tokenId: 9, probability: 0.05, text: null },
        ]);
        expect(m.tokens[1]).toMatchObject({
            index: 1,
            tokenId: 21,
            probability: 0.5,
            probabilityBasis: "post_sampling",
            text: null,
        });
        expect(m.tokens[1]!.alternatives).toEqual([
            { tokenId: 21, probability: 0.5, text: null },
            { tokenId: 4, probability: 0.3, text: null },
            { tokenId: 2, probability: 0.2, text: null },
        ]);
    });

    it("parses pre-sampling caller-requested chat logprobs", () => {
        const m = derivePipeline(ordered.events);
        expect(m.tokens).toHaveLength(3);
        const latest = m.tokens.at(-1)!;
        expect(latest).toMatchObject({
            index: 0,
            tokenId: 42,
            probability: 0.9,
            probabilityBasis: "pre_sampling",
            text: null,
        });
        expect(latest.alternatives).toEqual([
            { tokenId: 42, probability: 0.9, text: null },
            { tokenId: 8, probability: 0.1, text: null },
        ]);
    });
});

describe("token probabilities and alternatives capability rules", () => {
    const llamaserverIdle = [
        ev(0, "backend.registered", { backend: "llamaserver", capabilities: LLAMASERVER_CAPS }),
        ev(1, "session.created", { model: "fake-model", backend: "llamaserver", text_capture: "off" }),
    ];

    it("enables probabilities and alternatives readiness when logprobs is advertised at standard level without token_logits", () => {
        const standard = derivePipeline(llamaserverIdle, { declaredLevels: new Map([[INSTANCE, "standard"]]) });
        expect(panel(standard, "probabilities").status).toBe("waiting");
        expect(panel(standard, "alternatives").status).toBe("waiting");
        expect(panel(standard, "probabilities").reason).not.toContain("does not expose token logits");
        expect(panel(standard, "alternatives").reason).not.toContain("does not emit");

        const deep = derivePipeline(llamaserverIdle, { declaredLevels: new Map([[INSTANCE, "deep"]]) });
        expect(panel(deep, "probabilities").status).toBe("waiting");
        expect(panel(deep, "alternatives").status).toBe("waiting");
    });

    it("enables logprobs readiness from live health capabilities without backend.registered", () => {
        const sessionOnly = [ev(0, "session.created", { model: "fake-model", backend: "llamaserver", text_capture: "off" })];
        const m = derivePipeline(sessionOnly, {
            declaredLevels: new Map([[INSTANCE, "standard"]]),
            health: new Map([[INSTANCE, [{ name: "llamaserver", available: true, capabilities: ["streaming", "logprobs"] }]]]),
        });
        expect(panel(m, "probabilities").status).toBe("waiting");
        expect(panel(m, "alternatives").status).toBe("waiting");
    });

    it("marks logprobs panels unavailable with accurate level guidance when telemetry level is below standard", () => {
        for (const lvl of ["metrics", "off"] as const) {
            const m = derivePipeline(llamaserverIdle, { declaredLevels: new Map([[INSTANCE, lvl]]) });
            const probs = panel(m, "probabilities");
            const alts = panel(m, "alternatives");
            expect(probs.status, lvl).toBe("unavailable");
            expect(alts.status, lvl).toBe("unavailable");
            expect(probs.reason, lvl).toContain("`logprobs`");
            expect(probs.reason, lvl).toContain(`\`${lvl}\``);
            expect(probs.reason, lvl).toContain("--telemetry-level standard");
            expect(alts.reason, lvl).toContain("`logprobs`");
            expect(alts.reason, lvl).toContain(`\`${lvl}\``);
            expect(alts.reason, lvl).toContain("--telemetry-level standard");
        }
    });

    it("keeps probabilities waiting (not missing-logits) when a logprobs backend sends chunk-only output (e.g. top_k 0)", () => {
        const events = [
            ...llamaserverIdle,
            ev(2, "request.started", { kind: "generate", scheduled: false, sampler: "backend" }, { requestId: "r-chunk" }),
            ev(3, "inference.decode.started", { ttft_ms: 5 }, { requestId: "r-chunk" }),
            ev(4, "inference.token.generated", { index: 0, bytes: 2, elapsed_ms: 5, unit: "chunk" }, { requestId: "r-chunk", level: "standard" }),
        ];
        const m = derivePipeline(events);
        const probs = panel(m, "probabilities");
        const alts = panel(m, "alternatives");
        expect(probs.status).toBe("waiting");
        expect(probs.reason).not.toContain("does not expose token logits");
        expect(alts.status).toBe("waiting");
    });

    it("keeps probabilityEvents > 0 as the strongest signal even without logprobs/token_logits or at metrics declared level", () => {
        const events = [
            ev(0, "backend.registered", { backend: "custom", capabilities: ["streaming"] }),
            ev(1, "session.created", { model: "m", backend: "custom" }),
            ev(2, "request.started", { kind: "generate", sampler: "backend" }, { requestId: "r1" }),
            ev(3, "inference.token.generated", { index: 0, unit: "token", count: 1, token_id: 5, probability: 0.6 }, { requestId: "r1", level: "standard" }),
        ];
        const m = derivePipeline(events, { declaredLevels: new Map([[INSTANCE, "metrics"]]) });
        expect(panel(m, "probabilities").status).toBe("available");
        expect(panel(m, "alternatives").status).toBe("unavailable");
        expect(panel(m, "alternatives").reason).toContain("emits token probabilities");
    });

    it("enables alternatives when inference.sampling.candidates events arrive at standard level without token_logits or logprobs", () => {
        const events = [
            ev(0, "backend.registered", { backend: "custom", capabilities: ["streaming"] }),
            ev(1, "session.created", { model: "m", backend: "custom" }),
            ev(2, "request.started", { kind: "generate", sampler: "backend" }, { requestId: "r1" }),
            ev(
                3,
                "inference.token.generated",
                { index: 0, unit: "token", count: 1, token_id: 5, probability: 0.6, probability_basis: "post_sampling" },
                { requestId: "r1", level: "standard" },
            ),
            ev(
                4,
                "inference.sampling.candidates",
                {
                    index: 0,
                    sampled_token_id: 5,
                    probability_basis: "post_sampling",
                    candidates: [
                        { token_id: 5, probability: 0.6 },
                        { token_id: 6, probability: 0.4 },
                    ],
                },
                { requestId: "r1", level: "standard" },
            ),
        ];
        const m = derivePipeline(events);
        expect(caps(m).level).toBe("standard");
        expect(panel(m, "probabilities").status).toBe("available");
        expect(panel(m, "alternatives").status).toBe("available");
    });

    it("explains accurately why a token_logits-only backend has no alternatives while logprobs backends do", () => {
        const events = [
            ev(0, "backend.registered", { backend: "mock", capabilities: ["token_logits"] }),
            ev(1, "session.created", { model: "mock:tiny", backend: "mock" }),
            ev(2, "request.started", { kind: "generate", sampler: "sonder" }, { requestId: "r1" }),
        ];
        const m = derivePipeline(events, { declaredLevels: new Map([[INSTANCE, "standard"]]) });
        expect(panel(m, "probabilities").status).toBe("waiting");
        const alts = panel(m, "alternatives");
        expect(alts.status).toBe("unavailable");
        expect(alts.reason).toContain("`token_logits`");
        expect(alts.reason).toContain("`logprobs`");
        expect(alts.reason).not.toContain("proposed");
    });

    it("keeps alternatives waiting mid-stream between token.generated and sampling.candidates on a logprobs backend", () => {
        const events = [
            ...llamaserverIdle,
            ev(2, "request.started", { kind: "generate", sampler: "backend" }, { requestId: "r1" }),
            ev(
                3,
                "inference.token.generated",
                { index: 0, unit: "token", count: 1, token_id: 13, probability: 0.75, probability_basis: "post_sampling" },
                { requestId: "r1", level: "standard" },
            ),
        ];
        const m = derivePipeline(events);
        expect(panel(m, "probabilities").status).toBe("available");
        expect(panel(m, "alternatives").status).toBe("waiting");
    });
});

describe("probability_basis derivation edge cases", () => {
    it("reads sampled_token_id and probability_basis from inference.sampling.candidates even when token event is absent or arrives later", () => {
        const candOnly = [
            ev(
                0,
                "inference.sampling.candidates",
                {
                    index: 0,
                    sampled_token_id: 42,
                    probability_basis: "pre_sampling",
                    candidates: [
                        { token_id: 42, probability: 0.9 },
                        { token_id: 8, probability: 0.1 },
                    ],
                },
                { requestId: "r1", level: "standard" },
            ),
        ];
        const m1 = derivePipeline(candOnly);
        expect(m1.tokens[0]).toMatchObject({ tokenId: 42, probabilityBasis: "pre_sampling", probability: null });

        // Token arrives later without probability_basis: keeps basis from candidates.
        const m2 = derivePipeline([
            ...candOnly,
            ev(1, "inference.token.generated", { index: 0, unit: "token", count: 1, probability: 0.9 }, { requestId: "r1", level: "standard" }),
        ]);
        expect(m2.tokens).toHaveLength(1);
        expect(m2.tokens[0]).toMatchObject({ tokenId: 42, probability: 0.9, probabilityBasis: "pre_sampling" });
    });

    it("keeps older producers without probability_basis working with probabilityBasis null and ignores unknown values", () => {
        const oldModel = derivePipeline(deepSyntheticFixture(2, 2));
        expect(oldModel.tokens.length).toBeGreaterThan(0);
        expect(oldModel.tokens.every((t) => t.probabilityBasis === null)).toBe(true);

        const unknownBasis = derivePipeline([
            ev(
                0,
                "inference.token.generated",
                { index: 0, unit: "token", count: 1, token_id: 1, probability: 0.5, probability_basis: "unexpected_mode" },
                { requestId: "r1", level: "standard" },
            ),
        ]);
        expect(unknownBasis.tokens[0]?.probabilityBasis).toBeNull();
    });

    it("honours text capture policy and stride/cap bounds mirroring SI four_token_body", () => {
        const events: ObservatoryEvent[] = [
            ev(0, "backend.registered", { backend: "llamaserver", capabilities: LLAMASERVER_CAPS }),
            ev(1, "session.created", { model: "fake-model", backend: "llamaserver", text_capture: "on" }),
            ev(2, "request.started", { kind: "generate", sampler: "backend" }, { requestId: "r-stride" }),
        ];
        let seq = 3;
        for (let i = 0; i < 4; i++) {
            const id = 100 + i;
            events.push(
                ev(
                    seq++,
                    "inference.token.generated",
                    { index: i, bytes: 2, elapsed_ms: 10 + i, unit: "token", count: 1, token_id: id, probability: 0.6, probability_basis: "post_sampling", text: `t${i}` },
                    { requestId: "r-stride", level: "standard" },
                ),
            );
            // stride 2, top_k 2: indices 0 and 2 carry candidates.
            if (i % 2 === 0) {
                events.push(
                    ev(
                        seq++,
                        "inference.sampling.candidates",
                        {
                            index: i,
                            sampled_token_id: id,
                            probability_basis: "post_sampling",
                            candidates: [
                                { token_id: id, probability: 0.6, text: `t${i}` },
                                { token_id: 1, probability: 0.3, text: "a" },
                            ],
                        },
                        { requestId: "r-stride", level: "standard" },
                    ),
                );
            }
        }
        const m = derivePipeline(events);
        expect(m.tokens).toHaveLength(4);
        expect(m.tokens[0]!.alternatives).toEqual([
            { tokenId: 100, probability: 0.6, text: "t0" },
            { tokenId: 1, probability: 0.3, text: "a" },
        ]);
        expect(m.tokens[1]!.alternatives).toBeNull();
        expect(m.tokens[2]!.alternatives).toHaveLength(2);
        expect(m.tokens[3]!.alternatives).toBeNull();
        expect(panel(m, "alternatives").status).toBe("available");
    });
});

describe("renderProbabilities and entity rows display probability_basis", () => {
    const savedDocument = globalThis.document;

    beforeEach(() => {
        (globalThis as unknown as { document: unknown }).document = {
            createElement: (tag: string) => new FakeElement(tag),
            createTextNode: (text: string) => new FakeText(text),
        };
    });

    afterEach(() => {
        (globalThis as unknown as { document: unknown }).document = savedDocument;
    });

    function render(events: readonly ObservatoryEvent[], opts?: Parameters<typeof derivePipeline>[1]) {
        const model = derivePipeline(events, opts);
        const root = new FakeElement("div");
        renderProbabilities(root as unknown as HTMLElement, model, () => {});
        return { root, model };
    }

    it('displays short label "post-sampling" for post_sampling tokens', () => {
        const events = [
            ev(0, "backend.registered", { backend: "llamaserver", capabilities: LLAMASERVER_CAPS }),
            ev(1, "session.created", { model: "fake-model", backend: "llamaserver", text_capture: "off" }),
            ev(2, "request.started", { kind: "generate", sampler: "backend" }, { requestId: "r1" }),
            ev(
                3,
                "inference.token.generated",
                { index: 0, unit: "token", count: 1, token_id: 13, probability: 0.75, probability_basis: "post_sampling" },
                { requestId: "r1", level: "standard" },
            ),
            ev(
                4,
                "inference.sampling.candidates",
                {
                    index: 0,
                    sampled_token_id: 13,
                    probability_basis: "post_sampling",
                    candidates: [
                        { token_id: 13, probability: 0.75 },
                        { token_id: 7, probability: 0.2 },
                    ],
                },
                { requestId: "r1", level: "standard" },
            ),
        ];
        const { root, model } = render(events);
        const basis = root.byTestId("prob-basis");
        expect(basis).toBeDefined();
        expect(basis!.textContent).toBe("post-sampling");
        expect(basis!.getAttribute("data-basis")).toBe("post_sampling");
        expect(root.byTestId("prob-sampled")!.textContent).toContain("0.750");
        expect(root.byTestId("prob-alt-0")!.textContent).toContain("token 13");
        expect(root.byTestId("prob-alt-1")!.textContent).toContain("token 7");

        const rows = buildEntityRows(model, events, () => "0s");
        const tokRow = [...rows.values()].find((r) => r.kind === "token")!;
        expect(tokRow.state).toContain("post-sampling");
    });

    it('displays short label "pre-sampling" for pre_sampling tokens', () => {
        const events = [
            ev(0, "backend.registered", { backend: "llamaserver", capabilities: LLAMASERVER_CAPS }),
            ev(1, "session.created", { model: "fake-model", backend: "llamaserver", text_capture: "off" }),
            ev(2, "request.started", { kind: "chat", sampler: "backend" }, { requestId: "r2" }),
            ev(
                3,
                "inference.token.generated",
                { index: 0, unit: "token", count: 1, token_id: 42, probability: 0.9, probability_basis: "pre_sampling" },
                { requestId: "r2", level: "standard" },
            ),
            ev(
                4,
                "inference.sampling.candidates",
                {
                    index: 0,
                    sampled_token_id: 42,
                    probability_basis: "pre_sampling",
                    candidates: [
                        { token_id: 42, probability: 0.9 },
                        { token_id: 8, probability: 0.1 },
                    ],
                },
                { requestId: "r2", level: "standard" },
            ),
        ];
        const { root, model } = render(events);
        const basis = root.byTestId("prob-basis");
        expect(basis).toBeDefined();
        expect(basis!.textContent).toBe("pre-sampling");
        expect(basis!.getAttribute("data-basis")).toBe("pre_sampling");

        const rows = buildEntityRows(model, events, () => "0s");
        const tokRow = [...rows.values()].find((r) => r.kind === "token")!;
        expect(tokRow.state).toContain("pre-sampling");
    });

    it("omits the basis label for older producers without probability_basis", () => {
        const events = deepSyntheticFixture(2, 2);
        const { root, model } = render(events);
        expect(root.byTestId("prob-basis")).toBeUndefined();
        expect(root.byTestId("prob-sampled")).toBeDefined();
        expect(root.byTestId("prob-alt-0")).toBeDefined();

        const rows = buildEntityRows(model, events, () => "0s");
        const tokRow = [...rows.values()].find((r) => r.kind === "token")!;
        expect(tokRow.state).toMatch(/^p \d\.\d{3}$/);
    });

    it("shows an accurate per-token message instead of blaming the producer when stride/cap skips candidates on the latest token", () => {
        const events = [
            ev(0, "backend.registered", { backend: "llamaserver", capabilities: LLAMASERVER_CAPS }),
            ev(1, "session.created", { model: "fake-model", backend: "llamaserver", text_capture: "off" }),
            ev(2, "request.started", { kind: "generate", sampler: "backend" }, { requestId: "r-cap" }),
            ev(
                3,
                "inference.token.generated",
                { index: 0, unit: "token", count: 1, token_id: 100, probability: 0.6, probability_basis: "post_sampling" },
                { requestId: "r-cap", level: "standard" },
            ),
            ev(
                4,
                "inference.sampling.candidates",
                { index: 0, sampled_token_id: 100, probability_basis: "post_sampling", candidates: [{ token_id: 100, probability: 0.6 }, { token_id: 1, probability: 0.3 }] },
                { requestId: "r-cap", level: "standard" },
            ),
            ev(
                5,
                "inference.token.generated",
                { index: 1, unit: "token", count: 1, token_id: 101, probability: 0.6, probability_basis: "post_sampling" },
                { requestId: "r-cap", level: "standard" },
            ),
        ];
        const { root } = render(events);
        expect(root.byTestId("prob-basis")!.textContent).toBe("post-sampling");
        const altNotice = root.findAll((el) => el.getAttribute("data-panel") === "alternatives")[0];
        expect(altNotice).toBeDefined();
        expect(altNotice!.textContent).not.toContain("does not report alternatives");
        expect(altNotice!.textContent).toContain("this token");
    });

    it("shows Waiting for data when a logprobs producer has not emitted tokens yet", () => {
        const events = [
            ev(0, "backend.registered", { backend: "llamaserver", capabilities: LLAMASERVER_CAPS }),
            ev(1, "session.created", { model: "fake-model", backend: "llamaserver", text_capture: "off" }),
        ];
        const { root } = render(events, { declaredLevels: new Map([[INSTANCE, "standard"]]) });
        const notice = root.findAll((el) => el.getAttribute("data-panel") === "probabilities")[0]!;
        expect(notice.textContent).toContain("Waiting for data.");
    });
});
