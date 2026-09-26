# Tests

Vitest unit tests (`npm test`). They cover the envelope validator and its
drift against `protocol/observatory-events.schema.json`, fixture parsing and
reproducibility, replay ordering/dedupe/gaps and the cursor, metric
derivation, the `.sobs` recording round trip, the WebSocket client (with a fake
socket), and design-token resolution.

There are no browser/UI or end-to-end tests yet.
