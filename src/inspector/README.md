# Inspector

Responsibility: Resolve displayed values to source events and measurement provenance.

- `inspector.ts` renders the envelope, producer (name, version, role,
  instance, node), sampling and raw attributes of a selected event, and
  whether it is synthetic or producer-reported.
- `related.ts` finds correlated events across producers: `relatedGroups`
  returns the same tool call, same request, the parent request
  (`attributes.parent_request_id`), child requests (events whose
  `parent_request_id` is this request), the same run and the same agent
  (contract section 8.4); `relatedEvents` keeps the single most specific
  group.

DOM hooks: `[data-testid=related-events]` with items
`[data-testid=related-event][data-producer=<producer.name>]`.

See [source workspace](../README.md).
