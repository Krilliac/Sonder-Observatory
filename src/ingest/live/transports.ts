/**
 * Wire transports for live ingest. Each transport only moves text: it hands
 * raw payloads (one JSON event or several NDJSON lines) to the client, which
 * owns decoding, validation, buffering and reconnect policy.
 */
import type { WebSocketFactory, WebSocketLike } from "../../transport/live";
import { withQueryParam, type TransportKind } from "./endpoint";
import { LineSplitter, MAX_LINE_CHARS, MAX_SSE_FIELD_CHARS, SseParser } from "./sse";

/** Producer-announced live stream notices carried in SSE comments (live protocol v1). */
export type SseServerNotice =
    /** `stream` is "samples" for the `s<from>-s<to>` form; absent for the default stream. */
    | { kind: "resume-gap"; from: number; to: number; stream?: string }
    | { kind: "dropped"; count: number };

export interface TransportCallbacks {
    onOpen(kind: TransportKind): void;
    /** One or more NDJSON lines; HTTP awaits consumption. `id` is the SSE id, if any. */
    onPayload(text: string, id: string | null): void | Promise<void>;
    /** A frame that cannot carry NDJSON text (for example a binary frame). */
    onInvalidFrame(reason: string): void;
    /** Server-requested reconnection delay (SSE `retry:` or HTTP `Retry-After`). */
    onRetryHint(ms: number): void;
    /** Producer-announced SSE stream notice (`: resume-gap` or `: dropped`). */
    onServerNotice?(notice: SseServerNotice): void;
    onClose(reason: string, failed: boolean): void;
    /**
     * Resolves when the consumer has room again. Pull-based transports
     * (HTTP streams) await it before reading more, so a slow consumer
     * applies TCP backpressure instead of dropping events.
     */
    waitForCapacity(): Promise<void>;
}

/**
 * Parses an HTTP `Retry-After` header (RFC 9110: non-negative integer seconds
 * or HTTP-date) into a delay in milliseconds, or null when missing/invalid.
 */
export function parseRetryAfterMs(header: string | null, nowMs: number = Date.now()): number | null {
    if (header === null) {
        return null;
    }
    const trimmed = header.trim();
    if (trimmed === "") {
        return null;
    }
    if (/^\d+$/.test(trimmed)) {
        const seconds = Number(trimmed);
        return Number.isFinite(seconds) ? seconds * 1000 : null;
    }
    // Every RFC 9110 HTTP-date includes month/day letters; guard against V8's loose Date.parse("-5").
    if (!/[a-zA-Z]/.test(trimmed)) {
        return null;
    }
    const dateMs = Date.parse(trimmed);
    if (Number.isFinite(dateMs)) {
        return Math.max(0, dateMs - nowMs);
    }
    return null;
}

/**
 * True when `value` can safely be placed in an HTTP request header (Fetch API
 * ByteString: Latin-1 without C0/DEL control characters, bounded length).
 */
export function isValidHttpHeaderValue(value: string): boolean {
    if (value.length === 0 || value.length > MAX_SSE_FIELD_CHARS) {
        return false;
    }
    for (let i = 0; i < value.length; i += 1) {
        const code = value.charCodeAt(i);
        if (code < 0x20 || code === 0x7f || code > 0xff) {
            return false;
        }
    }
    return true;
}

/**
 * Parses Sonder live-protocol v1 SSE comments:
 * - `: resume-gap <from>-<to>` (default stream) and
 *   `: resume-gap s<from>-s<to>` (samples stream; both numbers carry the prefix)
 * - `: dropped <n>`
 */
export function parseSseControlComment(comment: string): SseServerNotice | null {
    const trimmed = comment.trim();
    const gap = /^resume-gap\s+(s?)(\d+)-(s?)(\d+)$/.exec(trimmed);
    if (gap) {
        if (gap[1] !== gap[3]) {
            return null;
        }
        const from = Number(gap[2]);
        const to = Number(gap[4]);
        if (Number.isSafeInteger(from) && Number.isSafeInteger(to) && from <= to) {
            return gap[1] === "s" ? { kind: "resume-gap", from, to, stream: "samples" } : { kind: "resume-gap", from, to };
        }
        return null;
    }
    const dropped = /^dropped\s+(\d+)$/.exec(trimmed);
    if (dropped) {
        const count = Number(dropped[1]);
        if (Number.isSafeInteger(count) && count > 0) {
            return { kind: "dropped", count };
        }
    }
    return null;
}

