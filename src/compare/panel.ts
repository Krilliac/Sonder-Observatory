/**
 * "Compare" view: two sessions side by side (A = baseline, B = candidate).
 * Implements ObservatoryPanel so the host can mount it as an analysis tab or
 * an extra panel; see docs/integration/compare.md for the wiring.
 */
import type { ObservatoryEvent } from "../protocol/events";
import { RECORDING_EXTENSION } from "../recording/sobs";
import { h } from "../renderer/dom";
import type { ObservatoryPanel, PanelContext } from "../renderer/panels";
import type { Comparison } from "./compare";
import { CompareController, type CompareControllerOptions, type LoadResult, type SideId } from "./controller";
import { METRICS, type MetricDelta, type MetricKey } from "./delta";
import { SEVERITY_TEXT, VERDICT_TEXT, describeAlignment, edgeText, formatDelta, formatValue, nodeText, presentDelta } from "./present";
import { ALIGN_MODES, type AlignMode } from "./summary";
import "./compare.css";

/** Metrics shown per aligned unit (the totals table shows all of METRICS). */
export const ROW_METRICS: readonly MetricKey[] = [
    "ttftMs",
    "decodeTokPerSec",
    "promptTokens",
    "completionTokens",
    "costUsd",
    "retries",
    "cacheHitRate",
    "errors",
];

/** Aligned rows rendered at most (large sessions); the rest are summarized. */
export const MAX_ROWS = 200;

const MODE_LABEL: Record<AlignMode, string> = { run: "Run", request: "Request", turn: "Turn" };

export interface ComparePanelOptions extends CompareControllerOptions {
    /** Label for the viewer's current session, e.g. "live: ws://127.0.0.1:7878" or a file name. */
    describeCurrent?: () => string;
}

export class ComparePanel implements ObservatoryPanel {
    readonly id = "compare";
    readonly title = "Compare";
    readonly controller: CompareController;
    private readonly describeCurrent: (() => string) | undefined;
    private container: HTMLElement | null = null;
    private ctx: PanelContext | null = null;
    private results: HTMLElement | null = null;
    private sideEls: Partial<Record<SideId, { source: HTMLElement; error: HTMLElement; current: HTMLButtonElement; clear: HTMLButtonElement }>> = {};
    private modeInputs: HTMLInputElement[] = [];
    private lastStamp = "";
    private refreshTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(options: ComparePanelOptions = {}) {
        this.controller = new CompareController(options);
        this.describeCurrent = options.describeCurrent;
    }

    render(container: HTMLElement, ctx: PanelContext): void {
        this.ctx = ctx;
        this.controller.setCurrent(ctx.all, this.describeCurrent?.() ?? "current session");
        if (this.container !== container || !container.contains(this.results)) {
            this.container = container;
            container.replaceChildren(this.build());
            this.lastStamp = "";
        }
        this.update();
    }

    /** Loads recording text into a side (file picker, desktop "Compare with…", tests). */
    loadRecordingText(side: SideId, text: string, label: string): LoadResult {
        const result = this.controller.loadRecordingText(side, text, label);
        this.update();
        return result;
    }

    /** Uses parsed events as a side (for example a second live connection's events). */
    setRecording(side: SideId, events: readonly ObservatoryEvent[], label: string): void {
        this.controller.setRecording(side, events, label);
        this.update();
    }

    comparison(): Comparison | null {
        return this.controller.comparison();
    }

    // ------------------------------------------------------------------ DOM

    private build(): HTMLElement {
        const sides = (["a", "b"] as const).map((id) => this.buildSide(id));
        const swap = h("button", { type: "button", class: "compare-swap", text: "Swap A ↔ B" });
        swap.addEventListener("click", () => {
            this.controller.swap();
            this.update();
        });
        const radios = ALIGN_MODES.map((mode) => {
            const input = h("input", { type: "radio", name: "compare-align", value: mode, checked: mode === this.controller.mode });
            input.addEventListener("change", () => {
                if (input.checked) {
                    this.controller.setMode(mode);
                    this.update();
                }
            });
            return input;
        });
        this.modeInputs = radios;
        this.results = h("div", { class: "compare-results", "aria-live": "polite" });
        return h(
            "section",
            { class: "compare", "aria-label": "Session comparison" },
            h("div", { class: "compare-sources" }, sides[0]!, swap, sides[1]!),
            h(
                "fieldset",
                { class: "compare-align" },
                h("legend", { text: "Align by" }),
                ...radios.map((r, i) => h("label", { class: "check" }, r, ` ${MODE_LABEL[ALIGN_MODES[i]!]}`)),
            ),
            this.results,
        );
    }

