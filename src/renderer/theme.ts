/**
 * Light/dark theme. The palettes come from design/tokens.json and are
 * injected once as a stylesheet keyed on `<html data-theme>` (main.ts); this
 * module only decides which one applies:
 *
 * 1. `?theme=light|dark` for this page load (never persisted);
 * 2. otherwise the viewer's saved choice from the #theme-toggle button
 *    (localStorage, per viewer, wrapped in try/catch: private windows and
 *    blocked storage just fall through);
 * 3. otherwise `prefers-color-scheme`, followed live while nothing overrides it.
 */
import { THEME_NAMES, type ThemeName } from "../design/tokens";

export type { ThemeName } from "../design/tokens";

export const THEME_STORAGE_KEY = "sonder-observatory.theme";

export function parseTheme(value: string | null | undefined): ThemeName | null {
    return (THEME_NAMES as readonly string[]).includes(value ?? "") ? (value as ThemeName) : null;
}

export interface ThemeInputs {
    /** From the `?theme=` URL parameter. */
    param: ThemeName | null;
    /** The viewer's saved choice. */
    stored: ThemeName | null;
    /** `prefers-color-scheme: dark` matches. */
    prefersDark: boolean;
}

export function resolveTheme(inputs: ThemeInputs): ThemeName {
    return inputs.param ?? inputs.stored ?? (inputs.prefersDark ? "dark" : "light");
}

export function otherTheme(theme: ThemeName): ThemeName {
    return theme === "dark" ? "light" : "dark";
}

/** Storage access that never throws (blocked storage reads as empty). */
export function safeStorage(win: { localStorage?: Storage } | undefined = globalThis as { localStorage?: Storage }): Storage | null {
    try {
        return win?.localStorage ?? null;
    } catch {
        return null;
    }
}

export function readStoredTheme(storage: Storage | null): ThemeName | null {
    try {
        return parseTheme(storage?.getItem(THEME_STORAGE_KEY));
    } catch {
        return null;
    }
}

export function writeStoredTheme(storage: Storage | null, theme: ThemeName): void {
    try {
        storage?.setItem(THEME_STORAGE_KEY, theme);
    } catch {
        // Storage full or blocked: the choice still applies to this page.
    }
}

/** Visible text (the action) and tooltip for the toggle button. */
export function toggleLabel(theme: ThemeName): { text: string; title: string } {
    const next = otherTheme(theme);
    return { text: next === "light" ? "Light theme" : "Dark theme", title: `Switch to the ${next} theme (shortcut T)` };
}

export class ThemeController {
    private theme: ThemeName;
    private readonly listeners = new Set<(theme: ThemeName) => void>();
    private readonly storage: Storage | null;
    private readonly param: ThemeName | null;
    private stored: ThemeName | null;
    private readonly media: MediaQueryList | null;
    private button: HTMLButtonElement | null = null;

    constructor(
        private readonly doc: Document,
        win: Window,
        param: string | null,
    ) {
        this.storage = safeStorage(win);
        this.param = parseTheme(param);
        this.stored = readStoredTheme(this.storage);
        this.media = typeof win.matchMedia === "function" ? win.matchMedia("(prefers-color-scheme: dark)") : null;
        this.theme = resolveTheme({ param: this.param, stored: this.stored, prefersDark: this.media?.matches ?? true });
        this.apply();
        this.media?.addEventListener("change", () => {
            if (this.param === null && this.stored === null) {
                this.set(this.media?.matches ? "dark" : "light", false);
            }
        });
    }

    get current(): ThemeName {
        return this.theme;
    }

    /** Switches theme; a user toggle is saved for this viewer. */
    toggle(): void {
        this.set(otherTheme(this.theme), true);
    }

    set(theme: ThemeName, persist: boolean): void {
        if (persist) {
            this.stored = theme;
            writeStoredTheme(this.storage, theme);
        }
        if (theme === this.theme) {
            return;
        }
        this.theme = theme;
        this.apply();
        for (const listener of this.listeners) {
            listener(theme);
        }
    }

    onChange(listener: (theme: ThemeName) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    bindToggle(button: HTMLButtonElement): void {
        this.button = button;
        button.addEventListener("click", () => this.toggle());
        this.apply();
    }

    private apply(): void {
        this.doc.documentElement.dataset.theme = this.theme;
        if (this.button) {
            const { text, title } = toggleLabel(this.theme);
            this.button.textContent = text;
            this.button.title = title;
            this.button.dataset.theme = this.theme;
        }
    }
}