export interface TransportRequest {
    url: string;
    kind: TransportKind;
    lastEventId: string | null;
    /** Query parameter used to request resume on WebSocket. */
    resumeParam: string;
    /**
     * Extra request headers for HTTP streams (for example Authorization).
     * WebSocket handshakes cannot carry them from a browser; the client
     * refuses a token on ws(s) before a transport is opened.
     */
    headers?: Readonly<Record<string, string>>;
}

/** Status line text for a failed HTTP stream response, with a hint. */
/**
 * Streams, discovery, health and probes are fetched with `redirect: "manual"`:
 * a redirect is never followed, so a producer cannot move the viewer to an
 * endpoint the endpoint policy (resolveEndpoint) would have refused, such as
 * plain http:// on a non-loopback host.
 */
export const NO_REDIRECTS: RequestRedirect = "manual";

/**
 * Telemetry fetches never send ambient browser cookies or HTTP auth: bearer
 * tokens are attached explicitly via the Authorization header only.
 */
export const NO_CREDENTIALS: RequestCredentials = "omit";

/** A redirect answer: a 3xx, or the opaque redirect a browser reports for "manual". */
export function isRedirect(response: Response): boolean {
    return response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
}

export const REDIRECT_REFUSED =
    "the producer answered with a redirect, which is not followed (the endpoint policy applies to the URL entered); enter the final URL instead";

export function describeHttpFailure(status: number): string {
    if (status === 0 || (status >= 300 && status < 400)) {
        return `${status === 0 ? "redirect" : `HTTP ${status}`}: ${REDIRECT_REFUSED}`;
    }
    switch (status) {
        case 401:
            return "HTTP 401: the producer requires a bearer token (or rejected the one given)";
        case 403:
            return "HTTP 403: the producer refused this request (origin, host or token not allowed)";
        case 404:
            return "HTTP 404: no telemetry stream at this URL (is export enabled on the producer?)";
        case 429:
            return "HTTP 429: the producer has too many telemetry subscribers; retrying";
        default:
            return `HTTP ${status}`;
    }
}

