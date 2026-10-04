/**
 * Live ingest client: connects to a running producer, decodes and validates
 * events, buffers them in a bounded queue and appends them to a session sink
 * in batches. Reconnects with backoff and asks the producer to resume after
 * the last event it saw.
 *
 * Data flow:
 *   transport (WS | SSE | NDJSON) -> payload text -> JSON.parse -> adapter
 *   -> validateEvent -> BoundedBuffer -> batched sink.append()
 *
 * A producer base URL (http(s) with an empty path or "/") or discovery URL
 * is resolved through the producer's discovery document first
 * (/.well-known/sonder-telemetry, live producer protocol v1), so the
 * single-URL connect path accepts the same URLs as LiveConnectionManager.
 *
 * Duplicate delivery after a reconnect (a producer that ignores the resume
 * request and replays) is harmless: SessionStore.append deduplicates by
 * event_id and reports `duplicates`.
 */
import type { ObservatoryEvent } from "../../protocol/events";
import { formatIssues, validateEvent } from "../../protocol/validate";
import type { RejectedLine } from "../../recording/ndjson";
import type { WebSocketFactory, WebSocketLike } from "../../transport/live";
import { normalizeAdapted, type EventAdapter } from "./adapter";
import { Backoff, type BackoffOptions } from "./backoff";
import { BoundedBuffer, type OverflowPolicy } from "./buffer";
import { classifyProducerUrl, fetchDiscovery, selectStream } from "./discovery";
import { resolveEndpoint, type LiveEndpoint, type TransportKind, type TransportPreference } from "./endpoint";
import {
    openHttpStream,
    openWebSocket,
    type FetchLike,
    type TransportCallbacks,
    type TransportHandle,
} from "./transports";

/** Anything that accepts batches of validated events; SessionStore fits. */
export interface LiveIngestSink {
    append(events: readonly ObservatoryEvent[]): void | Promise<void>;
    addRejected?(lines: readonly RejectedLine[]): void;
}

export type LiveState = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "failed";

export interface LiveIngestStatus {
    state: LiveState;
    url: string;
    /** Transport in use (after an HTTP response, the detected flavour). */
    transport: TransportKind | null;
    loopback: boolean;
    /** Security or configuration warning for the UI, if any. */
    warning: string | null;
    /** Connection attempts made so far (1 = first connect). */
    attempts: number;
    /** Successful re-opens after the first connection. */
    reconnects: number;
    /** Delay before the next attempt while `reconnecting`. */
    retryInMs: number | null;
    /** Last completed producer cursor; sent on reconnect to resume. */
    lastEventId: string | null;
    /** True when the current/last connection asked the producer to resume. */
    resumeRequested: boolean;
    /** Valid events decoded from the wire. */
    received: number;
    /** Events handed to the sink. */
    appended: number;
    /** Events discarded because the buffer was full. */
    dropped: number;
    /** Lines/frames that failed JSON parsing, adaptation or validation. */
    rejected: number;
    /** Events waiting in the buffer. */
    buffered: number;
    bufferCapacity: number;
    /** Number of sink.append calls. */
    batches: number;
    lastError: string | null;
}

export interface LiveIngestOptions {
    url: string;
    sink: LiveIngestSink;
    /** Force a transport; default picks by URL (ws(s) vs http(s)). */
    transport?: TransportPreference;
    /** Maps producer-specific shapes before validation (Inference adapter hook). */
    adapter?: EventAdapter;
    /** Max events held between flushes. Default 20000. */
    bufferCapacity?: number;
    /** What to discard when full. Default "drop-oldest" (keep the live edge). */
    overflow?: OverflowPolicy;
    /** Max events per sink.append call. Default 1000. */
    batchSize?: number;
    /** Delay between flushes in ms. Default 50. */
    flushIntervalMs?: number;
    /**
     * HTTP streams: "pause" stops reading while the buffer is above its high
     * watermark (TCP backpressure, no drops); "drop" keeps reading. WebSocket
     * cannot be paused from a browser, so it always drops on overflow.
     * Default "pause".
     */
    httpBackpressure?: "pause" | "drop";
    /** Reconnect after the connection closes. Default true. */
    reconnect?: boolean;
    /** Give up after this many consecutive failed attempts. Default Infinity. */
    maxRetries?: number;
    backoff?: BackoffOptions;
    /** Ask the producer to resume after lastEventId. Default true. */
    resume?: boolean;
    /** WebSocket resume query parameter. Default "last_event_id". */
    resumeParam?: string;
    webSocketFactory?: WebSocketFactory;
    fetch?: FetchLike;
    /**
     * Extra headers for HTTP transports, for example
     * `{ Authorization: "Bearer <token>" }`. Never logged or reported in
     * status. A WebSocket URL with an Authorization header is refused,
     * because a browser cannot send it on the handshake.
     */
    headers?: Readonly<Record<string, string>>;
    /**
     * Resolve a producer base URL or discovery URL through the discovery
     * document before streaming. Default true. LiveConnectionManager passes
     * false: it resolves discovery itself and hands over the stream URL.
     */
    discover?: boolean;
    onStatus?: (status: LiveIngestStatus) => void;
}

