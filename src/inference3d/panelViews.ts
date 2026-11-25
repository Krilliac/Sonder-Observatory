/**
 * HUD, side-rail, capabilities, notices, legend, camera-control, and projected
 * label DOM renderers for the 3D Inference tab.
 */
import { h } from "../renderer/dom";
import type { PanelAvailability, PipelineModel, ProducerCapabilities } from "./model";
import { STAGES } from "./model";
import type { ProjectedLabel } from "./scene";

export type CameraNudgeAction = "left" | "right" | "up" | "down" | "in" | "out";
export type CameraAction = CameraNudgeAction | "reset";

const STATUS_WORD: Record<PanelAvailability["status"], string> = {
    available: "available",
    unavailable: "not available",
    waiting: "waiting for data",
    "not-applicable": "not applicable",
};

const MAX_OUTPUT_ROWS = 10;

export function fmtRate(r: number): string {
    return r === 0 ? "idle" : `${r < 10 ? r.toFixed(1) : Math.round(r)}/s`;
}

export function fmtBytes(n: number | null): string {
    return n === null ? "? B" : `${n} B`;
}

export function fmtMs(n: number | null): string {
    return n === null ? "—" : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(2)} s`;
}

/** Drops null/false children (replaceChildren rejects them). */
export function nodes(...items: (Node | string | null | false | undefined)[]): (Node | string)[] {
    return items.filter((x): x is Node | string => x !== null && x !== false && x !== undefined);
}

/** Plain text with `code` spans rendered as <code>. */
export function richText(text: string): (Node | string)[] {
    return text.split(/(`[^`]+`)/).map((part) => (part.startsWith("`") && part.endsWith("`") ? h("code", { text: part.slice(1, -1) }) : part));
}

export function createCameraControls(onAction: (action: CameraAction) => void): HTMLElement {
    const cameraButtons = h(
        "div",
        { class: "i3d-camera", role: "group", "aria-label": "Camera" },
        ...(
            [
                ["left", "Rotate left", "⟲"],
                ["right", "Rotate right", "⟳"],
                ["up", "Tilt up", "↑"],
                ["down", "Tilt down", "↓"],
                ["in", "Zoom in", "+"],
                ["out", "Zoom out", "−"],
            ] as const
        ).map(([action, label, glyph]) =>
            h("button", { type: "button", class: "small i3d-cam-btn", "data-camera": action, "aria-label": label, title: label, text: glyph }),
        ),
        h("button", { type: "button", class: "small", "data-camera": "reset", text: "Reset view" }),
    );
    cameraButtons.addEventListener("click", (ev) => {
        const action = (ev.target as HTMLElement).closest<HTMLElement>("[data-camera]")?.dataset.camera as CameraAction | undefined;
        if (action) {
            onAction(action);
        }
    });
    return cameraButtons;
}

/** First non-available reason of a panel across producers that can have internals (not Runtime). */
function reasonFor(model: PipelineModel, panel: PanelAvailability["panel"]): { text: string; status: PanelAvailability["status"] }[] {
    const out: { text: string; status: PanelAvailability["status"] }[] = [];
    for (const c of model.capabilities) {
        const p = c.panels.find((x) => x.panel === panel);
        if (!p || p.status === "available" || p.status === "not-applicable") {
            continue;
        }
        out.push({ text: model.capabilities.length > 1 ? `${c.producer} @ ${c.nodeId}: ${p.reason}` : p.reason, status: p.status });
    }
    return out;
}

