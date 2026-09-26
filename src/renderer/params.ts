/**
 * Renderer URL parameters (contract section 8.2):
 *
 * - `?connect=<url>` (repeatable) adds a live producer; `?ws=<url>` is the
 *   legacy alias and is added after the connect URLs;
 * - `?fixture=0` starts without the synthetic fixture;
 * - `?view=overview|events|diagnostics|agents` picks the tab;
 * - `?theme=light|dark` overrides the theme for this load.
 *
 * Tokens never travel in URLs: `token` and `access_token` parameters are
 * ignored, reported as a visible warning, and stripped from the address bar.
 */
import { SECRET_QUERY_PARAMS } from "../ingest/live/endpoint";
import { parseTheme, type ThemeName } from "./theme";

export interface LaunchParams {
    connect: string[];
    fixture: boolean;
    view: string | null;
    theme: ThemeName | null;
    /** Secret-looking parameters that were present and ignored. */
    ignoredSecrets: string[];
}

export function parseLaunchParams(params: URLSearchParams): LaunchParams {
    const connect = [...params.getAll("connect"), ...params.getAll("ws")].map((u) => u.trim()).filter((u) => u !== "");
    const ignoredSecrets = SECRET_QUERY_PARAMS.filter((name) => params.has(name));
    return {
        connect: [...new Set(connect)],
        fixture: params.get("fixture") !== "0" && connect.length === 0,
        view: params.get("view"),
        theme: parseTheme(params.get("theme")),
        ignoredSecrets,
    };
}

/** Warning text for ignored token parameters, or null. */
export function secretParamWarning(ignored: readonly string[]): string | null {
    if (ignored.length === 0) {
        return null;
    }
    const names = ignored.map((n) => `"${n}"`).join(" and ");
    return `Ignored the ${names} URL parameter: tokens are never read from URLs. Enter the token in Sources > Bearer token instead.`;
}

/**
 * The page URL without token parameters, or null when nothing needs
 * removing. The value is never returned or logged.
 */
export function urlWithoutSecrets(href: string): string | null {
    let url: URL;
    try {
        url = new URL(href);
    } catch {
        return null;
    }
    let changed = false;
    for (const name of SECRET_QUERY_PARAMS) {
        if (url.searchParams.has(name)) {
            url.searchParams.delete(name);
            changed = true;
        }
    }
    return changed ? url.toString() : null;
}
