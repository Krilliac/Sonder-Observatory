/**
 * Endpoint parsing and transport selection for live ingest.
 *
 * - ws:// / wss://      -> WebSocket
 * - http:// / https://  -> streaming fetch; Server-Sent Events when the
 *   response is text/event-stream, NDJSON lines otherwise (fallback).
 *
 * The expected HTTP flavour is only a hint (it sets the Accept header); the
 * response Content-Type decides how the body is parsed.
 *
 * Every URL also passes endpointPolicyViolation(): credentials in the URL,
 * token/access_token query parameters and plain http:// or ws:// to a
 * non-loopback host are refused (docs/SECURITY_PRIVACY.md).
 */
export type TransportKind = "websocket" | "sse" | "ndjson";
export type TransportPreference = "auto" | TransportKind;

export interface LiveEndpoint {
    ok: boolean;
    url: string;
    /** Transport chosen from the URL scheme (and preference). */
    kind: TransportKind | null;
    loopback: boolean;
    message?: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Query parameters that would carry a secret in a URL; always refused. */
export const SECRET_QUERY_PARAMS = ["token", "access_token", "api_key"] as const;

const SECRET_QUERY_PARAM_SET = new Set<string>(SECRET_QUERY_PARAMS);

/**
 * Explicit loopback ports allowed to auto-connect from `?connect=` / `?ws=`
 * query parameters without an interactive confirmation prompt.
 *
 * - 5174, 5175: local loopback telemetry bridges (Runtime, Node1 Inference)
 * - 8765, 8766: local fake/dev telemetry producers
 * - 11435, 11437, 11441: local Sonder Runtime, Sonder-Inference, and Observatory live ports
 * - 18435, 18437: ecosystem E2E local Runtime / Inference ports
 *
 * Any other loopback port or any non-loopback host supplied via query
 * parameters requires explicit user confirmation before any request is sent.
 */
export const AUTO_CONNECT_LOOPBACK_PORTS: ReadonlySet<number> = new Set([
    5174,
    5175,
    8765,
    8766,
    11435,
    11437,
    11441,
    18435,
    18437,
]);

/** True for localhost, [::1] and any 127.0.0.0/8 address. */
export function isLoopbackHost(hostname: string): boolean {
    const lower = hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(lower) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower);
}

function decodeQueryKey(rawKey: string): string {
    const normalized = rawKey.replace(/\+/g, " ");
    try {
        return decodeURIComponent(normalized);
    } catch {
        return normalized;
    }
}

interface RawQueryPart {
    separator: string;
    segment: string;
    key: string;
    lowerKey: string;
    isSecret: boolean;
}

/**
 * Splits a raw query string (with or without leading `?`) treating BOTH `&`
 * and `;` as parameter separators, before `URL.searchParams` parsing. This
 * prevents semicolon-delimited secrets (`?foo=1;token=...`, `?a=1;api_key=...`)
 * from hiding inside another parameter's value.
 */
function parseRawQueryParts(rawSearch: string): RawQueryPart[] {
    const body = rawSearch.startsWith("?") ? rawSearch.slice(1) : rawSearch;
    if (body === "") {
        return [];
    }
    const parts: RawQueryPart[] = [];
    let separator = "";
    let start = 0;
    for (let i = 0; i <= body.length; i += 1) {
        const ch = i < body.length ? (body[i] ?? "") : "";
        if (i < body.length && ch !== "&" && ch !== ";") {
            continue;
        }
        const segment = body.slice(start, i);
        const eq = segment.indexOf("=");
        const rawKey = eq >= 0 ? segment.slice(0, eq) : segment;
        const key = decodeQueryKey(rawKey).trim();
        const lowerKey = key.toLowerCase();
        parts.push({
            separator,
            segment,
            key,
            lowerKey,
            isSecret: SECRET_QUERY_PARAM_SET.has(lowerKey),
        });
        separator = ch;
        start = i + 1;
    }
    return parts;
}

/**
 * Scans a raw query string (with or without leading `?`) for secret parameter
 * names using BOTH `&` and `;` as separators. Returns matched raw/canonical
 * parameter names in encounter order (deduplicated case-insensitively).
 */
export function findSecretQueryParams(rawSearch: string): string[] {
    const found: string[] = [];
    const seen = new Set<string>();
    for (const part of parseRawQueryParts(rawSearch)) {
        if (part.isSecret && !seen.has(part.lowerKey)) {
            seen.add(part.lowerKey);
            found.push(part.key);
        }
    }
    return found;
}

/**
 * Removes every secret parameter from a raw query string (with or without
 * leading `?`), treating BOTH `&` and `;` as separators. Returns `changed`
 * plus the cleaned query string (including leading `?` when non-empty).
 */
