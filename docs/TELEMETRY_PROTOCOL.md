# Telemetry Protocol

## Goals

The protocol must be:

- versioned
- append-friendly
- replayable
- transport-neutral
- backend-neutral
- cheap to emit
- explicit about missing/estimated fields
- safe to run without raw prompt capture

## Envelope

Every event carries a common envelope:

```json
{
  "schema": "sonder.observatory.event/1",
  "event_id": "01J...",
  "sequence": 1842,
  "event_type": "inference.token.generated",
  "wall_time": "2026-09-26T05:00:00.123456Z",
  "mono_ns": 9172231234,
  "session_id": "ses_...",
  "run_id": "run_...",
  "request_id": "req_...",
  "producer": {
    "name": "sonder-inference",
    "version": "0.1.0",
    "node_id": "main"
  },
  "sampling": {
    "level": "standard",
    "sampled": true
  },
  "attributes": {}
}
```

Optional correlation IDs:

- agent_id
- task_id
- model_instance_id
- device_id
- span_id / parent_span_id
- tool_call_id
- context_id
- kv_segment_id

## Event taxonomy

### Session/request

- `session.started`
- `session.ended`
- `request.queued`
- `request.started`
- `request.completed`
- `request.cancelled`
- `request.failed`

### Inference

- `inference.prefill.started`
- `inference.prefill.chunk`
- `inference.prefill.completed`
- `inference.decode.started`
- `inference.token.generated`
- `inference.sampling.candidates` (optional/high volume)
- `inference.decode.completed`
- `inference.speculation.draft`
- `inference.speculation.accepted`
- `inference.speculation.rejected`

#### Tokens versus chunks

`inference.token.generated` reports visible output. Its `attributes.unit` says
what one event is:

- `"token"`: exactly `count` tokens (default 1). Only these events are token
  counts (Sonder-Inference emits them when it samples tokens itself, with
  `token_id` and `probability`).
- `"chunk"` (or any other non-`token` unit): a piece of backend-streamed text
  whose token count is unknown. Hidden reasoning ("thinking") tokens produce no
  chunk at all, so the number of chunk events says nothing about how many
  tokens were generated.
- no `unit`: read as `count` tokens (default 1) for producers that predate
  the attribute (the synthetic fixture, Sonder-Inference before `912503a`).

Authoritative counts arrive when the request ends: `request.completed`
`completion_tokens` with `token_counts_from_backend: true`, `chunks`, `ttft_ms`
(first visible output) and `total_ms`, and `inference.decode.completed`
`backend_eval_ms` (backend decode time, covering hidden tokens). Observatory
therefore takes a request's token count from the backend when reported and
from `unit: "token"` events otherwise, and never counts chunks. The token rate
divides by decode time (`backend_eval_ms`, else `total_ms - ttft_ms`, else
first output to the end of the request), never by session wall time.
`sampling.sampled` is not used to tell tokens from chunks: producers set it to
`true` on every event.

### Model/backend

- `model.load.started`
- `model.load.completed`
- `model.unload`
- `model.adapter.attached`
- `model.adapter.detached`
- `backend.operator.started` (deep mode)
- `backend.operator.completed` (deep mode)
- `backend.layer.entered` (only if meaningful/exposed)
- `backend.layer.exited`

### Context / KV

- `context.created`
- `context.appended`
- `context.compaction.started`
- `context.compaction.completed`
- `context.forked`
- `kv.allocated`
- `kv.reused`
- `kv.evicted`
- `kv.moved`
- `kv.quantized`
- `kv.pressure`

### Scheduler/device

- `scheduler.enqueued`
- `scheduler.admitted`
- `scheduler.preempted`
- `scheduler.batch.formed`
- `scheduler.batch.completed`
- `device.memory.sample`
- `device.compute.sample`
- `device.transfer.started`
- `device.transfer.completed`

### Sonder orchestration

- `agent.spawned`
- `agent.started`
- `agent.message`
- `agent.completed`
- `agent.cancelled`
- `route.selected`
- `route.changed`
- `memory.retrieval.started`
- `memory.retrieval.completed`
- `tool.called`
- `tool.completed`
- `tool.failed`
- `retry.scheduled`
- `recovery.action`
- `guard.no_progress`
- `guard.duplicate_work`
- `guard.budget_pressure`

### Recorder/telemetry

- `telemetry.dropped`
- `telemetry.level.changed`
- `recording.started`
- `recording.rotated`
- `recording.completed`

## Text and sensitive payloads

Raw prompt/output/tool payloads are not required for the event graph.

Recommended fields:

```json
{
  "text_capture": "none|hash|redacted|full",
  "token_id": 1234,
  "token_text": null,
  "content_hash": "sha256:..."
}
```

Full text capture should be an explicit session policy.

## Counters vs events

Use counters/gauges for high-frequency resource state and events for state transitions. Observatory may derive periodic samples from cumulative counters.

## Compatibility

