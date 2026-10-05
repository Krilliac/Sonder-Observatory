/**
 * Multi-producer live connections (contract section 8.1, see
 * docs/integration/live-ingest.md).
 *
 * Observatory connects to each producer directly (Sonder Runtime,
 * Sonder-Inference, fixtures) and merges their events into one SessionStore,
 * where replay order (mono_ns, then sequence) and run_id / parent_request_id
 * correlation join them. Each producer gets its own LiveIngestClient.
 *
 * URL resolution per producer:
 * - http(s) URL with an empty path or "/": base URL -> fetch
 *   /.well-known/sonder-telemetry, then open sse, ndjson or websocket (in
 *   that order) unless a transport is forced;
 * - URL ending in /.well-known/sonder-telemetry: discovery URL, same flow;
 * - anything else: a stream URL, opened directly (the pre-discovery behaviour).
 *
 * Tokens: an optional bearer token per producer becomes
 * `Authorization: Bearer` on its HTTP requests only. It is kept in memory in
 * that producer's client, never put in a URL, never logged, never persisted,
 * and never exposed through list() (only `hasToken`). A token with a
 * ws(s) stream is refused.
 */
import type { ProducerDiscovery } from "../../protocol/discovery";
import type { ObservatoryEvent } from "../../protocol/events";
import { producerInstance } from "../../query/attributes";
import type { SessionStore } from "../../replay/session";
import type { WebSocketFactory } from "../../transport/live";
import { LiveIngestClient, type LiveIngestStatus } from "./client";
import { DEFAULT_DISCOVERY_TIMEOUT_MS, classifyProducerUrl, corsHint, fetchDiscovery, selectStream } from "./discovery";
import { isLoopbackHost, resolveEndpoint, type TransportPreference } from "./endpoint";
import { fetchProducerHealth, healthUrl, type ProducerHealth } from "./health";
import { NO_REDIRECTS, describeHttpFailure, isRedirect, type FetchLike } from "./transports";

export type { FetchLike } from "./transports";

export interface ProducerEndpointInput {
    url: string;
    /** Bearer token for this producer only (HTTP transports). */
    token?: string;
    transport?: TransportPreference;
    label?: string;
}

export interface ProducerIdentity {
    name: string;
    version: string;
    node_id: string;
    instance_id: string | null;
    role: string | null;
    synthetic: boolean;
}

export interface ProducerConnection {
    id: string;
    /** The URL as entered (base, discovery or stream URL). */
    url: string;
    label: string | null;
    hasToken: boolean;
    /** The stream actually opened, once known. */
    streamUrl: string | null;
    discovery: ProducerDiscovery | null;
    /** Discovery initially; then the latest wire-observed event's identity. */
    identity: ProducerIdentity | null;
    /**
     * Backends and capabilities from the discovery `links.health` document
     * (same origin only); null until fetched, or when there is none.
     */
    health: ProducerHealth | null;
    status: LiveIngestStatus;
}

export interface ProbeResult {
    ok: boolean;
    discovery: ProducerDiscovery | null;
    streamUrl: string | null;
    error: string | null;
    corsSuspected: boolean;
}

export interface ProbeOptions {
    token?: string;
    fetch?: FetchLike;
    timeoutMs?: number;
}

export interface LiveConnectionManagerOptions {
    /** Called after each batch lands in the store (e.g. to re-render). */
    onAppend?: (store: SessionStore) => void;
    fetch?: FetchLike;
    webSocketFactory?: WebSocketFactory;
    discoveryTimeoutMs?: number;
}

/** Well-known local producers (contract section 6 default ports). */
export const LOCAL_PRESETS: readonly { label: string; url: string; role: "runtime" | "inference" | "fixture" }[] = [
    { label: "Sonder Runtime (local)", url: "http://127.0.0.1:11435", role: "runtime" },
    { label: "Sonder-Inference (local)", url: "http://127.0.0.1:11437", role: "inference" },
    { label: "Fake live producer (synthetic)", url: "http://127.0.0.1:8766/sse", role: "fixture" },
];

const TOKEN_REFUSED_WS = "a bearer token cannot be sent over WebSocket; use the producer's SSE or NDJSON stream";

/** A usable bearer token: printable ASCII without spaces, at most 4 KiB. */
function tokenProblem(token: string): string | null {
    if (token.length > 4096) {
        return "the token is longer than 4 KiB";
    }
    if (!/^[\x21-\x7e]+$/.test(token)) {
        return "the token must be printable ASCII without spaces";
    }
    return null;
}

