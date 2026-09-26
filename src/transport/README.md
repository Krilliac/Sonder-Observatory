# Transport

Responsibility: Telemetry connection, negotiation, reconnect, and loss reporting.

The renderer connects through [`src/ingest/live`](../ingest/live/) (WebSocket,
SSE or NDJSON over HTTP, with reconnect, resume and drop accounting; see
[live ingest notes](../../docs/integration/live-ingest.md)).

- `live.ts` is the original one-shot WebSocket client (`LiveConnection`,
  `checkEndpoint`). It is kept because `src/ingest/live` imports its
  `WebSocketLike` / `WebSocketFactory` types and the renderer uses
  `DEFAULT_ENDPOINT`. `LiveConnection` itself is no longer used by the UI and
  can be removed once those types move.

Negotiation and capability tokens are not implemented because the producer
contract is unresolved. See [source workspace](../README.md).
