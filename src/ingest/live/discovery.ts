/**
 * Producer URL classification and discovery for live ingest
 * (live producer protocol v1, docs/TELEMETRY_PROTOCOL.md).
 *
 * - An http(s) URL with an empty path or "/" is a base URL: the discovery
 *   document is fetched from /.well-known/sonder-telemetry on it.
 * - A URL ending in /.well-known/sonder-telemetry is a discovery URL.
 * - Anything else (including every ws(s) URL) is a stream URL.
 */
import {
    WELL_KNOWN_DISCOVERY_PATH,
    parseDiscovery,
    type ProducerDiscovery,
    type StreamTransport,
} from "../../protocol/discovery";
import { formatIssues } from "../../protocol/validate";
import { endpointPolicyViolation, type TransportPreference } from "./endpoint";
import type { FetchLike } from "./transports";

export type ProducerUrlKind = "base" | "discovery" | "stream";

export interface ClassifiedProducerUrl {
    ok: boolean;
    kind: ProducerUrlKind | null;
    /** Where the discovery document lives (base and discovery URLs). */
    discoveryUrl: string | null;
    message: string | null;
}

/** Stream preference order when no transport is forced. */
export const TRANSPORT_ORDER: readonly StreamTransport[] = ["sse", "ndjson", "websocket"];

export const DEFAULT_DISCOVERY_TIMEOUT_MS = 5000;

export function classifyProducerUrl(url: string): ClassifiedProducerUrl {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return { ok: false, kind: null, discoveryUrl: null, message: "not a valid URL" };
    }
    const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
    const isWs = parsed.protocol === "ws:" || parsed.protocol === "wss:";
    if (!isHttp && !isWs) {
        return { ok: false, kind: null, discoveryUrl: null, message: "must use ws://, wss://, http:// or https://" };
    }
    const violation = endpointPolicyViolation(parsed);
    if (violation !== null) {
        return { ok: false, kind: null, discoveryUrl: null, message: violation };
    }
    if (isHttp && (parsed.pathname === "" || parsed.pathname === "/")) {
        const discovery = new URL(WELL_KNOWN_DISCOVERY_PATH, parsed);
        return { ok: true, kind: "base", discoveryUrl: discovery.toString(), message: null };
    }
    if (isHttp && parsed.pathname.replace(/\/+$/, "").endsWith(WELL_KNOWN_DISCOVERY_PATH)) {
        return { ok: true, kind: "discovery", discoveryUrl: parsed.toString(), message: null };
    }
    return { ok: true, kind: "stream", discoveryUrl: null, message: null };
}

export interface DiscoveryFetchResult {
    ok: boolean;
    discovery: ProducerDiscovery | null;
    /** HTTP status when a response arrived. */
    status: number | null;
    error: string | null;
    /** The request failed at the network level from a page (typical of a CORS refusal). */
    corsSuspected: boolean;
}

export interface DiscoveryFetchOptions {
    token?: string;
    fetch?: FetchLike;
    timeoutMs?: number;
}

/** The origin the viewer runs on, for CORS hints ("this page's origin" outside a browser). */
export function viewerOrigin(): string {
    const origin = (globalThis as { location?: { origin?: unknown } }).location?.origin;
    return typeof origin === "string" && origin !== "" && origin !== "null" ? origin : "this page's origin";
}

/**
 * Operator guidance when a producer refused (or did not answer) a
 * cross-origin request: which allowlist to change, per producer.
 */
export function corsHint(origin: string = viewerOrigin()): string {
    return (
        `if the producer is running, allow ${origin}: Sonder Runtime lists it in SONDER_OBSERVATORY_ORIGINS ` +
        `(or SONDER_CORS_ORIGINS on runtimes without the telemetry-scoped setting); ` +
        `Sonder-Inference takes --cors-origin ${origin}`
    );
}

async function readErrorCode(response: Response): Promise<string | null> {
    try {
        const body = (await response.json()) as { error?: { code?: unknown } };
        return typeof body?.error?.code === "string" ? body.error.code : null;
    } catch {
        return null;
    }
}

