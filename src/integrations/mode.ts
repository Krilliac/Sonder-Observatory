/**
 * Runtime mode shown in the header: "desktop" inside the Tauri shell,
 * "browser" in a plain browser or an embedding WebView. Pure so it can be
 * unit-tested without a DOM; main.ts passes in `isDesktop()`.
 */
export type RuntimeMode = "desktop" | "browser";

export function runtimeMode(desktop: boolean): RuntimeMode {
    return desktop ? "desktop" : "browser";
}

export interface ModeBadge {
    text: string;
    title: string;
}

export function modeBadge(mode: RuntimeMode): ModeBadge {
    return mode === "desktop"
        ? { text: "desktop", title: "Running in the Sonder Observatory desktop shell (Tauri)" }
        : { text: "browser", title: "Running in a web browser; desktop-only features (native file picker) are unavailable" };
}