    private buildSide(id: SideId): HTMLElement {
        const inputId = `compare-file-${id}`;
        const file = h("input", {
            id: inputId,
            type: "file",
            class: "sr-only",
            accept: `${RECORDING_EXTENSION},.ndjson,.jsonl,.json`,
        });
        file.addEventListener("change", () => {
            const f = file.files?.[0];
            if (!f) {
                return;
            }
            void f.text().then((text) => {
                this.loadRecordingText(id, text, f.name);
                file.value = "";
            });
        });
        const current = h("button", { type: "button", class: "compare-use-current", text: "Use current session" });
        current.addEventListener("click", () => {
            this.controller.useCurrent(id);
            this.update();
        });
        const clear = h("button", { type: "button", class: "compare-clear", text: "Clear" });
        clear.addEventListener("click", () => {
            this.controller.clear(id);
            this.update();
        });
        const source = h("p", { class: "compare-source" });
        const error = h("p", { class: "compare-error", role: "alert", hidden: true });
        this.sideEls[id] = { source, error, current, clear };
        const title = this.controller.side(id).title;
        return h(
            "div",
            { class: `compare-side compare-side-${id}`, "data-side": id, role: "group", "aria-label": title },
            h("h3", { text: title }),
            source,
            error,
            h(
                "div",
                { class: "compare-side-actions" },
                h("label", { class: "button-like", for: inputId, text: "Open recording…" }),
                file,
                current,
                clear,
            ),
        );
    }

    private update(): void {
        if (!this.container || !this.results) {
            return;
        }
        const stamp = this.controller.stamp();
        this.scheduleRefresh();
        if (stamp === this.lastStamp) {
            return;
        }
        this.lastStamp = stamp;
        for (const id of ["a", "b"] as const) {
            const els = this.sideEls[id]!;
            const v = this.controller.side(id);
            const parts: (Node | string)[] = [];
            if (v.kind === "empty") {
                parts.push(h("span", { class: "muted", text: v.label }));
            } else {
                parts.push(h("span", { class: "compare-kind", text: v.kind === "current" ? "Current session: " : "Recording: " }));
                parts.push(h("span", { class: "compare-label mono", text: v.label }));
                parts.push(h("span", { class: "muted", text: ` · ${v.events ?? 0} events${v.rejected ? ` · ${v.rejected} rejected` : ""}` }));
                if (v.synthetic) {
                    parts.push(" ", h("span", { class: "badge badge-synthetic", text: "synthetic" }));
                }
            }
            els.source.replaceChildren(...parts);
            els.error.hidden = v.error === null;
            els.error.textContent = v.error ?? "";
            els.current.disabled = v.kind === "current";
            els.clear.disabled = v.kind === "empty";
        }
        for (const input of this.modeInputs) {
            input.checked = input.value === this.controller.mode;
        }
        const c = this.controller.comparison();
        this.results.replaceChildren(...(c ? renderComparison(c) : [renderEmpty()]));
    }

    private scheduleRefresh(): void {
        const ms = this.controller.pendingRefreshMs();
        if (ms === null || this.refreshTimer !== null) {
            return;
        }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = null;
            if (this.container && this.ctx && this.container.isConnected) {
                this.render(this.container, this.ctx);
            }
        }, ms + 10);
    }
}

function renderEmpty(): HTMLElement {
    return h("p", {
        class: "muted compare-empty",
        text: "Choose a session for A (baseline) and B (candidate): open a recording, or use the current session (fixture, file or live connection).",
    });
}

function verdictCell(d: MetricDelta): HTMLElement {
    return h("td", { class: `compare-verdict verdict-${d.verdict}`, text: VERDICT_TEXT[d.verdict] });
}

