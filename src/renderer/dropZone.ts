/**
 * Window-wide drop target for recordings (.sobs, .ndjson, .jsonl, .json).
 * Dragging files over the window shows #drop-overlay; dropping one loads it
 * through the same path as "Open recording…" (the keyboard equivalent).
 * Other files and multiple files are refused with a message.
 */
import { RECORDING_EXTENSION } from "../recording/sobs";
import { h } from "./dom";

export const RECORDING_FILE_EXTENSIONS: readonly string[] = [RECORDING_EXTENSION, ".ndjson", ".jsonl", ".json"];

/** Why a dropped file cannot be opened as a recording, or null if it can. */
export function recordingFileProblem(name: string): string | null {
    const lower = name.toLowerCase();
    if (RECORDING_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
        return null;
    }
    return `${name} is not a recording; drop a ${RECORDING_FILE_EXTENSIONS.join(", ")} file`;
}

/** Whether a drag carries files (not text or links). */
export function dragHasFiles(types: readonly string[] | DOMStringList | null | undefined): boolean {
    if (!types) {
        return false;
    }
    for (let i = 0; i < types.length; i += 1) {
        const t = "item" in types ? (types as DOMStringList).item(i) : (types as readonly string[])[i];
        if (t === "Files") {
            return true;
        }
    }
    return false;
}

export interface DropZoneCallbacks {
    onFile(file: File): void;
    onReject(message: string): void;
}

/** Installs the handlers on `win` and returns a function that removes them. */
export function mountDropZone(win: Window, doc: Document, callbacks: DropZoneCallbacks): () => void {
    const overlay = h(
        "div",
        { id: "drop-overlay", class: "drop-overlay", hidden: true, "aria-hidden": "true" },
        h("div", { class: "drop-card", text: `Drop a recording (${RECORDING_FILE_EXTENSIONS.join(", ")}) to open it` }),
    );
    doc.body.append(overlay);
    let depth = 0;
    const show = (visible: boolean) => {
        overlay.hidden = !visible;
    };
    const onEnter = (ev: DragEvent) => {
        if (!dragHasFiles(ev.dataTransfer?.types)) {
            return;
        }
        ev.preventDefault();
        depth += 1;
        show(true);
    };
    const onOver = (ev: DragEvent) => {
        if (!dragHasFiles(ev.dataTransfer?.types)) {
            return;
        }
        ev.preventDefault();
        if (ev.dataTransfer) {
            ev.dataTransfer.dropEffect = "copy";
        }
    };
    const onLeave = (ev: DragEvent) => {
        if (!dragHasFiles(ev.dataTransfer?.types)) {
            return;
        }
        depth = Math.max(0, depth - 1);
        if (depth === 0) {
            show(false);
        }
    };
    const onDrop = (ev: DragEvent) => {
        if (!dragHasFiles(ev.dataTransfer?.types)) {
            return;
        }
        ev.preventDefault();
        depth = 0;
        show(false);
        const files = [...(ev.dataTransfer?.files ?? [])];
        if (files.length !== 1) {
            callbacks.onReject(files.length === 0 ? "nothing to open in that drop" : "drop one recording at a time");
            return;
        }
        const file = files[0]!;
        const problem = recordingFileProblem(file.name);
        if (problem) {
            callbacks.onReject(problem);
            return;
        }
        callbacks.onFile(file);
    };
    win.addEventListener("dragenter", onEnter);
    win.addEventListener("dragover", onOver);
    win.addEventListener("dragleave", onLeave);
    win.addEventListener("drop", onDrop);
    return () => {
        win.removeEventListener("dragenter", onEnter);
        win.removeEventListener("dragover", onOver);
        win.removeEventListener("dragleave", onLeave);
        win.removeEventListener("drop", onDrop);
        overlay.remove();
    };
}
