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
    /** Max events per WebSocket frame / HTTP write. Default 1. */
    batch?: number;
    /** Hard-close each connection after sending this many events (0 = never). */
    disconnectAfter?: number;
    /** Honour Last-Event-ID / ?last_event_id. Default true. */
    resume?: boolean;
    /** Replay forever as new sessions. Default false. */
    loop?: boolean;
    /** SSE `retry:` hint in ms. Default 1000. */
    retryMs?: number;
    log?: (message: string) => void;
}

export interface FakeLiveProducerStats {
    connections: number;
    /** Last-event ids that resumed a replay, in order. */
    resumed: string[];
    sent: number;
    byTransport: { websocket: number; sse: number; ndjson: number };
}

export interface FakeLiveProducer {
    port: number;
    events: Record<string, unknown>[];
    stats: FakeLiveProducerStats;
    urls: { websocket: string; sse: string; ndjson: string };
    dropConnections(): void;
    close(): Promise<void>;
}

export const DEFAULT_FIXTURE: string;
export function loadEvents(file?: string): Record<string, unknown>[];
export function startFakeLiveProducer(options?: FakeLiveProducerOptions): Promise<FakeLiveProducer>;
