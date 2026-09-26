# Protocol workspace

Observatory owns the telemetry shapes in this directory. They are the source
of truth; the TypeScript under `src/protocol/` mirrors them by hand and drift
tests fail if a mirror and its schema diverge. Change the schema here first,
then the mirror, then the consumers.

| Schema | Id | Mirror | Drift test |
|---|---|---|---|
| [Event envelope](observatory-events.schema.json) | `sonder.observatory.event/1` | `src/protocol/events.ts`, `src/protocol/validate.ts` | `tests/protocol-schema-drift.test.ts` |
| [Producer discovery](producer-discovery.schema.json) | `sonder.telemetry.producer/1` | `src/protocol/discovery.ts` | `tests/protocol-discovery-drift.test.ts` |

The prose reference for both, including the live producer protocol (discovery,
SSE/NDJSON framing, resume, backpressure, auth, CORS and correlation), is
[docs/TELEMETRY_PROTOCOL.md](../docs/TELEMETRY_PROTOCOL.md).

## Ownership

- Observatory owns the envelope and the discovery document shapes above.
  Changes are additive within a major version; a rename or removal needs a
  new major (`/2`) and lands here before any producer or consumer uses it.
- Each producer owns the documentation of its own event vocabulary (event
  types and attributes): Sonder-Inference in its `docs/TELEMETRY.md`, Sonder
  Runtime in its `docs/architecture/observatory-telemetry.md`.
  [docs/telemetry-schema.md](../docs/telemetry-schema.md) records what
  Observatory reads from each vocabulary and at which producer revision it
  was checked.
- Observatory consumes telemetry only; it owns no producer instrumentation.

Shared generated bindings for the producers remain unresolved; producers
implement these shapes from the schema files, and the conformance suite
(`tests/conformance/`) checks a running producer against them.