- additive unknown fields are ignored
- unknown event types remain visible as generic events
- breaking semantic changes increment the major schema version
- producers advertise capability flags at session start
- recordings preserve the exact producer/schema versions

## Live producer protocol v1

How a running producer (Sonder Runtime, Sonder-Inference, the fake producer)
serves telemetry to Observatory. Observatory owns these shapes:
`protocol/producer-discovery.schema.json` (discovery) and
`protocol/observatory-events.schema.json` (envelope, additive producer
fields). Producers implement them; `tests/conformance/` checks a running
producer (see tests/README.md). Observatory connects to each producer directly
and correlates their events itself; no producer relays another's telemetry.

### Discovery

`GET /.well-known/sonder-telemetry` returns `application/json`:

```json
{
  "schema": "sonder.telemetry.producer/1",
  "producer": {
    "name": "sonder-inference",
    "version": "0.1.0",
    "node_id": "host",
    "instance_id": "tel-cd5730d4b371a49d",
    "role": "inference",
    "synthetic": false
  },
  "event_schema": "sonder.observatory.event/1",
  "streams": [
    { "transport": "sse", "url": "/v1/telemetry/sse" },
    { "transport": "ndjson", "url": "/v1/telemetry/ndjson" }
  ],
  "resume": {
    "header": "Last-Event-ID",
    "query": "last_event_id",
    "retained_events": 8192,
    "oldest_sequence": 0,
    "next_sequence": 8192
  },
  "auth": { "required": false, "schemes": ["bearer"] },
  "clock": { "mono_ns": "host-monotonic" },
  "sampling_level": "standard",
  "text_capture": "off",
  "links": { "health": "/v1/sonder/health" },
  "vocabularies": { "sonder.inference.events": 1 }
}
```

- Required: `schema`, `producer` (all six fields), `event_schema`, `streams`
  (at least one), `resume`, `auth`, `clock`. `role` is `inference`, `runtime`
  or `fixture` and `auth.schemes` lists only `bearer`: in v1 both are closed
  enums, so a document with another role or scheme is refused as a whole, and
  adding a value needs `sonder.telemetry.producer/2` (an open question for the
  owners, see docs/DECISIONS.md). Optional: `sampling_level`, `text_capture`, `links`,
  `vocabularies` (event-vocabulary majors, e.g. `{"sonder.runtime.events": 1}`).
- Stream URLs are absolute or relative to the discovery URL.
- Unknown keys are allowed everywhere and ignored.
- Observatory refuses a document whose `schema` is not
  `sonder.telemetry.producer/1` (another major) or whose `event_schema` is not
  `sonder.observatory.event/1`, and says so; the user can still enter a stream
  URL directly.
- Per producer: Inference lists `/v1/telemetry/sse` and `/v1/telemetry/ndjson`
  with links `health`, `identity`, `models`; Runtime lists
  `/v1/observability/events` (SSE) and `/v1/observability/events?format=ndjson`
  with links `ecosystem` and `trace`.

A URL given to Observatory is resolved as follows: an http(s) URL with an
empty path or `/` is a base URL (discovery is fetched from it); a URL ending in
`/.well-known/sonder-telemetry` is a discovery URL; anything else is a stream
URL. From discovery Observatory opens SSE, then NDJSON, then WebSocket, unless
a transport is forced. Observatory does not follow HTTP redirects on
discovery or stream requests (a redirect is reported as an error), and
refuses discovery documents over 64 KiB; producers serve both directly.

### Framing

- **SSE**: `Content-Type: text/event-stream; charset=utf-8`. The first write
  is `retry: 2000`. Each event is `id: <event_id>`, `data: <one envelope on
  one line>`, then a blank line. There is no `event:` field (Observatory
  dispatches only the default event name). When idle, a `: keepalive` comment
  every 15 s.
- **NDJSON**: `Content-Type: application/x-ndjson`, one envelope per line, a
  blank line as heartbeat every 15 s (Observatory ignores blank lines).
- Format selection on a shared path: the explicit path, then
  `?format=ndjson|sse`, then `Accept`.
- WebSocket (one NDJSON frame per batch) remains supported by Observatory for
  other producers; Runtime and Inference do not serve it in v1.

### Envelope identity and clock

- `event_id = <producer.instance_id>-<sequence>`; `sequence` is contiguous per
  producer instance from 0. Events dropped before sequencing take no number.
- `producer.role` (`inference`, `runtime`, `fixture`) and `producer.synthetic`
  (true only for synthetic data such as a mock backend) are additive optional
  envelope fields; `producer.instance_id` names the sequence stream. Each of
  the three may be absent or `null` ("not stated"; `synthetic: null` counts
  as not synthetic). Present with another type (for example
  `"synthetic": "true"`), the event is rejected: the v1 schema declares these
  types, which were undeclared before (see docs/DECISIONS.md).
- Instance ids: Inference `tel-…`; Runtime `rt-<12 hex>` per process, with
  process session id `rts-<same hex>`.
