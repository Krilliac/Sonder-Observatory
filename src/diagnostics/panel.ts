/**
 * Findings list UI (plain DOM, no framework); state lives in
 * FindingsController. Severity is shown as text and a class (never colour
 * alone); every row is a focusable button in a plain list (the selected one
 * carries aria-current and aria-expanded for its evidence list);
 * ArrowUp/ArrowDown move the selection and Escape clears it.
 */
import type { FindingsController } from "./controller";
import type { Finding, Severity } from "./types";

type Child = Node | null;

/** Minimal element helper (kept local so diagnostics does not depend on renderer internals). */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key === "class") {
            el.className = value;
        } else if (key === "text") {
            el.textContent = value;
        } else {
            el.setAttribute(key, value);
        }
    }
    for (const child of children) {
        if (child) {
            el.append(child);
        }
    }
    return el;
}

const SEVERITY_LABEL: Record<Severity, string> = { info: "INFO", warning: "WARN", critical: "CRIT" };

export interface FindingsPanelOptions {
    /** Formats a finding's start time relative to the session (lead's formatter). */
    relativeTime(ns: number): string;
    /** Called after any state change so the host can re-render. */
    onChange(): void;
    /** True when the loaded session is synthetic (labelled per AGENTS.md). */
    synthetic?: boolean;
}

function evidenceId(f: Finding): string {
    return `diag-evidence-${f.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function evidenceList(f: Finding, controller: FindingsController, opts: FindingsPanelOptions): HTMLElement {
    return h(
        "ul",
        { class: "diag-evidence", id: evidenceId(f), "aria-label": `Evidence for ${f.kind}` },
        ...f.evidenceEventIds.map((id) => {
            const btn = h("button", { type: "button", class: "link mono", text: id });
            btn.addEventListener("click", () => {
                controller.inspectEvidence(id);
                opts.onChange();
            });
            return h("li", {}, btn);
        }),
    );
}

export function renderFindingsPanel(controller: FindingsController, opts: FindingsPanelOptions): Node[] {
    const counts = controller.counts();
    const visible = controller.visible();
    const selected = controller.selected();
    const head = h(
        "div",
        { class: "panel-head" },
        h("h2", { text: "Diagnostics" }),
        h("span", { class: "muted", text: `${counts.critical} critical · ${counts.warning} warning · ${counts.info} info` }),
    );
    const note = h("p", {
        class: `provenance${opts.synthetic ? " synthetic" : ""}`,
        text: `${opts.synthetic ? "Synthetic session. " : ""}Findings are derived from the events listed as evidence; select one to highlight them.`,
    });
    if (visible.length === 0) {
        return [head, note, h("p", { class: "muted", text: "No findings at the current thresholds." })];
    }
    // A plain list of buttons: a listbox may only own options, and options may
    // not contain the interactive evidence list shown under the selection.
    const list = h("ul", { class: "diag-findings", "aria-label": "Diagnostic findings" });
    for (const f of visible) {
        const isSel = selected?.id === f.id;
        const attrs: Record<string, string> = {
            type: "button",
            class: `diag-finding sev-${f.severity}${isSel ? " selected" : ""}`,
            "aria-expanded": isSel ? "true" : "false",
        };
        if (isSel) {
            attrs["aria-current"] = "true";
            attrs["aria-controls"] = evidenceId(f);
        }
        const btn = h(
            "button",
            attrs,
            h("span", { class: `sev-label sev-${f.severity}`, text: SEVERITY_LABEL[f.severity] }),
            h("span", { class: "mono", text: ` ${opts.relativeTime(f.startNs)} ` }),
            h("span", { class: "diag-kind", text: f.kind }),
            h("span", { class: "diag-summary", text: ` ${f.summary}` }),
            h("span", { class: "muted", text: ` (${f.evidenceEventIds.length} evidence event${f.evidenceEventIds.length === 1 ? "" : "s"}, ${f.provenance})` }),
        );
        btn.addEventListener("click", () => {
            controller.select(f.id);
            opts.onChange();
        });
        btn.addEventListener("keydown", (ev) => {
            if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
                ev.preventDefault();
                controller.move(ev.key === "ArrowDown" ? 1 : -1);
                opts.onChange();
            } else if (ev.key === "Escape") {
                controller.clear();
                opts.onChange();
            }
        });
        list.append(h("li", {}, btn, isSel ? evidenceList(f, controller, opts) : null));
    }
    return [head, note, list];
}