function hasAuthorization(headers: Readonly<Record<string, string>> | undefined): boolean {
    return headers !== undefined && Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
}

const WS_TOKEN_REFUSED = "a bearer token cannot be sent over WebSocket; use the producer's SSE or NDJSON stream";

const MAX_REJECTED_KEPT = 1000;

/**
 * Upper bound for a producer's SSE `retry:` hint. setTimeout treats delays
 * above 2^31-1 ms as 0, so an unclamped hint could force a reconnect loop.
 */
export const MAX_SERVER_RETRY_MS = 60_000;

/** A server retry hint in [0, MAX_SERVER_RETRY_MS], or null when unusable. */
export function clampRetryHint(ms: number): number | null {
    return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_SERVER_RETRY_MS) : null;
}

/** The bearer token in an Authorization header, if any. */
function bearerToken(headers: Readonly<Record<string, string>> | undefined): string | undefined {
    const entry = Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === "authorization");
    const match = entry ? /^Bearer (.+)$/.exec(entry[1]) : null;
    return match ? match[1] : undefined;
}

/** Where the discovery document lives when `options.url` needs discovery, else null. */
function discoveryUrlFor(options: LiveIngestOptions): string | null {
    if (options.discover === false) {
        return null;
    }
    const classified = classifyProducerUrl(options.url);
    return classified.ok && classified.kind !== "stream" ? classified.discoveryUrl : null;
}

/**
 * resolveEndpoint plus the rule that a token never travels over WebSocket.
 * A URL that needs discovery is checked against the policy only: its
 * transport is known once discovery picked a stream.
 */
function checkedEndpoint(options: LiveIngestOptions): LiveEndpoint {
    if (discoveryUrlFor(options) !== null) {
        const endpoint = resolveEndpoint(options.url, "auto");
        return { ...endpoint, kind: endpoint.ok ? endpoint.kind : null };
    }
    const endpoint = resolveEndpoint(options.url, options.transport ?? "auto");
    if (endpoint.ok && endpoint.kind === "websocket" && hasAuthorization(options.headers)) {
        return { ...endpoint, ok: false, kind: null, message: WS_TOKEN_REFUSED };
    }
    return endpoint;
}

export class LiveIngestClient {
    private readonly options: LiveIngestOptions;
    private readonly buffer: BoundedBuffer<ObservatoryEvent>;
    private readonly backoff: Backoff;
    private readonly batchSize: number;
    private readonly flushIntervalMs: number;
    private readonly highWater: number;
    private readonly lowWater: number;
    private readonly listeners = new Set<(s: LiveIngestStatus) => void>();
    private readonly statusValue: LiveIngestStatus;
    private handle: TransportHandle | null = null;
    private kind: TransportKind | null = null;
    /** Discovery URL for base/discovery URLs; null for stream URLs. */
    private readonly discoveryUrl: string | null;
    /** The stream discovery selected (kept across reconnects). */
    private streamUrl: string | null = null;
    private stopped = true;
    private everOpened = false;
    private failures = 0;
    private serverRetryMs: number | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private flushing: Promise<void> | null = null;
    private capacityWaiters: (() => void)[] = [];
    private pendingRejected: RejectedLine[] = [];
    private lineCounter = 0;
    private gotDataSinceOpen = false;
    private generation = 0;