export function renderCapabilities(container: HTMLElement, model: PipelineModel): void {
    const producers = model.capabilities;
    const chip = (p: PanelAvailability) =>
        h(
            "li",
            { class: "i3d-chip", "data-status": p.status, "data-panel": p.panel },
            h("span", { class: "i3d-chip-label", text: p.label }),
            h("span", { class: "i3d-chip-status", text: STATUS_WORD[p.status] }),
        );
    const row = (c: ProducerCapabilities) => {
        const backend = c.backends.length > 0 ? c.backends.join(", ") : "backend not named";
        const caps = c.backends
            .map((b) => c.backendCapabilities[b])
            .filter((x) => x !== undefined)
            .map((x) => `${x!.capabilities.join(", ") || "none"} (${x!.source})`)
            .join("; ");
        const reasons = c.panels.filter((p) => p.status !== "available");
        return h(
            "div",
            { class: "i3d-caps-row", "data-producer": `${c.producer}@${c.nodeId}` },
            h(
                "div",
                { class: "i3d-caps-who" },
                h("strong", { text: `${c.producer} @ ${c.nodeId}` }),
                c.synthetic ? h("span", { class: "tag tag-synthetic", text: "synthetic" }) : null,
                h("span", { class: "muted small", text: ` ${backend}${caps ? ` · capabilities: ${caps}` : ""} · level ${c.level ?? "unknown"}` }),
            ),
            h("ul", { class: "i3d-chips", "aria-label": `Panels for ${c.producer} at ${c.nodeId}` }, ...c.panels.map(chip)),
            reasons.length > 0
                ? h(
                      "details",
                      { class: "i3d-reasons" },
                      h("summary", { text: `Why ${reasons.length} panel${reasons.length === 1 ? " is" : "s are"} not showing data` }),
                      h("ul", {}, ...reasons.map((p) => h("li", { "data-panel": p.panel }, h("strong", { text: `${p.label}: ` }), ...richText(p.reason)))),
                  )
                : null,
        );
    };
    container.replaceChildren(
        h("h3", { id: "i3d-caps-title", text: "Capabilities" }),
        producers.length === 0
            ? h("p", { class: "muted small", text: "No producer events at the cursor yet." })
            : h("div", { class: "i3d-caps-rows" }, ...producers.map(row)),
    );
}

export function renderNotices(container: HTMLElement, model: PipelineModel, webgl: boolean): void {
    const items: HTMLElement[] = [];
    if (!model.hasLayers) {
        const reasons = reasonFor(model, "layers");
        const text = reasons.length > 0 ? reasons.map((r) => r.text) : ["no producer at the cursor sends backend.layer.* events"];
        items.push(
            h(
                "div",
                { class: "i3d-notice", role: "note", "data-notice": "layers" },
                h("strong", { text: "Layer internals: not available. " }),
                "The scene shows the reported request pipeline instead of model layers.",
                h("ul", {}, ...text.map((t) => h("li", {}, ...richText(t)))),
            ),
        );
    }
    if (!webgl) {
        items.unshift(
            h(
                "div",
                { class: "i3d-notice", role: "note", "data-notice": "webgl" },
                h("strong", { text: "WebGL 2 is unavailable in this browser. " }),
                "Showing a 2D summary of the same pipeline; the entity table below lists every entity.",
            ),
        );
    }
    container.replaceChildren(...items);
}

export function renderStageRail(
    container: HTMLElement,
    model: PipelineModel | null,
    selected: string | null,
    onSelect: (id: string) => void,
): void {
    if (!model) {
        return;
    }
    const items: HTMLElement[] = [];
    for (const s of model.stages) {
        const def = STAGES.find((d) => d.id === s.id)!;
        const id = `stage:${s.id}`;
        const holding =
            s.id === "output"
                ? `${s.requests} finished${s.cancelledRequests ? ` (${s.cancelledRequests} cancelled)` : ""}`
                : `${s.requests} in flight`;
        const btn = h(
            "button",
            { type: "button", class: "i3d-stage-btn", "data-entity": id, "aria-pressed": selected === id ? "true" : "false" },
            h("span", { class: "i3d-stage-name", text: s.label }),
            h("span", { class: "i3d-stage-meta", text: `${holding} · ${s.events} events · ${fmtRate(s.ratePerSec)}` }),
        );
        btn.title = `Placed by: ${def.evidence}`;
        btn.addEventListener("click", () => onSelect(id));
        const li = h("li", { "data-stage": s.id }, btn);
        if (s.id === "layers") {
            const layers = h("ol", { class: "i3d-layers", "aria-label": "Layers" });
            for (const l of model.layers) {
                const b = h("button", {
                    type: "button",
                    class: "i3d-layer-btn",
                    "data-entity": l.id,
                    "aria-pressed": selected === l.id ? "true" : "false",
                    text: `L${l.layer} · ${l.events} ev · ${fmtRate(l.ratePerSec)}`,
                });
                b.addEventListener("click", () => onSelect(l.id));
                layers.append(h("li", {}, b));
            }
            li.append(layers);
        }
        items.push(li);
    }
    container.replaceChildren(...items);
    if (!model.hasLayers) {
        container.append(h("li", { class: "i3d-stage-absent muted small", text: "Layers: not reported (see Capabilities)" }));
    }
}

