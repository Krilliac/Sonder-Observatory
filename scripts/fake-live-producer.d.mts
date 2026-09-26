// Types for scripts/fake-live-producer.mjs so TypeScript tests can import it.
export interface FakeLiveProducerOptions {
    /** Events to serve; default loads `file` (or the synthetic fixture). */
    events?: Record<string, unknown>[];
    file?: string;
    /** Default 127.0.0.1. */
    host?: string;
    /** Default 0 (ephemeral port) when imported; 8766 from the CLI. */
    port?: number;
    /** "burst" (default when imported) sends as fast as possible; "timeline" follows mono_ns. */
    pace?: "burst" | "timeline";
    /** Timeline speed multiplier. Default 1. */
    speed?: number;
    /** Max events per WebSocket frame / HTTP write. Default 1 (64 from the CLI). */
    batch?: number;
    /** Hard-close each connection after sending this many events (0 = never). */
    disconnectAfter?: number;
    /** Honour Last-Event-ID / ?last_event_id. Default true. */
    resume?: boolean;
    /** Replay forever as new sessions. Default false. */
    loop?: boolean;
    /** SSE `retry:` hint in ms. Default 1000. */
    retryMs?: number;
    /**
     * Relabel the events as a producer of this role (name, role, a fresh
     * instance_id, contiguous sequences, event_id = instance-sequence).
     * Default: serve the events unchanged.
     */
    role?: FakeProducerRole;
    /** Instance id to use instead of a random one. */
    instanceId?: string;
    /** Require `Authorization: Bearer <token>` on every route but the preflight. */
    token?: string;
    /** Read the bearer token from this file (max 4 KiB, trimmed). */
    tokenFile?: string;
    /** SSE `: keepalive` / NDJSON blank-line heartbeat interval. Default 15000. */
    heartbeatMs?: number;
    log?: (message: string) => void;
}

export type FakeProducerRole = "runtime" | "inference" | "fixture";

export interface FakeProducerIdentity {
    name: string;
    version: string;
    node_id: string;
    instance_id: string;
    role: FakeProducerRole;
    synthetic: true;
}

export interface FakeLiveProducerStats {
    connections: number;
    /** Last-event ids that resumed a replay, in order. */
    resumed: string[];
    sent: number;
    byTransport: { websocket: number; sse: number; ndjson: number };
    /** Discovery documents served. */
    discovery: number;
    /** Requests refused for a missing or wrong bearer token. */
    unauthorized: number;
}

export interface FakeLiveProducer {
    port: number;
    events: Record<string, unknown>[];
    stats: FakeLiveProducerStats;
    instanceId: string;
    /** The producer block served in discovery. */
    producer: FakeProducerIdentity;
    urls: { base: string; discovery: string; websocket: string; sse: string; ndjson: string };
    dropConnections(): void;
    close(): Promise<void>;
}

export const DEFAULT_FIXTURE: string;
export const DISCOVERY_PATH: string;
export const ROLE_MODES: Record<FakeProducerRole, { name: string | null; prefix: string; hexBytes: number }>;
export function loadEvents(file?: string): Record<string, unknown>[];
export function readTokenFile(path: string): string;
export function relabelForRole(
    events: Record<string, unknown>[],
    role: FakeProducerRole,
    instanceId: string,
): Record<string, unknown>[];
export function startFakeLiveProducer(options?: FakeLiveProducerOptions): Promise<FakeLiveProducer>;