function normalizedToken(token: string | undefined): string | undefined {
    if (token === undefined) {
        return undefined;
    }
    const trimmed = token.trim();
    return trimmed === "" ? undefined : trimmed;
}

function loopbackOf(url: string): boolean {
    try {
        return isLoopbackHost(new URL(url).hostname);
    } catch {
        return false;
    }
}

function initialStatus(url: string): LiveIngestStatus {
    return {
        state: "connecting",
        url,
        transport: null,
        loopback: loopbackOf(url),
        warning: null,
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
        bufferCapacity: 0,
        batches: 0,
        lastError: null,
    };
}

function identityFromDiscovery(discovery: ProducerDiscovery): ProducerIdentity {
    const p = discovery.producer;
    return {
        name: p.name,
        version: p.version,
        node_id: p.node_id,
        instance_id: p.instance_id,
        role: p.role,
        synthetic: p.synthetic,
    };
}

function identityFromEvent(event: ObservatoryEvent): ProducerIdentity {
    const p = event.producer;
    return {
        name: p.name,
        version: p.version,
        node_id: p.node_id,
        instance_id: producerInstance(event),
        role: typeof p.role === "string" ? p.role : null,
        synthetic: p.synthetic === true,
    };
}

/** Only a resolved instance with matching producer and node proves continuity. */
function sameInstance(a: ProducerIdentity | null, b: ProducerIdentity): boolean {
    return a !== null && b.instance_id !== null && a.instance_id === b.instance_id
        && a.name === b.name && a.node_id === b.node_id;
}

/**
 * Asks an http(s) stream URL for its response headers and hangs up: enough to
 * tell a reachable stream from a 401/403/404, a redirect or a network (CORS)
 * failure without consuming events.
 */
async function probeHttpStream(
    url: string,
    kind: "sse" | "ndjson",
    token: string | undefined,
    opts: ProbeOptions,
): Promise<{ error: string | null; corsSuspected: boolean }> {
    const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    const timeoutMs = opts.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = {
        Accept: kind === "ndjson" ? "application/x-ndjson" : "text/event-stream",
        "Cache-Control": "no-store",
    };
    if (token !== undefined) {
        headers.Authorization = `Bearer ${token}`;
    }
    try {
        const response = await fetchImpl(url, { headers, signal: controller.signal, cache: "no-store", redirect: NO_REDIRECTS });
        if (isRedirect(response)) {
            return { error: describeHttpFailure(response.type === "opaqueredirect" ? 0 : response.status), corsSuspected: false };
        }
        if (!response.ok) {
            return { error: describeHttpFailure(response.status), corsSuspected: false };
        }
        return { error: null, corsSuspected: false };
    } catch (error) {
        if ((error as { name?: string })?.name === "AbortError") {
            return { error: `no answer from ${url} within ${timeoutMs} ms`, corsSuspected: false };
        }
        return {
            error: `could not reach ${url} (${(error as Error)?.message ?? String(error)}); ${corsHint()}`,
            corsSuspected: true,
        };
    } finally {
        clearTimeout(timer);
        // Hang up once the headers are in: the probe never reads events.
        controller.abort();
    }
}

/**
 * Checks a producer URL without ingesting events: validates the URL policy,
 * fetches and validates the discovery document for base and discovery URLs
 * and reports the stream that would be opened. An http(s) stream URL is
 * requested and dropped as soon as its response headers arrive; a ws(s)
 * stream URL is only checked against the policy (it is not contacted).
 * Never throws.
 */
export async function probeProducer(url: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
    const token = normalizedToken(opts.token);
    const fail = (error: string, corsSuspected = false, discovery: ProducerDiscovery | null = null): ProbeResult => ({
        ok: false,
        discovery,
        streamUrl: null,
        error,
        corsSuspected,
    });
    const problem = token !== undefined ? tokenProblem(token) : null;
    if (problem !== null) {
        return fail(problem);
    }
    const classified = classifyProducerUrl(url);
    if (!classified.ok || classified.kind === null) {
        return fail(classified.message ?? "invalid URL");
    }
    if (classified.kind === "stream") {
        const endpoint = resolveEndpoint(url);
        if (!endpoint.ok) {
            return fail(endpoint.message ?? "invalid stream URL");
        }
        if (endpoint.kind === "websocket" && token !== undefined) {
            return fail(TOKEN_REFUSED_WS);
        }
        if (endpoint.kind === "sse" || endpoint.kind === "ndjson") {
            const probed = await probeHttpStream(url, endpoint.kind, token, opts);
            if (probed.error !== null) {
                return fail(probed.error, probed.corsSuspected);
            }
        }
        return { ok: true, discovery: null, streamUrl: url, error: null, corsSuspected: false };
    }
    const fetched = await fetchDiscovery(classified.discoveryUrl!, { token, fetch: opts.fetch, timeoutMs: opts.timeoutMs });
    if (!fetched.ok || !fetched.discovery) {
        return fail(fetched.error ?? "discovery failed", fetched.corsSuspected);
    }
    const selected = selectStream(fetched.discovery, classified.discoveryUrl!, { hasToken: token !== undefined });
    if (!selected.ok) {
        return fail(selected.message ?? "no usable stream", false, fetched.discovery);
    }
    return { ok: true, discovery: fetched.discovery, streamUrl: selected.url, error: null, corsSuspected: false };
}

