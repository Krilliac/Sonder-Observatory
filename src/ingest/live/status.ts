/**
 * Presentation helper for a connection-status indicator. Pure so the
 * renderer can bind it to any element (see docs/integration/live-ingest.md).
 */
import type { LiveIngestStatus } from "./client";

export type StatusTone = "idle" | "ok" | "warn" | "error";

export interface StatusView {
    /** Short badge text, e.g. "live · ws" or "reconnecting in 2.0 s". */
    label: string;
    tone: StatusTone;
    /** Longer tooltip text with counters. */
    detail: string;
}

const TRANSPORT_LABEL = { websocket: "ws", sse: "sse", ndjson: "ndjson" } as const;

export function describeStatus(status: LiveIngestStatus): StatusView {
    const via = status.transport ? ` · ${TRANSPORT_LABEL[status.transport]}` : "";
    const counters =
        `received ${status.received}, appended ${status.appended}, buffered ${status.buffered}/${status.bufferCapacity}, ` +
        `dropped ${status.dropped}, rejected ${status.rejected}, reconnects ${status.reconnects}`;
    const extras = [
        status.lastError ? `last error: ${status.lastError}` : null,
        status.warning,
        status.resumeRequested && status.lastEventId ? `resumed after ${status.lastEventId}` : null,
    ].filter((x): x is string => x !== null);
    const detail = [status.url, counters, ...extras].join("\n");
    switch (status.state) {
        case "idle":
            return { label: "not connected", tone: "idle", detail };
        case "connecting":
            return { label: `connecting${via}`, tone: "warn", detail };
        case "open":
            return {
                label: status.dropped > 0 ? `live${via} · ${status.dropped} dropped` : `live${via}`,
                tone: status.dropped > 0 || status.warning ? "warn" : "ok",
                detail,
            };
        case "reconnecting":
            return {
                label:
                    status.retryInMs !== null
                        ? `reconnecting in ${(status.retryInMs / 1000).toFixed(1)} s`
                        : `reconnecting${via}`,
                tone: "warn",
                detail,
            };
        case "closed":
            return { label: "disconnected", tone: "idle", detail };
        case "failed":
            return { label: "connection failed", tone: "error", detail };
    }
}
