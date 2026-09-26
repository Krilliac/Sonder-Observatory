# Inspector

Responsibility: Resolve displayed values to source events and measurement provenance.

- `inspector.ts` renders the envelope, producer, sampling and raw attributes of
  a selected event, and whether it is synthetic or producer-reported.
- `related.ts` finds correlated events (tool call, request, agent).

See [source workspace](../README.md).