export interface TransportHandle {
    close(): void;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function openWebSocket(
    request: TransportRequest,
    callbacks: TransportCallbacks,
    factory: WebSocketFactory,
    /** Largest text frame accepted, in UTF-16 code units. */
    maxFrameChars: number = MAX_LINE_CHARS,
): TransportHandle {
    // Browsers cannot set headers on a WebSocket handshake, so resume is
    // requested with a query parameter the producer may honour or ignore.
    const url = request.lastEventId
        ? withQueryParam(request.url, request.resumeParam, request.lastEventId)
        : request.url;
    let closed = false;
    let socket: WebSocketLike;
    try {
        socket = factory(url);
    } catch (error) {
        queueMicrotask(() => callbacks.onClose((error as Error).message, true));
        return { close: () => undefined };
    }
    let opened = false;
    socket.onopen = () => {
        if (!closed) {
            opened = true;
            callbacks.onOpen("websocket");
        }
    };
    socket.onmessage = (ev) => {
        if (closed) {
            return;
        }
        if (typeof ev.data === "string" && ev.data.length > maxFrameChars) {
            callbacks.onInvalidFrame(`a WebSocket frame of ${ev.data.length} characters exceeds the ${maxFrameChars}-character limit`);
        } else if (typeof ev.data === "string") {
            callbacks.onPayload(ev.data, null);
        } else {
            callbacks.onInvalidFrame("binary frames are not supported");
        }
    };
    socket.onerror = () => undefined; // onclose follows with the details
    socket.onclose = (ev) => {
        if (closed) {
            return;
        }
        closed = true;
        callbacks.onClose(ev.reason || `closed (${ev.code})`, !opened || ev.code !== 1000);
    };
    return {
        close: () => {
            if (closed) {
                return;
            }
            closed = true;
            try {
                socket.close(1000, "client disconnect");
            } catch {
                // already closing
            }
        },
    };
}

export function openHttpStream(
    request: TransportRequest,
    callbacks: TransportCallbacks,
    fetchImpl: FetchLike,
): TransportHandle {
    const controller = new AbortController();
    let closed = false;
    const finish = (reason: string, failed: boolean) => {
        if (closed) {
            return;
        }
        closed = true;
        callbacks.onClose(reason, failed);
    };

    const run = async () => {
        const headers: Record<string, string> = {
            ...request.headers,
            Accept:
                request.kind === "ndjson"
                    ? "application/x-ndjson, application/jsonl;q=0.9, text/event-stream;q=0.5"
                    : "text/event-stream, application/x-ndjson;q=0.5",
            "Cache-Control": "no-store",
        };
        let streamUrl = request.url;
        if (request.lastEventId) {
            if (isValidHttpHeaderValue(request.lastEventId)) {
                headers["Last-Event-ID"] = request.lastEventId;
            } else if (!request.lastEventId.includes("\u0000") && request.lastEventId.length <= MAX_SSE_FIELD_CHARS) {
                // Non-ByteString cursors (e.g. Unicode > 0xFF) would throw TypeError in Fetch Headers;
                // fall back to the protocol's percent-encoded query parameter so reconnect never loops on TypeError.
                streamUrl = withQueryParam(request.url, request.resumeParam, request.lastEventId);
            }
        }
        const response = await fetchImpl(streamUrl, {
            headers,
            signal: controller.signal,
            cache: "no-store",
            credentials: NO_CREDENTIALS,
            redirect: NO_REDIRECTS,
        });
        if (isRedirect(response)) {
            await response.body?.cancel().catch(() => undefined);
            finish(describeHttpFailure(response.type === "opaqueredirect" ? 0 : response.status), true);
            return;
        }
        if (!response.ok || !response.body) {
            const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"));
            if (retryAfter !== null) {
                callbacks.onRetryHint(retryAfter);
            }
            await response.body?.cancel().catch(() => undefined);
            finish(describeHttpFailure(response.status), true);
            return;
        }
        const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
        const kind: TransportKind = contentType.includes("text/event-stream") ? "sse" : "ndjson";
        callbacks.onOpen(kind);

        const decoder = new TextDecoder();
        // Hold only this read's parsed payloads; consume them before another read.
        const payloads: { text: string; id: string | null }[] = [];
        const deliver = async () => {
            for (const payload of payloads) {
                if (closed) {
                    break;
                }
                await callbacks.onPayload(payload.text, payload.id);
            }
            payloads.length = 0;
        };
        let feed: (text: string) => void;
        let end: () => void;
        if (kind === "sse") {
            const parser = new SseParser({
                onMessage: (m) => {
                    if (m.event === "message" || m.event === "event" || m.event === "events") {
                        payloads.push({ text: m.data, id: m.lastEventId || null });
                    }
                },
                onRetry: (ms) => callbacks.onRetryHint(ms),
                onComment: (comment) => {
                    const notice = parseSseControlComment(comment);
                    if (notice !== null) {
                        callbacks.onServerNotice?.(notice);
                    }
                },
                onOversize: (reason) => callbacks.onInvalidFrame(reason),
            });
            feed = (text) => parser.feed(text);
            end = () => parser.reset();
        } else {
            const splitter = new LineSplitter({ onOversize: (reason) => callbacks.onInvalidFrame(reason) });
            feed = (text) => {
                const lines = splitter.feed(text);
                if (lines.length > 0) {
                    payloads.push({ text: lines.join("\n"), id: null });
                }
            };
            end = () => {
                const rest = splitter.flush();
                if (rest.length > 0) {
                    payloads.push({ text: rest.join("\n"), id: null });
                }
            };
        }

        const reader = response.body.getReader();
        try {
            for (;;) {
                await callbacks.waitForCapacity();
                if (closed) {
                    break;
                }
                const { done, value } = await reader.read();
                if (closed) {
                    break;
                }
                if (done) {
                    feed(decoder.decode());
                    end();
                    await deliver();
                    finish("stream ended", false);
                    break;
                }
                if (value) {
                    feed(decoder.decode(value, { stream: true }));
                }
                await deliver();
            }
        } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
        }
    };

    run().catch((error: unknown) => {
        const name = (error as { name?: string })?.name;
        finish(name === "AbortError" ? "aborted" : String((error as Error)?.message ?? error), true);
    });

    return {
        close: () => {
            if (closed) {
                return;
            }
            closed = true;
            controller.abort();
        },
    };
}