/** Fetches and validates a discovery document. Never throws. */
export async function fetchDiscovery(url: string, options: DiscoveryFetchOptions = {}): Promise<DiscoveryFetchResult> {
    const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { Accept: "application/json", "Cache-Control": "no-store" };
    if (options.token !== undefined) {
        headers.Authorization = `Bearer ${options.token}`;
    }
    const fail = (error: string, status: number | null = null, corsSuspected = false): DiscoveryFetchResult => ({
        ok: false,
        discovery: null,
        status,
        error,
        corsSuspected,
    });
    try {
        let response: Response;
        try {
            response = await fetchImpl(url, { headers, signal: controller.signal, cache: "no-store" });
        } catch (error) {
            if ((error as { name?: string })?.name === "AbortError") {
                return fail(`discovery timed out after ${timeoutMs} ms at ${url}`);
            }
            return fail(`could not reach ${url} (${(error as Error)?.message ?? String(error)}); ${corsHint()}`, null, true);
        }
        if (response.status === 401) {
            return fail(
                options.token === undefined
                    ? "the producer requires a bearer token; add one to this connection"
                    : "the producer rejected the bearer token",
                401,
            );
        }
        if (response.status === 403) {
            const code = await readErrorCode(response);
            if (code === "forbidden_origin") {
                return fail(`the producer refused this origin (forbidden_origin); ${corsHint()}`, 403, true);
            }
            return fail(`the producer refused the request (HTTP 403${code ? ` ${code}` : ""})`, 403);
        }
        if (response.status === 404) {
            return fail(
                `no discovery document at ${url} (HTTP 404); the producer may not publish telemetry — enter its stream URL instead`,
                404,
            );
        }
        if (!response.ok) {
            return fail(`discovery failed with HTTP ${response.status} at ${url}`, response.status);
        }
        let body: unknown;
        try {
            body = await response.json();
        } catch {
            return fail(`the discovery document at ${url} is not JSON`, response.status);
        }
        const parsed = parseDiscovery(body);
        if (!parsed.ok) {
            return fail(
                `discovery document rejected: ${formatIssues(parsed.issues)}; you can still enter a stream URL directly`,
                response.status,
            );
        }
        return { ok: true, discovery: parsed.discovery, status: response.status, error: null, corsSuspected: false };
    } finally {
        clearTimeout(timer);
    }
}

export interface SelectedStream {
    ok: boolean;
    url: string | null;
    transport: StreamTransport | null;
    message: string | null;
}

/**
 * Picks the stream to open from a discovery document: SSE, then NDJSON,
 * then WebSocket, unless a transport is forced. Relative stream URLs are
 * resolved against the discovery URL. With a token, WebSocket streams are
 * skipped (a browser cannot send Authorization on the handshake) and a
 * stream on a different origin is refused, so the token never leaves the
 * producer that asked for it.
 */
export function selectStream(
    discovery: ProducerDiscovery,
    discoveryUrl: string,
    options: { transport?: TransportPreference; hasToken?: boolean } = {},
): SelectedStream {
    const forced = options.transport && options.transport !== "auto" ? options.transport : null;
    const order = forced ? [forced] : TRANSPORT_ORDER;
    const origin = new URL(discoveryUrl).origin;
    const problems: string[] = [];
    for (const transport of order) {
        const stream = discovery.streams.find((s) => s.transport === transport);
        if (!stream) {
            continue;
        }
        if (transport === "websocket" && options.hasToken) {
            problems.push("the websocket stream cannot carry a bearer token");
            continue;
        }
        let resolved: URL;
        try {
            resolved = new URL(stream.url, discoveryUrl);
        } catch {
            problems.push(`${transport} stream URL ${JSON.stringify(stream.url)} is not valid`);
            continue;
        }
        if (transport === "websocket" && (resolved.protocol === "http:" || resolved.protocol === "https:")) {
            // A relative WebSocket path resolves against the http(s) discovery URL.
            resolved.protocol = resolved.protocol === "https:" ? "wss:" : "ws:";
        }
        const violation = endpointPolicyViolation(resolved);
        if (violation !== null) {
            problems.push(`${transport} stream refused: ${violation}`);
            continue;
        }
        if (options.hasToken && resolved.origin !== origin) {
            problems.push(`${transport} stream is on another origin (${resolved.origin}); refusing to send the token there`);
            continue;
        }
        return { ok: true, url: resolved.toString(), transport, message: null };
    }
    const wanted = forced ? `a ${forced} stream` : "a usable stream";
    return {
        ok: false,
        url: null,
        transport: null,
        message: `the producer offers no ${wanted}${problems.length > 0 ? ` (${problems.join("; ")})` : ""}`,
    };
}