export function renderOutputFeed(
    container: HTMLElement,
    model: PipelineModel,
    relativeTime: (ns: number) => string,
    onSelect: (id: string) => void,
): void {
    const chunks = model.chunks.slice(-MAX_OUTPUT_ROWS).reverse();
    if (chunks.length === 0) {
        container.replaceChildren(h("p", { class: "muted small", text: "No output events at the cursor." }));
        return;
    }
    const withheld = chunks.some((c) => c.textWithheld) || chunks.every((c) => c.text === null);
    const reqById = new Map(model.requests.map((r) => [r.id, r]));
    const list = h(
        "ol",
        { class: "i3d-output-list", "aria-label": "Latest output events, newest first" },
        ...chunks.map((c) => {
            const r = c.requestEntityId ? reqById.get(c.requestEntityId) : undefined;
            const btn = h(
                "button",
                { type: "button", class: "i3d-output-row", "data-entity": c.id },
                h("span", { class: "i3d-output-req", text: `${r?.requestId ?? "no request"} #${c.index ?? "?"}` }),
                h("span", { class: "i3d-output-meta", text: `${c.unit} · ${fmtBytes(c.bytes)} · ${fmtMs(c.elapsedMs)} · ${relativeTime(c.ns)}` }),
                c.text !== null ? h("span", { class: "i3d-output-text", text: JSON.stringify(c.text) }) : null,
            );
            btn.addEventListener("click", () => onSelect(c.id));
            return h("li", {}, btn);
        }),
    );
    const note = withheld
        ? h("p", { class: "muted small", text: "Text is not shown: the producer's text capture policy does not allow it (sizes and timing only)." })
        : null;
    const chunkOnly = chunks.every((c) => c.tokens === null);
    container.replaceChildren(
        ...nodes(
            list,
            note,
            chunkOnly
                ? h("p", {
                      class: "muted small",
                      text: "Unit chunk: a backend-streamed piece of text; its token count is not reported (see backend completion tokens on the request).",
                  })
                : null,
        ),
    );
}

export function renderProbabilities(container: HTMLElement, model: PipelineModel, onSelect: (id: string) => void): void {
    const latest = model.tokens.at(-1);
    if (!latest) {
        const reasons = reasonFor(model, "probabilities");
        container.replaceChildren(
            h(
                "div",
                { class: "i3d-unavailable", "data-panel": "probabilities" },
                h("strong", { text: "Not available." }),
                h(
                    "ul",
                    {},
                    ...(reasons.length > 0 ? reasons : [{ text: "no token event with a probability at the cursor", status: "unavailable" as const }]).map(
                        (r) => h("li", {}, ...richText(r.text)),
                    ),
                ),
            ),
        );
        return;
    }
    const bar = (label: string, p: number, testid: string) =>
        h(
            "li",
            { class: "i3d-prob", "data-testid": testid },
            h("span", { class: "i3d-prob-label", text: label }),
            h(
                "span",
                { class: "i3d-prob-bar", "aria-hidden": "true" },
                h("span", { class: "i3d-prob-fill", style: `width:${Math.round(Math.min(1, Math.max(0, p)) * 100)}%` }),
            ),
            h("span", { class: "i3d-prob-value", text: p.toFixed(3) }),
        );
    const tokenLabel = latest.text !== null ? JSON.stringify(latest.text) : latest.tokenId !== null ? `token ${latest.tokenId}` : "sampled token";
    const alternatives = latest.alternatives;
    const altReasons = reasonFor(model, "alternatives");
    const btn = h("button", { type: "button", class: "link-button", "data-entity": latest.id, text: `Token #${latest.index ?? "?"}: ${tokenLabel}` });
    btn.addEventListener("click", () => onSelect(latest.id));
    container.replaceChildren(
        ...nodes(
            btn,
            latest.probability !== null
                ? h("ul", { class: "i3d-prob-list", "aria-label": "Sampled token probability" }, bar("probability", latest.probability, "prob-sampled"))
                : null,
            latest.probability !== null
                ? h("p", { class: "muted small", text: `log-probability ${Math.log(latest.probability).toFixed(3)} (derived: ln p)` })
                : null,
            h("h4", { text: "Top alternatives" }),
            alternatives
                ? h(
                      "ol",
                      { class: "i3d-prob-list", "aria-label": "Top alternatives" },
                      ...alternatives
                          .slice(0, 5)
                          .map((a, i) =>
                              bar(
                                  a.text !== null ? JSON.stringify(a.text) : a.tokenId !== null ? `token ${a.tokenId}` : "?",
                                  a.probability,
                                  `prob-alt-${i}`,
                              ),
                          ),
                  )
                : h(
                      "div",
                      { class: "i3d-unavailable", "data-panel": "alternatives" },
                      h("strong", { text: "Not available. " }),
                      ...richText(altReasons[0]?.text ?? "the producer does not report alternatives"),
                  ),
        ),
    );
}

