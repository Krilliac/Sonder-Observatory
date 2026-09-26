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
- Declared types are enforced. The envelope's optional
  `producer.instance_id`, `role` and `synthetic` were undeclared additional
  properties before live producer protocol v1; the schema now declares them
  (non-empty string, string, boolean), each also accepting `null` for "not
  stated". An event carrying one of them with another type is rejected. This
  is a deliberate v1 tightening that producers must honour, recorded in
  docs/DECISIONS.md.
- Closed enums in discovery: `producer.role` (`inference`, `runtime`,
  `fixture`) and `auth.schemes` (`bearer`) are enums pinned by the ecosystem
  contract, so a v1 consumer refuses a document with any other value. A new
  producer role or auth scheme therefore needs `sonder.telemetry.producer/2`
  unless the owners relax these to open strings (open question in
  docs/DECISIONS.md). The envelope's `producer.role`, by contrast, keeps
  unknown values.
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