    constructor(options: LiveIngestOptions) {
        this.options = options;
        const capacity = options.bufferCapacity ?? 20_000;
        this.buffer = new BoundedBuffer<ObservatoryEvent>(capacity, options.overflow ?? "drop-oldest");
        this.backoff = new Backoff(options.backoff);
        this.batchSize = Math.max(1, options.batchSize ?? 1000);
        this.flushIntervalMs = Math.max(0, options.flushIntervalMs ?? 50);
        this.highWater = Math.max(1, Math.floor(capacity * 0.75));
        this.lowWater = Math.floor(capacity * 0.25);
        this.discoveryUrl = discoveryUrlFor(options);
        const endpoint = checkedEndpoint(options);
        this.kind = this.discoveryUrl === null ? endpoint.kind : null;
        this.statusValue = {
            state: "idle",
            url: options.url,
            transport: this.kind,
            loopback: endpoint.loopback,
            warning: endpoint.ok ? (endpoint.message ?? null) : null,
            attempts: 0,
            reconnects: 0,
            retryInMs: null,
            lastEventId: null,
            resumeRequested: false,
            received: 0,
            appended: 0,
            dropped: 0,
            rejected: 0,
            buffered: 0,
            bufferCapacity: capacity,
            batches: 0,
            lastError: endpoint.ok ? null : (endpoint.message ?? "invalid endpoint"),
        };
        if (options.onStatus) {
            this.listeners.add(options.onStatus);
        }
    }

    /** Snapshot of the connection and accounting state. */
    get status(): LiveIngestStatus {
        return { ...this.statusValue };
    }

    /** Subscribes to status changes; the listener is called immediately. */
    subscribe(listener: (status: LiveIngestStatus) => void): () => void {
        this.listeners.add(listener);
        listener(this.status);
        return () => {
            this.listeners.delete(listener);
        };
    }

    start(): void {
        if (!this.stopped) {
            return;
        }
        const endpoint = checkedEndpoint(this.options);
        if (!endpoint.ok || endpoint.kind === null) {
            this.update({ state: "failed", lastError: endpoint.message ?? "invalid endpoint" });
            return;
        }
        if (this.discoveryUrl === null) {
            this.kind = endpoint.kind;
        }
        this.stopped = false;
        this.connect();
    }

    /** Closes the connection and stops reconnecting. Buffered events are flushed. */
    async stop(): Promise<void> {
        this.stopped = true;
        this.generation += 1;
        this.clearRetry();
        const handle = this.handle;
        this.handle = null;
        handle?.close();
        this.releaseWaiters();
        await this.flush();
        this.update({ state: "closed", retryInMs: null });
    }

    /** Appends everything currently buffered (in batches) and resolves when done. */
    async flush(): Promise<void> {
        if (this.flushTimer !== null) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        while (this.flushing) {
            await this.flushing;
        }
        while (this.buffer.size > 0 || this.pendingRejected.length > 0) {
            await this.flushOnce();
        }
    }

    // --- connection lifecycle ------------------------------------------------

    private connect(): void {
        const needsDiscovery = this.discoveryUrl !== null && this.streamUrl === null;
        if (this.stopped || (this.kind === null && !needsDiscovery)) {
            return;
        }
        const generation = ++this.generation;
        const resume = this.options.resume !== false;
        const lastEventId = resume ? this.statusValue.lastEventId : null;
        this.gotDataSinceOpen = false;
        this.serverRetryMs = null;
        this.update({
            state: this.everOpened || this.statusValue.attempts > 0 ? "reconnecting" : "connecting",
            attempts: this.statusValue.attempts + 1,
            retryInMs: null,
            resumeRequested: lastEventId !== null,
        });
        if (needsDiscovery) {
            void this.discover(generation, lastEventId);
            return;
        }
        this.open(generation, lastEventId);
    }

    /**
     * Fetches the discovery document and picks the stream (SSE, then NDJSON,
     * then WebSocket unless a transport is forced). An unreachable producer
     * is retried like a failed stream; a refused document or a producer
     * without a usable stream is final.
     */
    private async discover(generation: number, lastEventId: string | null): Promise<void> {
        const discoveryUrl = this.discoveryUrl!;
        const token = bearerToken(this.options.headers);
        const fetched = await fetchDiscovery(discoveryUrl, { token, fetch: this.options.fetch });
        if (generation !== this.generation || this.stopped) {
            return;
        }
        if (!fetched.ok || !fetched.discovery) {
            const reason = fetched.error ?? "discovery failed";
            if (fetched.status !== null && fetched.status >= 200 && fetched.status < 300) {
                this.stopped = true;
                this.update({ state: "failed", lastError: reason, retryInMs: null });
                return;
            }
            this.onDisconnected(reason, true);
            return;
        }
        const selected = selectStream(fetched.discovery, discoveryUrl, {
            transport: this.options.transport,
            hasToken: token !== undefined || hasAuthorization(this.options.headers),
        });
        if (!selected.ok || selected.url === null || selected.transport === null) {
            this.stopped = true;
            this.update({ state: "failed", lastError: selected.message ?? "no usable stream", retryInMs: null });
            return;
        }
        this.streamUrl = selected.url;
        this.kind = selected.transport;
        this.update({ transport: selected.transport });
        this.open(generation, lastEventId);
    }

