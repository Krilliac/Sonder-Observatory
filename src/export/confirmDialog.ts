/**
 * Modal warning shown before a sensitive export (docs/SECURITY_PRIVACY.md,
 * recording hygiene). A native `<dialog>` opened with showModal(): focus is
 * trapped, Escape cancels, the safe choice ("Cancel") has initial focus, and
 * the heading / list are wired as the accessible name / description.
 * Pass it to exportWithConfirmation() as the `confirm` callback.
 */
import { h } from "../renderer/dom";
import "./confirmDialog.css";
import { sensitiveExportWarning, type ExportSensitivity } from "./sensitivity";

let dialogSeq = 0;

/** Resolves true only if the user explicitly chose "Export anyway". */
export function confirmSensitiveExport(assessment: ExportSensitivity): Promise<boolean> {
    const text = sensitiveExportWarning(assessment);
    const id = `export-warning-${++dialogSeq}`;
    const cancel = h("button", { type: "submit", value: "cancel", autofocus: true, text: text.cancelLabel });
    const confirm = h("button", { type: "submit", value: "confirm", text: text.confirmLabel });
    const dialog = h(
        "dialog",
        { class: "export-warning", "aria-labelledby": `${id}-title`, "aria-describedby": `${id}-desc` },
        h(
            "form",
            { method: "dialog" },
            h("h2", { id: `${id}-title`, text: text.title }),
            h("ul", { id: `${id}-desc` }, ...text.items.map((item) => h("li", { text: item }))),
            h("div", { class: "export-warning-actions" }, cancel, confirm),
        ),
    );
    return new Promise<boolean>((resolve) => {
        dialog.addEventListener(
            "close",
            () => {
                resolve(dialog.returnValue === "confirm");
                dialog.remove();
            },
            { once: true },
        );
        document.body.append(dialog);
        dialog.returnValue = "";
        dialog.showModal();
        cancel.focus();
    });
}
