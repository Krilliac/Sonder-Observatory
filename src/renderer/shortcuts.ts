/**
 * Global keyboard shortcuts and the "?" help dialog (#shortcuts-dialog).
 *
 * `shortcutAction` is pure: it maps a key event to an action or null. It
 * returns null while the user types (inputs, textareas, selects, editable
 * content), when Ctrl/Meta/Alt is held (browser and OS shortcuts win), and
 * for Space on controls that Space already activates (buttons, checkboxes,
 * tabs, links), so native activation never runs twice.
 */
import { h } from "./dom";

export type ShortcutAction =
    | "help"
    | "play-pause"
    | "next-event"
    | "previous-event"
    | "next-error"
    | "previous-error"
    | "focus-filter"
    | "follow-latest"
    | "toggle-theme";

export interface ShortcutSpec {
    action: ShortcutAction;
    /** Keys as shown in the dialog. */
    keys: string[];
    description: string;
}

export const SHORTCUTS: readonly ShortcutSpec[] = [
    { action: "play-pause", keys: ["Space"], description: "Play or pause the replay" },
    { action: "next-event", keys: ["J"], description: "Select the next event" },
    { action: "previous-event", keys: ["K"], description: "Select the previous event" },
    { action: "next-error", keys: ["]"], description: "Jump to the next error" },
    { action: "previous-error", keys: ["["], description: "Jump to the previous error" },
    { action: "focus-filter", keys: ["/"], description: "Focus the event filter" },
    { action: "follow-latest", keys: ["F"], description: "Follow the latest event" },
    { action: "toggle-theme", keys: ["T"], description: "Switch between light and dark theme" },
    { action: "help", keys: ["?"], description: "Show this list of shortcuts" },
];

/** The parts of a KeyboardEvent the mapping looks at. */
export interface KeyLike {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    target?: unknown;
}

/** The parts of an element the mapping looks at. */
export interface TargetLike {
    tagName?: string;
    isContentEditable?: boolean;
    getAttribute?(name: string): string | null;
    type?: string;
}

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "url", "email", "password", "number", "tel", "date", "time", "datetime-local", "month", "week"]);

/** True when keys typed at `target` are text input (shortcuts stay off). */
export function isTypingTarget(target: unknown): boolean {
    const t = target as TargetLike | null | undefined;
    if (!t || typeof t !== "object") {
        return false;
    }
    if (t.isContentEditable) {
        return true;
    }
    const tag = (t.tagName ?? "").toUpperCase();
    if (tag === "TEXTAREA" || tag === "SELECT") {
        return true;
    }
    if (tag === "INPUT") {
        return TEXT_INPUT_TYPES.has((t.type ?? "").toLowerCase());
    }
    return false;
}

/** Controls that Space activates natively, or that use Space themselves. */
function spaceIsNative(target: unknown): boolean {
    const t = target as TargetLike | null | undefined;
    if (!t || typeof t !== "object") {
        return false;
    }
    const tag = (t.tagName ?? "").toUpperCase();
    if (tag === "BUTTON" || tag === "INPUT" || tag === "A" || tag === "SUMMARY") {
        return true;
    }
    const role = t.getAttribute?.("role") ?? null;
    return role !== null && ["button", "tab", "checkbox", "switch", "menuitem", "option", "link", "separator", "slider"].includes(role);
}

export function shortcutAction(ev: KeyLike): ShortcutAction | null {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || isTypingTarget(ev.target)) {
        return null;
    }
    switch (ev.key) {
        case "?":
            return "help";
        case " ":
        case "Spacebar":
            return spaceIsNative(ev.target) ? null : "play-pause";
        case "j":
        case "J":
            return "next-event";
        case "k":
        case "K":
            return "previous-event";
        case "]":
            return "next-error";
        case "[":
            return "previous-error";
        case "/":
            return "focus-filter";
        case "f":
        case "F":
            return "follow-latest";
        case "t":
        case "T":
            return "toggle-theme";
        default:
            return null;
    }
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal help dialog. Opens with "?", traps Tab/Shift+Tab inside itself,
 * closes with Esc or the Close button and returns focus to where it was.
 */
export class ShortcutsDialog {
    readonly element: HTMLDialogElement;
    private returnFocus: HTMLElement | null = null;

    constructor(doc: Document = document) {
        const close = h("button", { type: "button", class: "dialog-close", text: "Close" });
        close.addEventListener("click", () => this.close());
        const rows = SHORTCUTS.map((s) =>
            h("tr", {}, h("th", { scope: "row" }, ...s.keys.map((k) => h("kbd", { text: k }))), h("td", { text: s.description })),
        );
        this.element = h(
            "dialog",
            { id: "shortcuts-dialog", class: "dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "shortcuts-title", "aria-describedby": "shortcuts-note" },
            h("div", { class: "dialog-head" }, h("h2", { id: "shortcuts-title", text: "Keyboard shortcuts" }), close),
            h("p", { id: "shortcuts-note", class: "muted", text: "Shortcuts are off while you type in a text field. Esc closes this dialog." }),
            h("table", { class: "shortcut-table" }, h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Key" }), h("th", { scope: "col", text: "Action" }))), h("tbody", {}, ...rows)),
        );
        this.element.addEventListener("keydown", (ev) => this.onKey(ev));
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

    open(): void {
        if (this.element.open) {
            return;
        }
        const active = this.element.ownerDocument.activeElement;
        this.returnFocus = active instanceof HTMLElement ? active : null;
        this.element.showModal();
        this.focusables()[0]?.focus();
    }

    close(): void {
        if (!this.element.open) {
            return;
        }
        this.element.close();
        this.returnFocus?.focus();
        this.returnFocus = null;
    }

    private focusables(): HTMLElement[] {
        return [...this.element.querySelectorAll<HTMLElement>(FOCUSABLE)];
    }

    private onKey(ev: KeyboardEvent): void {
        if (ev.key === "Escape") {
            ev.preventDefault();
            ev.stopPropagation();
            this.close();
            return;
        }
        if (ev.key !== "Tab") {
            return;
        }
        const items = this.focusables();
        if (items.length === 0) {
            ev.preventDefault();
            return;
        }
        const first = items[0]!;
        const last = items[items.length - 1]!;
        const active = this.element.ownerDocument.activeElement;
        if (ev.shiftKey && (active === first || !this.element.contains(active))) {
            ev.preventDefault();
            last.focus();
        } else if (!ev.shiftKey && (active === last || !this.element.contains(active))) {
            ev.preventDefault();
            first.focus();
        }
    }
}
