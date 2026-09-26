/**
 * Endpoint parsing and transport selection for live ingest.
 *
 * - ws:// / wss://      -> WebSocket
 * - http:// / https://  -> streaming fetch; Server-Sent Events when the
 *   response is text/event-stream, NDJSON lines otherwise (fallback).
 *
 * The expected HTTP flavour is only a hint (it sets the Accept header); the
 * response Content-Type decides how the body is parsed.
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
    const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
    const warning = loopback
        ? undefined
        : "remote endpoint: telemetry may be sensitive; use wss:// or https:// and an authenticated producer";
    const isWs = parsed.protocol === "ws:" || parsed.protocol === "wss:";
    const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
    if (!isWs && !isHttp) {
        return { ok: false, url, kind: null, loopback, message: "must use ws://, wss://, http:// or https://" };
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
