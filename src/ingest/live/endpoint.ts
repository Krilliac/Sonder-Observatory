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
export const SECRET_QUERY_PARAMS = ["token", "access_token"] as const;

/** True for localhost, [::1] and any 127.0.0.0/8 address. */
export function isLoopbackHost(hostname: string): boolean {
    return LOOPBACK_HOSTS.has(hostname) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Security policy shared by every live URL (stream, discovery or base URL):
 * no credentials in the URL, no token/access_token query parameters, and
 * plain http:// or ws:// only to a loopback host. Returns the refusal
 * message, or null when the URL is acceptable.
 */
export function endpointPolicyViolation(parsed: URL): string | null {
    if (parsed.username !== "" || parsed.password !== "") {
        return "credentials in the URL are not allowed; pass a bearer token separately";
    }
    for (const name of parsed.searchParams.keys()) {
        if ((SECRET_QUERY_PARAMS as readonly string[]).includes(name.toLowerCase())) {
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