export function stripSecretQueryParams(rawSearch: string): { search: string; changed: boolean } {
    const parts = parseRawQueryParts(rawSearch);
    let changed = false;
    const kept: RawQueryPart[] = [];
    for (const part of parts) {
        if (part.isSecret) {
            changed = true;
            continue;
        }
        kept.push(part);
    }
    if (!changed) {
        return { search: rawSearch, changed: false };
    }
    let out = "";
    for (let i = 0; i < kept.length; i += 1) {
        const part = kept[i]!;
        out += i === 0 ? part.segment : `${part.separator}${part.segment}`;
    }
    return { search: out === "" ? "" : `?${out}`, changed: true };
}

/**
 * True only when `url` is a policy-valid http(s)/ws(s) endpoint targeting a
 * canonical loopback host on an explicitly allowlisted local Sonder port.
 * Query-supplied endpoints outside this allowlist require explicit user
 * confirmation before initiating any network connection.
 */
export function isAutoConnectAllowedUrl(url: string): boolean {
    const resolved = resolveEndpoint(url);
    if (!resolved.ok || !resolved.loopback) {
        return false;
    }
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) || parsed.port === "") {
        return false;
    }
    const port = Number(parsed.port);
    return Number.isInteger(port) && AUTO_CONNECT_LOOPBACK_PORTS.has(port);
}

/**
 * Security policy shared by every live URL (stream, discovery or base URL):
 * no credentials in the URL, no token/access_token/api_key query parameters
 * (delimited by either `&` or `;`), and plain http:// or ws:// only to a
 * loopback host. Returns the refusal message, or null when the URL is acceptable.
 */
export function endpointPolicyViolation(parsed: URL): string | null {
    if (parsed.username !== "" || parsed.password !== "") {
        return "credentials in the URL are not allowed; pass a bearer token separately";
    }
    const rawSecrets = findSecretQueryParams(parsed.search);
    if (rawSecrets.length > 0) {
        return `the "${rawSecrets[0]}" query parameter is not allowed: tokens never go in URLs; pass a bearer token separately`;
    }
    for (const name of parsed.searchParams.keys()) {
        if (SECRET_QUERY_PARAM_SET.has(name.toLowerCase())) {
            return `the "${name}" query parameter is not allowed: tokens never go in URLs; pass a bearer token separately`;
        }
    }
    const plain = parsed.protocol === "http:" || parsed.protocol === "ws:";
    if (plain && !isLoopbackHost(parsed.hostname)) {
        const secure = parsed.protocol === "http:" ? "https://" : "wss://";
        return `plain ${parsed.protocol}// is only allowed to a loopback host; use ${secure} for ${parsed.hostname}`;
    }
    return null;
}

function httpHint(parsed: URL): TransportKind {
    const path = parsed.pathname.toLowerCase();
    const format = parsed.searchParams.get("format")?.toLowerCase();
    if (format === "ndjson" || format === "jsonl" || /(\.|\/)(ndjson|jsonl)$/.test(path)) {
        return "ndjson";
    }
    return "sse";
}

export function resolveEndpoint(url: string, preference: TransportPreference = "auto"): LiveEndpoint {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return { ok: false, url, kind: null, loopback: false, message: "not a valid URL" };
    }
    const loopback = isLoopbackHost(parsed.hostname);
    const warning = loopback
        ? undefined
        : "remote endpoint: telemetry may be sensitive; use an authenticated producer";
    const isWs = parsed.protocol === "ws:" || parsed.protocol === "wss:";
    const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
    if (!isWs && !isHttp) {
        return { ok: false, url, kind: null, loopback, message: "must use ws://, wss://, http:// or https://" };
    }
    const violation = endpointPolicyViolation(parsed);
    if (violation !== null) {
        return { ok: false, url, kind: null, loopback, message: violation };
    }
    if (isWs) {
        if (preference !== "auto" && preference !== "websocket") {
            return { ok: false, url, kind: null, loopback, message: `${preference} needs an http(s):// URL` };
        }
        return { ok: true, url, kind: "websocket", loopback, message: warning };
    }
    if (preference === "websocket") {
        return { ok: false, url, kind: null, loopback, message: "websocket needs a ws(s):// URL" };
    }
    const kind = preference === "auto" ? httpHint(parsed) : preference;
    return { ok: true, url, kind, loopback, message: warning };
}

/** Adds (or replaces) a resume query parameter on a URL. */
export function withQueryParam(url: string, name: string, value: string): string {
    const parsed = new URL(url);
    parsed.searchParams.set(name, value);
    return parsed.toString();
}