    private open(generation: number, lastEventId: string | null): void {
        if (this.kind === null) {
            return;
        }
        const current = () => generation === this.generation && !this.stopped;
        const callbacks: TransportCallbacks = {
            onOpen: (kind) => {
                if (!current()) {
                    return;
                }
                this.failures = 0;
                const reopened = this.everOpened;
                this.everOpened = true;
                this.update({
                    state: "open",
                    transport: kind,
                    lastError: null,
                    reconnects: this.statusValue.reconnects + (reopened ? 1 : 0),
                });
            },
            onPayload: (text, id) => {
                if (!current()) {
                    return;
                }
                if (this.kind !== "websocket" && this.options.httpBackpressure !== "drop") {
                    return this.ingestHttp(text, id, current);
                }
                this.ingest(text, id);
            },
            onInvalidFrame: (reason) => {
                if (current()) {
                    this.reject({ line: ++this.lineCounter, reason, raw: "" });
                    this.scheduleFlush();
                }
            },
            onRetryHint: (ms) => {
                if (current()) {
                    this.serverRetryMs = clampRetryHint(ms);
                }
            },
            onClose: (reason, failed) => {
                if (!current()) {
                    return;
                }
                this.handle = null;
                this.onDisconnected(reason, failed);
            },
            waitForCapacity: () => this.waitForCapacity(),
        };
        const request = {
            url: this.streamUrl ?? this.options.url,
            kind: this.kind,
            lastEventId,
            resumeParam: this.options.resumeParam ?? "last_event_id",
            headers: this.options.headers,
        };
        if (this.kind === "websocket") {
            const factory =
                this.options.webSocketFactory ??
                ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
            this.handle = openWebSocket(request, callbacks, factory);
        } else {
            const fetchImpl: FetchLike =
                this.options.fetch ?? ((input, init) => globalThis.fetch(input, init));
            this.handle = openHttpStream(request, callbacks, fetchImpl);
        }
    }

