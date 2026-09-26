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
 * The same applies inside a `connect`/`ws` value: credentials
 * (`user:pass@`) and token parameters of the producer URL are removed before
 * the URL is connected, shown or put back in the address bar.
 */
import { SECRET_QUERY_PARAMS } from "../ingest/live/endpoint";
import { parseTheme, type ThemeName } from "./theme";

export interface LaunchParams {
    /** Producer URLs to connect, with any credentials or token parameters removed. */
    connect: string[];
    fixture: boolean;
    view: string | null;
    theme: ThemeName | null;
    /** Secret-looking parameters that were present and ignored. */
    ignoredSecrets: string[];
    /** True when a connect/ws value carried credentials or token parameters (removed). */
    ignoredConnectSecrets: boolean;
}

const SECRET_NAMES: readonly string[] = SECRET_QUERY_PARAMS;
/** Fallback for values that do not parse as URLs. */
const SECRET_PARAM_TEXT = new RegExp(`([?&;])(?:${SECRET_QUERY_PARAMS.join("|")})=[^&#]*`, "gi");
const USERINFO_TEXT = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i;

/**
 * `url` without userinfo (`user:pass@`) and without token/access_token query
 * parameters (any case), for display, storage-free echoes and the address
 * bar. Everything else is kept as written. Never logs the value.
 */
export function redactUrlSecrets(url: string): string {
    let parsed: URL | null;
    try {
        parsed = new URL(url);
    } catch {
        parsed = null;
    }
    if (!parsed) {
        return url.replace(USERINFO_TEXT, "$1").replace(SECRET_PARAM_TEXT, "$1").replace(/([?&;])[&;]+/g, "$1").replace(/[?&;]+(#|$)/, "$1");
    }
    let changed = false;
    if (parsed.username !== "" || parsed.password !== "") {
        parsed.username = "";
        parsed.password = "";
        changed = true;
    }
    for (const name of [...parsed.searchParams.keys()]) {
        if (SECRET_NAMES.includes(name.toLowerCase())) {
            parsed.searchParams.delete(name);
            changed = true;
        }
    }
    return changed ? parsed.toString() : url;
}

export function parseLaunchParams(params: URLSearchParams): LaunchParams {
    const raw = [...params.getAll("connect"), ...params.getAll("ws")].map((u) => u.trim()).filter((u) => u !== "");
    const connect = raw.map(redactUrlSecrets);
    const ignoredSecrets = SECRET_QUERY_PARAMS.filter((name) => params.has(name));
    return {
        connect: [...new Set(connect)],
        fixture: params.get("fixture") !== "0" && connect.length === 0,
        view: params.get("view"),
        theme: parseTheme(params.get("theme")),
        ignoredSecrets,
        ignoredConnectSecrets: connect.some((u, i) => u !== raw[i]),
    };
}

/** Warning text for ignored token parameters (top level and inside connect URLs), or null. */
export function secretParamWarning(ignored: readonly string[], inConnectUrl = false): string | null {
    const parts: string[] = [];
    if (ignored.length > 0) {
        parts.push(`the ${ignored.map((n) => `"${n}"`).join(" and ")} URL parameter`);
    }
    if (inConnectUrl) {
        parts.push("the credentials or token parameters inside a connect URL");
    }
    if (parts.length === 0) {
        return null;
    }
    return `Ignored ${parts.join(" and ")}: tokens are never read from URLs. Enter the token in Sources > Bearer token instead.`;
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
    // connect/ws values are producer URLs: rewrite the ones that carry secrets, keeping order.
    for (const key of ["connect", "ws"]) {
        const values = url.searchParams.getAll(key);
        const cleaned = values.map(redactUrlSecrets);
        if (cleaned.some((v, i) => v !== values[i])) {
            const entries = [...url.searchParams.entries()];
            url.search = "";
            for (const [k, v] of entries) {
                url.searchParams.append(k, k === key ? redactUrlSecrets(v) : v);
            }
            changed = true;
        }
    }
    return changed ? url.toString() : null;
}
