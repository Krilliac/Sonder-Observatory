# Inspector

Responsibility: Resolve displayed values to source events and measurement provenance.

- `inspector.ts` renders the envelope, producer (name, version, role,
  instance, node), sampling and raw attributes of a selected event, and
  whether it is synthetic or producer-reported.
- `related.ts` finds correlated events: `relatedGroups` returns the same
  tool call, the same request, the parent request
  (`attributes.parent_request_id`), child requests (requests whose events
  name this request in `parent_request_id`), the same run and the same agent
  (contract section 8.4). Requests are keyed by (producer stream, request_id)
  like metrics, so equal request ids from two producers are not related by
  themselves; producers are joined only where `parent_request_id` or
  `run_id` states the link (a parent or child from a different run is
  refused). `relatedEvents` keeps the single most specific group.

DOM hooks: `[data-testid=related-events]` with items
`[data-testid=related-event][data-producer=<producer.name>]`.

See [source workspace](../README.md).
