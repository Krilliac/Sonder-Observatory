/**
 * Text-alternative entity table, selection/evidence panel, and 2D WebGL
 * fallback table for the 3D Inference tab.
 */
import type { ObservatoryEvent } from "../protocol/events";
import { h } from "../renderer/dom";
import { streamLabel } from "./derive";
import { requestLabel, requestLabelsAt } from "./labels";
import type { PipelineModel } from "./model";
import { STAGES } from "./model";
import { fmtBytes, fmtMs, fmtProbabilityBasis, fmtRate } from "./panelViews";

export interface EntityRow {
    id: string;
    kind: string;
    label: string;
    where: string;
    state: string;
    measures: string;
    evidence: string[];
}

const MAX_CHUNK_ROWS = 20;

export function buildEntityRows(
    model: PipelineModel,
    visible: readonly ObservatoryEvent[],
    relativeTime: (ns: number) => string,
): Map<string, EntityRow> {
    const rows = new Map<string, EntityRow>();
    const add = (r: EntityRow) => rows.set(r.id, r);
    for (const s of model.stages) {
        if (s.id === "layers") {
            continue;
        }
        add({
            id: `stage:${s.id}`,
            kind: "stage",
            label: s.label,
            where: "pipeline",
            state:
                s.id === "output"
                    ? `${s.requests} finished${s.cancelledRequests ? ` (${s.cancelledRequests} cancelled)` : ""}`
                    : `${s.requests} in flight`,
            measures: `${s.events} events · ${fmtRate(s.ratePerSec)}`,
            evidence: s.evidence,
        });
    }
    for (const l of model.layers) {
        add({
            id: l.id,
            kind: "layer",
            label: `L${l.layer}${l.layerCount !== null ? ` of ${l.layerCount}` : ""}`,
            where: streamLabel(l.stream),
            state: fmtRate(l.ratePerSec),
            measures: [
                `${l.events} events`,
                l.lastDurationMs !== null ? `last ${l.lastDurationMs.toFixed(2)} ms` : "",
                l.activationRms !== null ? `activation RMS ${l.activationRms.toFixed(2)}` : "",
                l.attentionEntropy !== null ? `attention entropy ${l.attentionEntropy.toFixed(2)}` : "",
            ]
                .filter(Boolean)
                .join(" · "),
            evidence: l.evidence,
        });
    }
    for (const o of model.operators) {
        add({
            id: o.id,
            kind: "operator",
            label: `${o.operator}${o.layer !== null ? ` @ L${o.layer}` : ""}`,
            where: streamLabel(o.stream),
            state: fmtRate(o.ratePerSec),
            measures: `${o.events} events · ${o.totalDurationMs.toFixed(2)} ms total`,
            evidence: o.evidence,
        });
    }
    for (const r of model.requests) {
        const tokens =
            r.completionTokens !== null
                ? `${r.completionTokens} completion tokens (backend)`
                : r.promptTokens !== null
                  ? `${r.promptTokens} prompt tokens`
                  : "tokens not reported yet";
        const stageLabel = STAGES.find((s) => s.id === r.stage)!.label;
        const fromLabel =
            r.state === "cancelled" && r.lastActiveStage
                ? ` (from ${STAGES.find((s) => s.id === r.lastActiveStage)?.label ?? r.lastActiveStage})`
                : "";
        add({
            id: r.id,
            kind: r.role === "runtime" ? "runtime turn" : "request",
            label: r.requestId,
            where: `${r.model} @ ${r.nodeId}`,
            state: `${r.state}${fromLabel} · ${stageLabel}`,
            measures: `${tokens} · ${r.outputEvents} output events · started ${relativeTime(r.startNs)}`,
            evidence: r.evidence,
        });
    }
    for (const k of model.kvPools) {
        const frac = k.totalBlocks ? ` of ${k.totalBlocks}` : "";
        add({
            id: k.id,
            kind: "KV pool",
            label: streamLabel(k.stream),
            where: k.nodeId,
            state: k.level ?? "no pressure report",
            measures: `${k.usedBlocks}${frac} blocks in use${k.occupancy !== null ? ` · occupancy ${(k.occupancy * 100).toFixed(0)}%` : ""} · ${k.reusedTokens} reused tokens`,
            evidence: k.evidence,
        });
    }
    const latest = model.tokens.at(-1);
    const chunks = model.chunks.slice(-MAX_CHUNK_ROWS);
    const requestLabels = requestLabelsAt(visible, latest ? [...chunks, latest] : chunks, model.nowNs);
    for (const c of chunks) {
        add({
            id: c.id,
            kind: "output",
            label: `#${c.index ?? "?"}`,
            where: requestLabel(c.requestEntityId, requestLabels),
            state: c.unit,
            measures: `${fmtBytes(c.bytes)} · ${fmtMs(c.elapsedMs)}`,
            evidence: [c.eventId],
        });
    }
    if (latest) {
        const probState = latest.probability !== null ? `p ${latest.probability.toFixed(3)}` : "no probability";
        const basisLabel = fmtProbabilityBasis(latest.probabilityBasis);
        add({
            id: latest.id,
            kind: "token",
            label: `#${latest.index ?? "?"}`,
            where: requestLabel(latest.requestEntityId, requestLabels),
            state: basisLabel ? `${probState} · ${basisLabel}` : probState,
            measures: latest.alternatives ? `${latest.alternatives.length} alternatives` : "no alternatives",
            evidence: latest.candidatesEventId ? [latest.eventId, latest.candidatesEventId] : [latest.eventId],
        });
    }
    return rows;
}