    private onDisconnected(reason: string, failed: boolean): void {
        this.releaseWaiters();
        if (this.stopped) {
            return;
        }
        if (this.options.reconnect === false) {
            this.stopped = true;
            this.update({ state: failed ? "failed" : "closed", lastError: failed ? reason : null });
            return;
        }
        if (!this.gotDataSinceOpen) {
            this.failures += 1;
        }
        const maxRetries = this.options.maxRetries ?? Number.POSITIVE_INFINITY;
        if (this.failures > maxRetries) {
            this.stopped = true;
            this.update({ state: "failed", lastError: reason, retryInMs: null });
            return;
        }
        const delay = Math.max(this.serverRetryMs ?? 0, this.backoff.next());
        this.update({ state: "reconnecting", lastError: reason, retryInMs: delay });
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.connect();
        }, delay);
    }

    private clearRetry(): void {
        if (this.retryTimer !== null) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }

    // --- decoding --------------------------------------------------------------

    private *decode(text: string): Generator<{ event: ObservatoryEvent } | { cursor: string | null }> {
        let start = 0;
        const adapter = this.options.adapter;
        while (start <= text.length) {
            let end = text.indexOf("\n", start);
            if (end === -1) {
                end = text.length;
            }
            const raw = text.slice(start, end).trim();
            start = end + 1;
            if (raw === "") {
                continue;
            }
            const line = ++this.lineCounter;
            let value: unknown;
            try {
                value = JSON.parse(raw);
            } catch (error) {
                this.reject({ line, reason: `invalid JSON: ${(error as Error).message}`, raw });
                continue;
            }
            // Capture producer identity before an adapter can rewrite or fan out the event.
            const source = validateEvent(value);
            const cursor = source.ok ? source.event.event_id : null;
            let values: unknown[];
            try {
                values = adapter ? normalizeAdapted(adapter(value)) : [value];
            } catch (error) {
                this.reject({ line, reason: `adapter error: ${(error as Error).message}`, raw });
                continue;
            }
            for (const candidate of values) {
                const result = !adapter && candidate === value ? source : validateEvent(candidate);
                if (!result.ok) {
                    this.reject({ line, reason: formatIssues(result.issues), raw });
                    continue;
                }
                yield { event: result.event };
            }
            // Reaching this marker means every output of this source line was consumed.
            yield { cursor };
        }
    }

    private accept(event: ObservatoryEvent, trackEventId = true): void {
        this.buffer.push(event);
        if (!this.gotDataSinceOpen) {
            this.gotDataSinceOpen = true;
            this.backoff.reset();
        }
        this.statusValue.received += 1;
        if (trackEventId) {
            this.statusValue.lastEventId = event.event_id;
        }
        this.statusValue.dropped = this.buffer.dropped;
        this.statusValue.buffered = this.buffer.size;
    }

    private finishPayload(sseId: string | null): void {
        if (sseId !== null) {
            this.statusValue.lastEventId = sseId;
        }
        this.scheduleFlush();
    }

    private ingest(text: string, sseId: string | null): void {
        for (const part of this.decode(text)) {
            if ("event" in part) {
                this.accept(part.event);
            }
        }
        this.finishPayload(sseId);
    }

    /** A single HTTP chunk or adapter result can exceed the whole queue. */
    private async ingestHttp(text: string, sseId: string | null, current: () => boolean): Promise<void> {
        for (const part of this.decode(text)) {
            if (!current()) {
                return;
            }
            if ("cursor" in part) {
                // SSE commits only at the message boundary; NDJSON at each full source line.
                if (sseId === null && part.cursor !== null) {
                    this.statusValue.lastEventId = part.cursor;
                }
                continue;
            }
            if (this.buffer.size >= this.highWater) {
                this.scheduleFlush();
                await this.waitForCapacity();
                if (!current()) {
                    return;
                }
            }
            this.accept(part.event, false);
        }
        this.finishPayload(sseId);
    }

    private reject(line: RejectedLine): void {
        this.statusValue.rejected += 1;
        if (this.pendingRejected.length < MAX_REJECTED_KEPT) {
            this.pendingRejected.push(line);
        }
    }

    // --- batching / backpressure ----------------------------------------------

    private scheduleFlush(): void {
        if (this.flushTimer !== null || this.flushing) {
            return;
        }
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            void this.flushOnce().then(() => {
                if (this.buffer.size > 0 || this.pendingRejected.length > 0) {
                    this.scheduleFlush();
                }
            });
        }, this.flushIntervalMs);
    }

    private flushOnce(): Promise<void> {
        if (this.flushing) {
            return this.flushing;
        }
        const run = async () => {
            const rejected = this.pendingRejected;
            this.pendingRejected = [];
            if (rejected.length > 0) {
                this.options.sink.addRejected?.(rejected);
            }
            const batch = this.buffer.drain(this.batchSize);
            if (batch.length > 0) {
                try {
                    await this.options.sink.append(batch);
                } catch (error) {
                    this.statusValue.lastError = `sink error: ${(error as Error).message}`;
                }
                this.statusValue.appended += batch.length;
                this.statusValue.batches += 1;
            }
            this.statusValue.buffered = this.buffer.size;
            this.statusValue.dropped = this.buffer.dropped;
            if (this.buffer.size <= this.lowWater) {
                this.releaseWaiters();
            }
            this.emit();
        };
        this.flushing = run().finally(() => {
            this.flushing = null;
        });
        return this.flushing;
    }

    private waitForCapacity(): Promise<void> {
        if (
            this.stopped ||
            this.options.httpBackpressure === "drop" ||
            this.buffer.size < this.highWater
        ) {
            return Promise.resolve();
        }
        return new Promise((resolve) => this.capacityWaiters.push(resolve));
    }

    private releaseWaiters(): void {
        const waiters = this.capacityWaiters;
        this.capacityWaiters = [];
        for (const resolve of waiters) {
            resolve();
        }
    }

    // --- status ------------------------------------------------------------------

    private update(patch: Partial<LiveIngestStatus>): void {
        Object.assign(this.statusValue, patch);
        this.statusValue.buffered = this.buffer.size;
        this.statusValue.dropped = this.buffer.dropped;
        this.emit();
    }

    private emit(): void {
        const snapshot = this.status;
        for (const listener of this.listeners) {
            listener(snapshot);
        }
    }
}