interface Entry {
    connection: ProducerConnection;
    client: LiveIngestClient | null;
    unsubscribe: (() => void) | null;
    removed: boolean;
}

function snapshot(connection: ProducerConnection): ProducerConnection {
    return {
        ...connection,
        identity: connection.identity ? { ...connection.identity } : null,
        status: { ...connection.status },
    };
}

export class LiveConnectionManager {
    private readonly store: SessionStore;
    private readonly options: LiveConnectionManagerOptions;
    private readonly entries = new Map<string, Entry>();
    private readonly listeners = new Set<(connections: readonly ProducerConnection[]) => void>();
    private counter = 0;

    constructor(store: SessionStore, options: LiveConnectionManagerOptions = {}) {
        this.store = store;
        this.options = options;
    }

    /**
     * Adds a producer: resolves the URL (discovery for base URLs), then opens
     * one LiveIngestClient streaming into the shared store. Resolves once the
     * stream is started (not necessarily open). Network, policy and discovery
     * errors yield a connection in state "failed" with a readable lastError;
     * this method never throws.
     */
    async add(input: ProducerEndpointInput): Promise<ProducerConnection> {
        const id = `producer-${++this.counter}`;
        const token = normalizedToken(input.token);
        const entry: Entry = {
            connection: {
                id,
                url: input.url,
                label: input.label ?? null,
                hasToken: token !== undefined,
                streamUrl: null,
                discovery: null,
                identity: null,
                health: null,
                status: initialStatus(input.url),
            },
            client: null,
            unsubscribe: null,
            removed: false,
        };
        this.entries.set(id, entry);
        this.notify();
        try {
            await this.connect(entry, input, token);
        } catch (error) {
            this.fail(entry, `unexpected error: ${(error as Error)?.message ?? String(error)}`);
        }
        return snapshot(entry.connection);
    }

    /** Stops a producer's stream. Events already received stay in the store. */
    async remove(id: string): Promise<void> {
        const entry = this.entries.get(id);
        if (!entry) {
            return;
        }
        entry.removed = true;
        entry.unsubscribe?.();
        entry.unsubscribe = null;
        const client = entry.client;
        entry.client = null;
        this.entries.delete(id);
        if (client) {
            await client.stop();
        }
        this.updateSourceLabel();
        this.notify();
    }

    async disconnectAll(): Promise<void> {
        await Promise.all([...this.entries.keys()].map((id) => this.remove(id)));
    }

    list(): ProducerConnection[] {
        return [...this.entries.values()].map((e) => snapshot(e.connection));
    }

    /** Subscribes to connection changes; the listener is called immediately. */
    subscribe(listener: (connections: readonly ProducerConnection[]) => void): () => void {
        this.listeners.add(listener);
        listener(this.list());
        return () => {
            this.listeners.delete(listener);
        };
    }

    // --- internals ------------------------------------------------------------

