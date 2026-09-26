# Protocol workspace

The existing [event schema](observatory-events.schema.json) and
[protocol notes](../docs/TELEMETRY_PROTOCOL.md) are the current design artifacts
and the source of truth. Milestone 1 does not revise the schema.

`src/protocol/` contains a TypeScript mirror of this schema and a runtime
validator for the viewer. It is not a competing envelope:
`tests/protocol-schema-drift.test.ts` fails if the mirror and this schema
diverge. Change the schema here first.

Protocol package ownership, compatibility/versioning policy, and shared
generated bindings remain unresolved with Sonder Runtime and Sonder-Inference.
No network service is implemented here.