function heading(text: string, id: string): HTMLElement {
    return h("h3", { id, class: "compare-heading", text });
}

/** DOM for a comparison (results area of the panel). */
export function renderComparison(c: Comparison): HTMLElement[] {
    const out: HTMLElement[] = [];
    if (c.a.synthetic || c.b.synthetic) {
        out.push(
            h("p", {
                class: "provenance synthetic compare-provenance",
                text: `Synthetic data in ${c.a.synthetic && c.b.synthetic ? "A and B" : c.a.synthetic ? "A" : "B"}: generated by fixture scripts, not measured.`,
            }),
        );
    }
    out.push(...renderTotals(c), ...renderRows(c), ...renderFindings(c), ...renderGraph(c));
    return out;
}

function renderTotals(c: Comparison): HTMLElement[] {
    const rows = c.totals.filter((d) => d.verdict !== "n/a");
    const body = rows.map((d) => {
        const cell = presentDelta(d);
        return h(
            "tr",
            { "data-metric": d.key, "data-verdict": d.verdict },
            h("th", { scope: "row", text: cell.label }),
            h("td", { class: "num", text: cell.a }),
            h("td", { class: "num", text: cell.b }),
            h("td", { class: "num", text: cell.delta }),
            verdictCell(d),
        );
    });
    return [
        heading("Session totals", "compare-totals-heading"),
        h(
            "table",
            { id: "compare-totals", class: "compare-table", "aria-labelledby": "compare-totals-heading" },
            h(
                "thead",
                {},
                h(
                    "tr",
                    {},
                    h("th", { scope: "col", text: "Metric" }),
                    h("th", { scope: "col", text: "A" }),
                    h("th", { scope: "col", text: "B" }),
                    h("th", { scope: "col", text: "Δ (B − A)" }),
                    h("th", { scope: "col", text: "Change" }),
                ),
            ),
            h("tbody", {}, ...body),
        ),
    ];
}

function renderRows(c: Comparison): HTMLElement[] {
    const defs = METRICS.filter((m) => ROW_METRICS.includes(m.key));
    const shown = defs.filter((m) => c.rows.some((r) => r.deltas.find((d) => d.key === m.key)!.verdict !== "n/a"));
    const rows = c.rows.slice(0, MAX_ROWS);
    const statusText = { matched: "matched", "only-a": "only in A", "only-b": "only in B" } as const;
    const body = rows.map((r) =>
        h(
            "tr",
            { "data-status": r.status },
            h("th", { scope: "row", class: "mono", text: r.label }),
            h("td", { class: `compare-status status-${r.status}`, text: statusText[r.status] }),
            ...shown.map((m) => {
                const d = r.deltas.find((x) => x.key === m.key)!;
                return h(
                    "td",
                    { class: "num", "data-metric": m.key, "data-verdict": d.verdict },
                    h("div", { text: `${formatValue(d.unit, d.a)} → ${formatValue(d.unit, d.b)}` }),
                    d.verdict === "n/a" ? null : h("div", { class: `compare-delta verdict-${d.verdict}`, text: `${formatDelta(d)} · ${VERDICT_TEXT[d.verdict]}` }),
                );
            }),
        ),
    );
    const out: HTMLElement[] = [
        heading(`Aligned by ${c.mode}`, "compare-rows-heading"),
        h("p", { class: "muted compare-alignment", text: describeAlignment(c.alignment) }),
    ];
    if (c.rows.length === 0) {
        out.push(h("p", { class: "muted", text: `Neither session reports any ${c.mode}s.` }));
        return out;
    }
    out.push(
        h(
            "div",
            { class: "compare-scroll", tabindex: 0, role: "region", "aria-labelledby": "compare-rows-heading" },
            h(
                "table",
                { id: "compare-rows", class: "compare-table", "aria-labelledby": "compare-rows-heading" },
                h(
                    "thead",
                    {},
                    h(
                        "tr",
                        {},
                        h("th", { scope: "col", text: MODE_LABEL[c.mode] }),
                        h("th", { scope: "col", text: "Status" }),
                        ...shown.map((m) => h("th", { scope: "col", text: `${m.label} (A → B)` })),
                    ),
                ),
                h("tbody", {}, ...body),
            ),
        ),
    );
    if (c.rows.length > rows.length) {
        out.push(h("p", { class: "muted", text: `Showing the first ${rows.length} of ${c.rows.length} ${c.mode}s.` }));
    }
    return out;
}