    private async connect(entry: Entry, input: ProducerEndpointInput, token: string | undefined): Promise<void> {
        const problem = token !== undefined ? tokenProblem(token) : null;
        if (problem !== null) {
            this.fail(entry, problem);
            return;
        }
        const classified = classifyProducerUrl(input.url);
        if (!classified.ok || classified.kind === null) {
            this.fail(entry, classified.message ?? "invalid URL");
            return;
        }
        let streamUrl = input.url;
        let transport: TransportPreference = input.transport ?? "auto";
        if (classified.kind !== "stream") {
            const fetched = await fetchDiscovery(classified.discoveryUrl!, {
                token,
                fetch: this.options.fetch,
                timeoutMs: this.options.discoveryTimeoutMs,
            });
            if (entry.removed) {
                return;
            }
            if (!fetched.ok || !fetched.discovery) {
                this.fail(entry, fetched.error ?? "discovery failed");
                return;
            }
            entry.connection.discovery = fetched.discovery;
            entry.connection.identity = identityFromDiscovery(fetched.discovery);
            void this.loadHealth(entry, classified.discoveryUrl!, fetched.discovery.links?.health, token);
            const selected = selectStream(fetched.discovery, classified.discoveryUrl!, {
                transport: input.transport,
                hasToken: token !== undefined,
            });
            if (!selected.ok || selected.url === null || selected.transport === null) {
                this.fail(entry, selected.message ?? "no usable stream");
                return;
            }
            streamUrl = selected.url;
            transport = selected.transport;
        }
        entry.connection.streamUrl = streamUrl;
        // Same checks the client applies in start(), made here so that a
        // refused stream fails before the store is touched.
        const endpoint = resolveEndpoint(streamUrl, transport);
        if (!endpoint.ok || endpoint.kind === null) {
            this.fail(entry, endpoint.message ?? "invalid stream URL");
            return;
        }
        if (endpoint.kind === "websocket" && token !== undefined) {
            this.fail(entry, TOKEN_REFUSED_WS);
            return;
        }

        const client = new LiveIngestClient({
            url: streamUrl,
            transport,
            headers: token !== undefined ? { Authorization: `Bearer ${token}` } : undefined,
            // Discovery (if any) already ran above; streamUrl is the stream itself.
            discover: false,
            fetch: this.options.fetch,
            webSocketFactory: this.options.webSocketFactory,
            sink: {
                append: (events) => {
                    this.store.append(events);
                    this.observeIdentity(entry, events);
                    this.options.onAppend?.(this.store);
                },
                addRejected: (lines) => this.store.addRejected(lines),
            },
        });
        entry.client = client;
        entry.unsubscribe = client.subscribe((status) => {
            if (!entry.removed) {
                entry.connection.status = status;
                this.notify();
            }
        });
        // Only now, with the stream about to open, does a non-live store (a
        // loaded recording or fixture) give way to the live session: a failed
        // or refused add() leaves whatever the viewer had loaded untouched.
        this.ensureLiveStore(streamUrl);
        this.updateSourceLabel();
        client.start();
    }

    /** Fetches the optional health document; failures are silent (in-stream backend.registered still works). */
    private async loadHealth(entry: Entry, discoveryUrl: string, link: unknown, token: string | undefined): Promise<void> {
        const url = healthUrl(discoveryUrl, link);
        if (url === null) {
            return;
        }
        const health = await fetchProducerHealth(url, { token, fetch: this.options.fetch, timeoutMs: this.options.discoveryTimeoutMs });
        if (health !== null && !entry.removed) {
            entry.connection.health = health;
            this.notify();
        }
    }

    private fail(entry: Entry, message: string): void {
        if (entry.removed) {
            return;
        }
        entry.connection.status = { ...entry.connection.status, state: "failed", lastError: message, retryInMs: null };
        this.notify();
    }

    /**
     * Resets the store to a live source once, when the first producer's
     * stream is about to open over a non-live source.
     */
    private ensureLiveStore(url: string): void {
        if (this.store.source !== "live") {
            this.store.reset("live", url);
        }
    }

    private updateSourceLabel(): void {
        if (this.store.source !== "live") {
            return;
        }
        const urls = [...this.entries.values()]
            .map((e) => e.connection.streamUrl)
            .filter((u): u is string => u !== null);
        if (urls.length > 0) {
            this.store.sourceLabel = urls.join(" + ");
        }
    }

    /** Observe original wire order, independently of store sorting, dedup and retention. */
    private observeIdentity(entry: Entry, events: readonly ObservatoryEvent[]): void {
        const last = events[events.length - 1];
        if (!last) {
            return;
        }
        const seen = identityFromEvent(last);
        const current = entry.connection.identity;
        const discovery = entry.connection.discovery === null ? null : identityFromDiscovery(entry.connection.discovery);
        const previous = sameInstance(current, seen) ? current : null;
        const matchingDiscovery = sameInstance(discovery, seen) ? discovery : null;
        if (seen.instance_id !== null) {
            seen.synthetic ||= previous?.synthetic === true || matchingDiscovery?.synthetic === true
                || events.some((event) => event.producer.synthetic === true
                    && event.producer.name === seen.name && event.producer.node_id === seen.node_id
                    && producerInstance(event) === seen.instance_id);
            // A missing role is not a new role declaration; carry it only within a proven key.
            seen.role ??= previous?.role ?? matchingDiscovery?.role ?? null;
        }
        entry.connection.identity = seen;
    }

    private notify(): void {
        if (this.listeners.size === 0) {
            return;
        }
        const connections = this.list();
        for (const listener of this.listeners) {
            listener(connections);
        }
    }
}
