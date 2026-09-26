/**
 * Wire transports for live ingest. Each transport only moves text: it hands
 * raw payloads (one JSON event or several NDJSON lines) to the client, which
 * owns decoding, validation, buffering and reconnect policy.
 */
import type { WebSocketFactory, WebSocketLike } from "../../transport/live";
import { withQueryParam, type TransportKind } from "./endpoint";
import { LineSplitter, SseParser } from "./sse";

export interface TransportCallbacks {
    onOpen(kind: TransportKind): void;
    /** A payload of one or more NDJSON lines; `id` is the SSE id, if any. */
    onPayload(text: string, id: string | null): void;
    /** A frame that cannot carry NDJSON text (for example a binary frame). */
    onInvalidFrame(reason: string): void;
    /** Server-requested reconnection delay (SSE `retry:`). */
    onRetryHint(ms: number): void;
    onClose(reason: string, failed: boolean): void;
    /**
     * Resolves when the consumer has room again. Pull-based transports
     * (HTTP streams) await it before reading more, so a slow consumer
     * applies TCP backpressure instead of dropping events.
     */
    waitForCapacity(): Promise<void>;
}

export interface TransportRequest {
    url: string;
    kind: TransportKind;
    lastEventId: string | null;
    /** Query parameter used to request resume on WebSocket. */
    resumeParam: string;
}

export interface TransportHandle {
    close(): void;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function openWebSocket(
    request: TransportRequest,
    callbacks: TransportCallbacks,
    factory: WebSocketFactory,
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
        if (typeof ev.data === "string") {
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
            Accept:
                request.kind === "ndjson"
                    ? "application/x-ndjson, application/jsonl;q=0.9, text/event-stream;q=0.5"
                    : "text/event-stream, application/x-ndjson;q=0.5",
            "Cache-Control": "no-store",
        };
        if (request.lastEventId) {
            headers["Last-Event-ID"] = request.lastEventId;
        }
        const response = await fetchImpl(request.url, {
            headers,
            signal: controller.signal,
            cache: "no-store",
        });
        if (!response.ok || !response.body) {
            finish(`HTTP ${response.status}`, true);
            return;
        }
        const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
        const kind: TransportKind = contentType.includes("text/event-stream") ? "sse" : "ndjson";
        callbacks.onOpen(kind);

        const decoder = new TextDecoder();
        let feed: (text: string) => void;
        let end: () => void;
        if (kind === "sse") {
            const parser = new SseParser({
                onMessage: (m) => {
                    if (m.event === "message" || m.event === "event" || m.event === "events") {
                        callbacks.onPayload(m.data, m.lastEventId || null);
                    }
                },
                onRetry: (ms) => callbacks.onRetryHint(ms),
            });
            feed = (text) => parser.feed(text);
            end = () => parser.reset();
        } else {
            const splitter = new LineSplitter();
            feed = (text) => {
                const lines = splitter.feed(text);
                if (lines.length > 0) {
                    callbacks.onPayload(lines.join("\n"), null);
                }
            };
            end = () => {
                const rest = splitter.flush();
                if (rest.length > 0) {
                    callbacks.onPayload(rest.join("\n"), null);
                }
            };
        }

        const reader = response.body.getReader();
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
                finish("stream ended", false);
                break;
            }
            feed(decoder.decode(value, { stream: true }));
        }
        reader.cancel().catch(() => undefined);
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