export function renderLegend(container: HTMLElement, model: PipelineModel): void {
    const item = (swatch: string, text: string) => h("li", {}, h("span", { class: `swatch i3d-sw ${swatch}`, "aria-hidden": "true" }), text);
    const stageNames = model.stages.map((s) => s.label).join(" → ");
    container.replaceChildren(
        ...nodes(
            item("i3d-sw-depth", `Depth, left to right: ${stageNames}`),
            item("i3d-sw-lane", "Row: one model on one node; bands group nodes"),
            item("i3d-sw-active", "Sphere: an inference request in flight"),
            item("i3d-sw-runtime", "Sphere: a Runtime turn in flight; line to the inference request it caused"),
            item("i3d-sw-completed", "Completed request"),
            item("i3d-sw-failed", "Failed request"),
            item("i3d-sw-cancelled", "Cancelled request"),
            item("i3d-sw-size", "Sphere size: backend-reported tokens (completion, else prompt; smallest when not reported)"),
            item("i3d-sw-chunk", "Small point: a sampled output event; size = bytes; drifts to Output and fades over 8 s"),
            item("i3d-sw-pulse", "Plane outline pulse: stage event rate over the last 5 s (steady when idle or with reduced motion)"),
            item("i3d-sw-age", "Opacity: age since the request finished (fades over 60 s)"),
            item("i3d-sw-kv", "Box: logical KV pool per producer; fill = blocks in use / total (amber high, red critical)"),
            model.hasLayers ? item("i3d-sw-layer", "Thin planes L0…Ln: backend.layer.* events; brightness = activation RMS when reported") : null,
            model.operators.length > 0 ? item("i3d-sw-op", "Cube above a layer: backend.operator.* (purple attention, cyan MLP, grey other)") : null,
            model.tokens.some((t) => t.alternatives)
                ? item("i3d-sw-prob", "Bars beside Output: top alternatives of the latest token (length = probability)")
                : null,
            item("i3d-sw-selected", "Outline cube: the selected entity"),
        ),
    );
}

export function renderPipelineSummary(summaryEl: HTMLElement, canvasEl: HTMLCanvasElement, model: PipelineModel): void {
    const active = model.requests.filter((r) => r.state === "active").length;
    const text =
        `${model.lanes.length} lane(s) on ${model.nodes.length} node(s); ${active} request(s) in flight, ` +
        model.stages.map((s) => `${s.label} ${s.requests}`).join(", ") +
        `; ${model.chunks.length} recent output event(s); ${model.kvPools.length} KV pool(s)` +
        (model.hasLayers ? `; ${model.layers.length} layer plane(s)` : "; layer internals not reported") +
        (model.omittedFinished > 0 ? `; ${model.omittedFinished} older finished request(s) not drawn` : "") +
        ". The table below lists every entity.";
    if (summaryEl.textContent !== text) {
        summaryEl.textContent = text;
        canvasEl.setAttribute("aria-label", `3D inference pipeline: ${model.stages.map((s) => s.label).join(", ")}`);
    }
}

export function placeProjectedLabels(container: HTMLElement, labels: readonly ProjectedLabel[], previousStamp: string): string {
    const stamp = labels.map((l) => `${l.id}:${Math.round(l.x)},${Math.round(l.y)},${l.visible}`).join("|");
    if (stamp === previousStamp) {
        return previousStamp;
    }
    container.replaceChildren(
        ...labels
            .filter((l) => l.visible)
            .map((l) =>
                h("span", {
                    class: `i3d-label i3d-label-${l.kind}`,
                    style: `transform: translate(${Math.round(l.x)}px, ${Math.round(l.y)}px)`,
                    text: l.text,
                }),
            ),
    );
    return stamp;
}