export function renderEntityTable(
    container: HTMLElement,
    rowsMap: ReadonlyMap<string, EntityRow>,
    selected: string | null,
    onSelect: (id: string) => void,
): void {
    const rows = [...rowsMap.values()];
    if (rows.length === 0) {
        container.replaceChildren(h("p", { class: "muted small", text: "No entities at the cursor." }));
        return;
    }
    const hadFocus = container.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.entity : undefined;
    const tbody = h("tbody");
    for (const r of rows) {
        const btn = h("button", {
            type: "button",
            class: "link",
            "data-entity": r.id,
            "aria-pressed": r.id === selected ? "true" : "false",
            text: r.label,
        });
        btn.addEventListener("click", () => onSelect(r.id));
        tbody.append(
            h(
                "tr",
                { class: r.id === selected ? "selected" : "", "data-entity-row": r.id },
                h("td", { text: r.kind }),
                h("td", {}, btn),
                h("td", { text: r.where }),
                h("td", { text: r.state }),
                h("td", { text: r.measures }),
                h("td", { class: "mono", text: String(r.evidence.length) }),
            ),
        );
    }
    container.replaceChildren(
        h(
            "table",
            { class: "i3d-table" },
            h("caption", { class: "sr-only", text: "Every entity drawn in the 3D scene; select one to inspect its evidence" }),
            h("thead", {}, h("tr", {}, ...["Kind", "Entity", "Where", "State", "Measures", "Evidence"].map((t) => h("th", { scope: "col", text: t })))),
            tbody,
        ),
    );
    if (hadFocus) {
        container.querySelector<HTMLElement>(`[data-entity="${CSS.escape(hadFocus)}"]`)?.focus();
    }
}

export function renderSelectionPanel(
    container: HTMLElement,
    selected: string | null,
    rowsMap: ReadonlyMap<string, EntityRow>,
    byId: ReadonlyMap<string, ObservatoryEvent>,
    onInspect: (event: ObservatoryEvent) => void,
): void {
    const row = selected ? rowsMap.get(selected) : undefined;
    if (!selected) {
        container.replaceChildren(
            h("p", { class: "muted small", text: "Select an entity in the scene or the table to open its evidence in the Inspector." }),
        );
        return;
    }
    if (!row) {
        container.replaceChildren(h("p", { class: "muted small", text: "The selected entity does not exist at the replay cursor." }));
        return;
    }
    const evidence = [...row.evidence].reverse().slice(0, 12);
    container.replaceChildren(
        h("p", {}, h("strong", { text: `Selected ${row.kind} ${row.label}` }), ` · ${row.where} · ${row.state} · ${row.measures}`),
        h(
            "ul",
            { class: "related i3d-evidence", "aria-label": "Evidence events, newest first" },
            ...evidence.map((id) => {
                const e = byId.get(id);
                const b = h("button", { type: "button", class: "link", text: e ? `${e.event_type} · ${id}` : id });
                b.addEventListener("click", () => e && onInspect(e));
                return h("li", {}, b);
            }),
        ),
    );
}

export function renderFallbackTable(container: HTMLElement, model: PipelineModel): void {
    const stages = model.stages.filter((s) => s.id !== "layers");
    const table = h(
        "table",
        { class: "i3d-table i3d-fallback-table" },
        h("caption", { text: "Requests per lane and stage at the cursor" }),
        h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Lane" }), ...stages.map((s) => h("th", { scope: "col", text: s.label })))),
        h(
            "tbody",
            {},
            ...model.lanes.map((l) =>
                h(
                    "tr",
                    {},
                    h("th", { scope: "row", text: `${l.model} @ ${l.nodeId}` }),
                    ...stages.map((s) => {
                        const reqs = model.requests.filter((r) => r.laneKey === l.key && r.stage === s.id);
                        return h("td", { text: reqs.length === 0 ? "—" : reqs.map((r) => `${r.requestId} (${r.state})`).join(", ") });
                    }),
                ),
            ),
        ),
    );
    container.replaceChildren(table);
}
