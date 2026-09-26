/**
 * Live telemetry client over WebSocket.
 *
 * Wire format (Milestone 1): each text frame carries one protocol event as
 * JSON, or several events as NDJSON lines. There is no handshake, resume or
 * capability-token exchange yet because the producer contract for those is
 * not settled with Sonder Runtime / Sonder-Inference (docs/INTEGRATION.md).
 * A token may be passed in the URL query if a producer requires it.
 */
import type { ObservatoryEvent } from "../protocol/events";
import { parseNdjson, type RejectedLine } from "../recording/ndjson";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export interface WebSocketLike {
    readyState: number;
    onopen: ((ev: unknown) => void) | null;
    onclose: ((ev: { code: number; reason: string }) => void) | null;
    onerror: ((ev: unknown) => void) | null;
    onmessage: ((ev: { data: unknown }) => void) | null;
    close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface LiveHandlers {
    onEvents(events: ObservatoryEvent[]): void;
    onRejected?(rejected: RejectedLine[]): void;
    onState?(state: ConnectionState, detail?: string): void;
}

export const DEFAULT_ENDPOINT = "ws://127.0.0.1:8765";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export interface EndpointCheck {
    ok: boolean;
    loopback: boolean;
    message?: string;
}

/** Validates a ws:// or wss:// URL and reports whether it is loopback-only. */
export function checkEndpoint(url: string): EndpointCheck {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return { ok: false, loopback: false, message: "not a valid URL" };
    }
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        return { ok: false, loopback: false, message: "must use ws:// or wss://" };
    }
    const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
    return {
        ok: true,
        loopback,
        message: loopback
            ? undefined
            : "remote endpoint: telemetry may be sensitive; use wss:// and an authenticated producer",
    };
}

export class LiveConnection {
    private socket: WebSocketLike | null = null;
    private stateValue: ConnectionState = "disconnected";
    private readonly factory: WebSocketFactory;
    private readonly handlers: LiveHandlers;
    received = 0;
    rejected = 0;

    constructor(handlers: LiveHandlers, factory?: WebSocketFactory) {
        this.handlers = handlers;
        this.factory =
            factory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    }

    get state(): ConnectionState {
        return this.stateValue;
    }

    private setState(state: ConnectionState, detail?: string): void {
        this.stateValue = state;
        this.handlers.onState?.(state, detail);
    }

    connect(url: string): void {
        const check = checkEndpoint(url);
        if (!check.ok) {
            this.setState("error", check.message);
            return;
        }
        this.disconnect();
        this.setState("connecting", url);
        let socket: WebSocketLike;
        try {
            socket = this.factory(url);
        } catch (error) {
            this.setState("error", (error as Error).message);
            return;
        }
        this.socket = socket;
        socket.onopen = () => {
            if (this.socket === socket) {
                this.setState("connected", url);
            }
        };
        socket.onerror = () => {
            if (this.socket === socket) {
                this.setState("error", "WebSocket error");
            }
        };
        socket.onclose = (ev) => {
            if (this.socket === socket) {
                this.socket = null;
                this.setState("disconnected", ev.reason || `closed (${ev.code})`);
            }
        };
        socket.onmessage = (ev) => {
            if (this.socket === socket) {
                this.handleFrame(ev.data);
            }
        };
    }

    disconnect(): void {
        const socket = this.socket;
        if (!socket) {
            return;
        }
        this.socket = null;
        socket.close(1000, "client disconnect");
        this.setState("disconnected", "client disconnect");
    }

    handleFrame(data: unknown): void {
        if (typeof data !== "string") {
            this.rejected += 1;
            this.handlers.onRejected?.([
                { line: 1, reason: "binary frames are not supported", raw: "" },
            ]);
            return;
        }
        const parsed = parseNdjson(data);
        if (parsed.events.length > 0) {
            this.received += parsed.events.length;
            this.handlers.onEvents(parsed.events);
        }
        if (parsed.rejected.length > 0) {
            this.rejected += parsed.rejected.length;
            this.handlers.onRejected?.(parsed.rejected);
        }
    }
}
