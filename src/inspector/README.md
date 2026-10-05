# Inspector

Responsibility: Resolve displayed values to source events and measurement provenance.

- `inspector.ts` renders the envelope, producer (name, version, role,
  instance, node), sampling and raw attributes of a selected event, and
  whether it is synthetic or producer-reported. When the event carries an
  `attributes.sampling` object it also lists the sampler settings, showing a
  null field (and `num_ctx: 0`) as "model default"; when the event's request
  has a backend prompt-cache or speculative-decoding report (the
  `requestSpan` callback) it shows cached / evaluated prompt tokens and
  accepted / drafted tokens. The raw attributes stay exactly as received.
  The sampler-settings section is not limited to new producers: any event
  with an `attributes.sampling` object gets it, including existing
  Sonder-Inference recordings (2 events of
  `tests/fixtures/sonder-inference-912503a.jsonl`, 4 of
  `sonder-inference-b2170c0.jsonl`). It adds a section; it changes no metric.
  The request lookup covers the whole session, like the related events.
- `related.ts` finds correlated events: `relatedGroups` returns the same
  tool call, the same request, the parent request
  (`attributes.parent_request_id`), child requests (requests whose events
  name this request in `parent_request_id`), the same run and the same agent
  (contract section 8.4). Requests are keyed by (producer stream, request_id)
  like metrics, so equal request ids from two producers are not related by
  themselves; producers are joined only where `parent_request_id` or
  `run_id` states the link (a parent or child from a different run is
  refused). `relatedEvents` keeps the single most specific group.
  Selecting an output, scheduler or KV event also resolves parent evidence
  reported on another event of the same producer-scoped request; the raw
  selected event is never changed. Conflicting observed parent IDs or run
  IDs withhold the Parent request group, leaving the evidence in Same request.
  Known request runs exclude parent events from other runs; absent runs do
  not prove a conflict. Multiple compatible parent instances are shown as
  evidence candidates rather than silently picking one. Ordered store arrays
  use the existing correlation index; unmarked arrays use the same scan rules.
  Compatible per-event parent evidence can still be listed when another event
  of that parent reports a conflicting run; the 3D view withholds a line to
  such a conflicted entity.

DOM hooks: `[data-testid=related-events]` with items
`[data-testid=related-event][data-producer=<producer.name>]`,
`[data-testid=sampler-settings]` (rows `dd[data-model-default]` for model
defaults) and `[data-testid=request-reuse]`.

See [source workspace](../README.md).
