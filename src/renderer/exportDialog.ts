/**
 * "Export…" dialog (#export-dialog): pick a format (HTML report, Markdown
 * summary, findings/metrics JSON, .sobs range) and a range (whole session or
 * the current view), then Export. The dialog only collects the choice; the
 * host runs it through exportWithConfirmation() (src/export), so the
 * sensitive-data warning is never skipped.
 *
 * Native modal <dialog>: focus moves to the first format, Esc or Cancel
 * closes it, and focus returns to the control that opened it.
 */
import { EXPORT_FORMAT_IDS, EXPORT_FORMATS, type ExportFormat } from "../export/save";
import { h } from "./dom";

export type ExportScope = "session" | "view";

export interface ExportChoice {
    format: ExportFormat;
    scope: ExportScope;
}

export interface ExportDialogOptions {
    onExport: (choice: ExportChoice) => void;
}

const FORMAT_HELP: Record<ExportFormat, string> = {
    html: "one self-contained file: metrics, findings with evidence, call graph and timeline",
    markdown: "summary to paste into an issue or pull request",
    json: "derived metrics and findings",
    sobs: "the selected events as a recording that Observatory can open",
};

export class ExportDialog {
    readonly element: HTMLDialogElement;
    private readonly formatInputs: HTMLInputElement[];
    private readonly scopeInputs: HTMLInputElement[];
    private readonly viewHint: HTMLElement;
    private returnFocus: HTMLElement | null = null;

    constructor(doc: Document, private readonly options: ExportDialogOptions) {
        this.formatInputs = EXPORT_FORMAT_IDS.map((id, i) =>
            h("input", { id: `export-format-${id}`, type: "radio", name: "export-format", value: id, checked: i === 0, "aria-describedby": `export-format-${id}-help` }),
        );
        this.scopeInputs = (["session", "view"] as const).map((id, i) =>
            h("input", { id: `export-scope-${id}`, type: "radio", name: "export-scope", value: id, checked: i === 0 }),
        );
        this.viewHint = h("span", { id: "export-scope-view-help", class: "hint" });
        this.scopeInputs[1]!.setAttribute("aria-describedby", "export-scope-view-help");
        const cancel = h("button", { type: "button", id: "export-cancel", text: "Cancel" });
        cancel.addEventListener("click", () => this.close());
        const submit = h("button", { type: "submit", id: "export-submit", class: "primary", text: "Export" });
        const form = h(
            "form",
            { method: "dialog", class: "export-form" },
            h(
                "fieldset",
                { class: "export-fieldset" },
                h("legend", { text: "Format" }),
                ...EXPORT_FORMAT_IDS.map((id, i) =>
                    h(
                        "div",
                        { class: "export-option" },
                        h("label", { class: "check", for: `export-format-${id}` }, this.formatInputs[i]!, ` ${EXPORT_FORMATS[id].label}`),
                        h("span", { id: `export-format-${id}-help`, class: "hint", text: FORMAT_HELP[id] }),
                    ),
                ),
            ),
            h(
                "fieldset",
                { class: "export-fieldset" },
                h("legend", { text: "Range" }),
                h("div", { class: "export-option" }, h("label", { class: "check", for: "export-scope-session" }, this.scopeInputs[0]!, " Whole session")),
                h("div", { class: "export-option" }, h("label", { class: "check", for: "export-scope-view" }, this.scopeInputs[1]!, " Current view"), this.viewHint),
            ),
            h("div", { class: "dialog-actions" }, cancel, submit),
        );
        form.addEventListener("submit", (ev) => {
            ev.preventDefault();
            const choice = this.choice();
            this.close();
            this.options.onExport(choice);
        });
        this.element = h(
            "dialog",
            { id: "export-dialog", class: "dialog", "aria-labelledby": "export-title", "aria-describedby": "export-note" },
            h("div", { class: "dialog-head" }, h("h2", { id: "export-title", text: "Export" })),
            h("p", {
                id: "export-note",
                class: "muted",
                text: "Files are written only where you choose. A session with full text capture or tool payloads asks for confirmation first.",
            }),
            form,
        );
        // Esc on a modal <dialog> fires "cancel": close through our path so focus returns.
        this.element.addEventListener("cancel", (ev) => {
            ev.preventDefault();
            this.close();
        });
        doc.body.append(this.element);
    }

    get isOpen(): boolean {
        return this.element.open;
    }

    /** Opens the dialog; `viewDescription` explains what "Current view" covers right now. */
    open(viewDescription: string): void {
        if (this.element.open) {
            return;
        }
        this.viewHint.textContent = viewDescription;
        const active = this.element.ownerDocument.activeElement;
        this.returnFocus = active instanceof HTMLElement ? active : null;
        this.element.showModal();
        (this.formatInputs.find((i) => i.checked) ?? this.formatInputs[0])?.focus();
    }

    close(): void {
        if (!this.element.open) {
            return;
        }
        this.element.close();
        this.returnFocus?.focus();
        this.returnFocus = null;
    }

    choice(): ExportChoice {
        const format = (this.formatInputs.find((i) => i.checked)?.value ?? "html") as ExportFormat;
        const scope = (this.scopeInputs.find((i) => i.checked)?.value ?? "session") as ExportScope;
        return { format, scope };
    }
}
