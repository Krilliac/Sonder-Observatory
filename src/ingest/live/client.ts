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
import { resolveEndpoint, type TransportKind, type TransportPreference } from "./endpoint";
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
    /** Last event id seen; sent on reconnect to resume. */
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
    onStatus?: (status: LiveIngestStatus) => void;
}

const MAX_REJECTED_KEPT = 1000;

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
        const endpoint = resolveEndpoint(options.url, options.transport ?? "auto");
        this.kind = endpoint.kind;
        this.statusValue = {
            state: "idle",
            url: options.url,
            transport: endpoint.kind,
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
        const endpoint = resolveEndpoint(this.options.url, this.options.transport ?? "auto");
        if (!endpoint.ok || endpoint.kind === null) {
            this.update({ state: "failed", lastError: endpoint.message ?? "invalid endpoint" });
            return;
        }
        this.kind = endpoint.kind;
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
        if (this.stopped || this.kind === null) {
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
                if (current()) {
                    this.ingest(text, id);
                }
            },
            onInvalidFrame: (reason) => {
                if (current()) {
                    this.reject({ line: ++this.lineCounter, reason, raw: "" });
                    this.scheduleFlush();
                }
            },
            onRetryHint: (ms) => {
                if (current()) {
                    this.serverRetryMs = ms;
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
            url: this.options.url,
            kind: this.kind,
            lastEventId,
            resumeParam: this.options.resumeParam ?? "last_event_id",
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

    private ingest(text: string, sseId: string | null): void {
        let lastId: string | null = null;
        let accepted = 0;
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
            let values: unknown[];
            try {
                values = adapter ? normalizeAdapted(adapter(value)) : [value];
            } catch (error) {
                this.reject({ line, reason: `adapter error: ${(error as Error).message}`, raw });
                continue;
            }
            for (const candidate of values) {
                const result = validateEvent(candidate);
                if (!result.ok) {
                    this.reject({ line, reason: formatIssues(result.issues), raw });
                    continue;
                }
                this.buffer.push(result.event);
                lastId = result.event.event_id;
                accepted += 1;
            }
        }
        if (accepted > 0) {
            if (!this.gotDataSinceOpen) {
                this.gotDataSinceOpen = true;
                this.backoff.reset();
            }
        }
        const nextId = sseId ?? lastId;
        this.statusValue.received += accepted;
        this.statusValue.dropped = this.buffer.dropped;
        this.statusValue.buffered = this.buffer.size;
        if (nextId !== null) {
            this.statusValue.lastEventId = nextId;
        }
        this.scheduleFlush();
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