- `mono_ns` is the host monotonic clock (`clock.mono_ns: "host-monotonic"`):
  on Linux both C++ `steady_clock` and Python `time.monotonic_ns` read
  `CLOCK_MONOTONIC`, so producers on one host merge correctly by `mono_ns`,
  then `sequence`. v1 supports same-host merging only: producers on different
  hosts, macOS/Windows clock sources after sleep, and Windows Python before
  3.13 are not comparable. `node_id` is the OS hostname; `wall_time` is RFC
  3339 UTC with milliseconds and `Z`.

### Resume

- `Last-Event-ID` wins over `?last_event_id=`. The id is split at its last
  `-` into instance and sequence.
- Same instance and `seq + 1` is still retained: replay from `seq + 1`, then
  go live.
- Same instance but older than the retained window: an SSE comment
  `: resume-gap <from>-<to>`, then the whole window. Observatory shows the
  sequence gap.
- Unknown or different instance (the producer restarted), or no id: replay
  the whole retained window, then go live. Observatory keys streams by
  instance, so a restart shows up as a new stream, not as a gap.
- `?since=now`: live events only.

### Heartbeats and backpressure

- Each producer keeps a bounded ring (Inference 8192, Runtime 4096 by
  default) with a cursor or queue per subscriber. Emission is O(1), does no
  I/O, never blocks and never raises into the caller.
- A slow subscriber loses its oldest undelivered events. The loss is per
  subscriber: it is visible to that subscriber as a sequence gap, announced on
  SSE with a `: dropped <n>` comment, and counted by the producer. It is not
  sent as `telemetry.dropped` on the shared stream, because
  `telemetry.dropped` already means the producer's own emission drops
  (Inference: bus-queue drops with a cumulative `dropped_events`) and every
  subscriber would otherwise see one subscriber's loss.
- `telemetry.dropped` counts (`dropped_events`, fixture `dropped_count`) are
  cumulative per producer instance. Observatory reports the latest value per
  instance, summed over instances; a report without a count adds nothing.
- At most 8 subscribers per producer; over the cap the producer answers 429
  with `Retry-After`, and Observatory retries with backoff.
- Observatory's own client buffer is bounded too: HTTP streams pause reading
  (TCP backpressure) and WebSocket drops the oldest events, counted in the
  connection status.

### Auth and CORS

- Loopback by default. Observatory refuses plain `http://` and `ws://` to a
  non-loopback host, URLs with credentials, and `token` / `access_token` query
  parameters. Non-loopback connections need `https://` plus a bearer token.
- A token is sent only as `Authorization: Bearer <token>` on HTTP requests
  (discovery and stream) to the producer it was given for. Observatory never
  puts tokens in URLs, never logs or persists them, refuses a token on a
  WebSocket stream (browsers cannot send the header there), and refuses to
  send a token to a discovered stream on another origin.
- Browser requests always carry `Accept` and `Cache-Control: no-store` (plus
  `Last-Event-ID` on resume and `Authorization` with a token), so every
  cross-origin producer must answer the CORS preflight: `Access-Control-Allow-Origin`
  (the exact origin), `Access-Control-Allow-Methods` including `GET`,
  `Access-Control-Allow-Headers` including `Accept, Authorization,
  Cache-Control, Last-Event-ID`.
- Inference: exact-match `--cors-origin` allowlist with the Observatory dev,
  preview and Tauri origins as defaults; bearer token with `--token-file`.
- Runtime: admin authorization as for `/v1/observability/trace`, and an
  exact-match origin allowlist. The telemetry routes should use a
  route-scoped allowlist (`SONDER_OBSERVATORY_ORIGINS`) rather than the global
  `SONDER_CORS_ORIGINS`, because the global list also grants admin routes in
  local-open mode; which one a Runtime build honours is the Runtime's to
  document. Observatory's error messages name both.

### Correlation across producers

- A Runtime chat turn has one id R. Runtime events use `request_id = R` and
  `run_id = R`; Runtime sends R to Inference as `X-Sonder-Parent-Request-Id`
  and `X-Sonder-Run-Id`.
- Inference events for that request have `run_id = R`, their own unique
  `request_id`, and `attributes.parent_request_id = R` on `request.queued`,
  `started`, `completed`, `cancelled` and `failed`.
- Observatory groups by `run_id` and links `parent_request_id` to
  `request_id` across producers; metrics key request spans by
  (producer stream, `request_id`).

### Open questions (recorded, not decided here)

- Subscriber-loss counters in discovery or health: the protocol says
  producers count per-subscriber losses (for example as
  `subscriber_dropped_events` in their stats) but pins no discovery field for
  it; discovery allows additive keys, so a field can be added without a new
  major once producers agree on it.
- A read-only, short-lived telemetry capability issued by Runtime (instead of
  the admin key) is not specified yet; until then remote Runtime telemetry
  needs the admin bearer token.
- Cross-host clock alignment is out of scope for v1.

## OpenTelemetry bridge

A bridge may map selected Sonder events/spans/metrics into OpenTelemetry for external tooling. The Observatory schema remains the richer domain model for token/cache/agent semantics.
