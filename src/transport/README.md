# Transport

Responsibility: Telemetry connection, negotiation, reconnect, and loss reporting.

- `live.ts` connects/disconnects a WebSocket (configurable URL, loopback by
  default), accepts JSON or NDJSON text frames, and reports rejected frames.

Negotiation, capability tokens, and reconnect/resume are not implemented
because the producer contract is unresolved. See [source workspace](../README.md).