function findingItem(text: string, severity: "info" | "warning" | "critical", extra?: string): HTMLElement {
    return h(
        "li",
        { class: "compare-finding" },
        h("span", { class: `sev-label sev-${severity}`, text: SEVERITY_TEXT[severity] }),
        " ",
        h("span", { text }),
        extra ? h("span", { class: "muted", text: ` ${extra}` }) : null,
    );
}

function list(group: string, title: string, items: HTMLElement[], empty: string): HTMLElement {
    return h(
        "div",
        { class: "compare-group", "data-group": group },
        h("h4", { text: `${title} (${items.length})` }),
        items.length > 0 ? h("ul", { class: "compare-list" }, ...items) : h("p", { class: "muted", text: empty }),
    );
}

function renderFindings(c: Comparison): HTMLElement[] {
    const f = c.findings;
    return [
        heading("Diagnostics findings", "compare-findings-heading"),
        h(
            "div",
            { id: "compare-findings", class: "compare-groups", role: "region", "aria-labelledby": "compare-findings-heading" },
            list("new", "New in B", f.added.map((x) => findingItem(x.summary, x.severity)), "No new findings."),
            list("resolved", "Resolved (only in A)", f.resolved.map((x) => findingItem(x.summary, x.severity)), "No resolved findings."),
            list(
                "persisting",
                "Persisting",
                f.persisting.map((p) =>
                    findingItem(
                        p.b.summary,
                        p.b.severity,
                        p.severityChange ? `(${p.severityChange}: ${SEVERITY_TEXT[p.a.severity]} → ${SEVERITY_TEXT[p.b.severity]})` : undefined,
                    ),
                ),
                "No findings in both sessions.",
            ),
        ),
    ];
}

function renderGraph(c: Comparison): HTMLElement[] {
    const g = c.graph;
    const item = (text: string, id: string) => h("li", { class: "mono", "data-id": id, text });
    return [
        heading("Call graph (agents, models, tools)", "compare-graph-heading"),
        h("p", {
            class: "muted",
            text: `${g.addedNodes.length} node(s) added, ${g.removedNodes.length} removed, ${g.changedNodes.length} changed; ${g.addedEdges.length} edge(s) added, ${g.removedEdges.length} removed, ${g.changedEdges.length} changed; ${g.unchangedNodes} node(s) and ${g.unchangedEdges} edge(s) unchanged.`,
        }),
        h(
            "div",
            { id: "compare-graph", class: "compare-groups", role: "region", "aria-labelledby": "compare-graph-heading" },
            list("added-nodes", "Added nodes", g.addedNodes.map((n) => item(nodeText(n), n.id)), "None."),
            list("removed-nodes", "Removed nodes", g.removedNodes.map((n) => item(nodeText(n), n.id)), "None."),
            list("added-edges", "Added edges", g.addedEdges.map((e) => item(edgeText(e), e.id)), "None."),
            list("removed-edges", "Removed edges", g.removedEdges.map((e) => item(edgeText(e), e.id)), "None."),
            list(
                "changed",
                "Changed",
                [
                    ...g.changedNodes.map((n) => item(`${nodeText(n.b)}: ${n.a.status} → ${n.b.status}`, n.id)),
                    ...g.changedEdges.map((e) => {
                        const parts: string[] = [];
                        if (e.countDelta !== 0) {
                            parts.push(`calls ${e.a.count} → ${e.b.count}`);
                        }
                        if (e.failuresDelta !== 0) {
                            parts.push(`failures ${e.a.failures} → ${e.b.failures}`);
                        }
                        if (e.status) {
                            parts.push(`${e.status.a} → ${e.status.b}`);
                        }
                        return item(`${edgeText(e.b)}: ${parts.join(", ")}`, e.id);
                    }),
                ],
                "None.",
            ),
        ),
    ];
}
