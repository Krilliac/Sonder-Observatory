# Shared telemetry schema: producers → Observatory

This maps what the Sonder producers emit onto what Observatory's ingest,
metrics, diagnostics and topology read. Observatory owns the envelope
(`protocol/observatory-events.schema.json`) and the live discovery document
(`protocol/producer-discovery.schema.json`); each producer owns its event
vocabulary doc (see `protocol/README.md`):

- Sonder-Inference: `docs/TELEMETRY.md` in that repo, checked here at
  **`912503a`**, plus the additions the `serve` work specifies (contract
  section 7.1, below).
- Sonder Runtime: `docs/architecture/observatory-telemetry.md` in that repo,
  vocabulary v1 (contract section 7.2, below).

Attribute names below are producer conventions that Observatory reads. They
are not part of the envelope schema. Consumers ignore attributes they do not
recognise, and unknown event types stay visible as generic events.

## Test fixtures

| File | Content |
|---|---|
| `tests/fixtures/sonder-inference-912503a.jsonl` | 46 events **recorded** from the 912503a CLI with the MOCK backend (`mock:tiny`, one 8-token request, scheduler and KV events). Synthetic: the mock backend performs no inference. |
| `tests/fixtures/sonder-inference-b2170c0.jsonl` | 26 events hand-built from the b2170c0 emitter code (a completed, a cancelled and a failed request, `telemetry.dropped`). Not a recorded run. |

Both live under `tests/`, so the UI never loads them.
`tests/inference-compat.test.ts` runs them through ingest, replay ordering,
metrics, diagnostics and topology.

## Envelope (Sonder-Inference 912503a)

Inference envelopes are valid against the v1 schema as they are.

| Field | Inference (912503a) | Observatory reading |
| --- | --- | --- |
| `schema` | `sonder.observatory.event/1` | required, checked |
| `event_id` | `<producer.instance_id>-<sequence>`, e.g. `tel-cd5730d4b371a49d-12` (a documented contract since 912503a) | dedup key; resume id |
| `sequence` | one counter per telemetry bus, shared by engine, session and request events; contiguous from 0. Dropped events take no number | gap detection per producer instance |
| `wall_time` | RFC 3339 UTC, millisecond precision | display only |
| `mono_ns` | `steady_clock` ns (since boot on Linux and Windows) | replay order (`mono_ns`, then `sequence`). Values above 2^53 (about 104 days of uptime) lose precision in JS |
| `session_id` | `engine-…` for engine-scoped events, `sess-…` for session and request events, `tel-…` for `telemetry.dropped` | shown in one view; not used for stream identity when the instance is known |
| `run_id` | the host's `SessionOptions::run_id`, **defaulting to the engine id**; null only on `telemetry.dropped` | topology/diagnostics scope |
| `request_id` | `req-…` on request, decode, token, scheduler and KV events | request spans, TTFT |
| `model_instance_id`, `device_id` | `model-…`, `cpu:0` | topology model node, resource grouping |
| `producer` | `{name: "sonder-inference", version, node_id: host name, instance_id: "tel-…"}` | `instance_id` names the sequence stream |
| `sampling` | `{level: <level this event was emitted at>, sampled: true}` | not interpreted; `sampled` is `true` on every event, so it does not mark chunk or subsampled output |
| `attributes` | object, always present | per event below |

**Stream identity.** `streamKey` (src/replay/order.ts) uses the producer
instance when an event reveals it: `producer.instance_id` if present,
otherwise the prefix of an `event_id` shaped `<instance>-<sequence>` whose
number equals `sequence`. Anything else falls back to
`session_id + producer name + node`. Inference numbers engine, session and
`tel-` events from one counter, so keying by session would show false gaps.

**Clock.** Inference 912503a documents `mono_ns` as comparable only within
one producer and says to order by `sequence`. The live producer protocol v1
(docs/TELEMETRY_PROTOCOL.md) declares it host-monotonic
(`clock.mono_ns: "host-monotonic"` in discovery) so events from several
producers on one host merge in time order. That is a change to Inference's
`docs/TELEMETRY.md` that its serve work carries. Observatory always merges by
`mono_ns`, then `sequence`; cross-producer order is only meaningful for
producers on one host that declare the host-monotonic clock.

## Events emitted by Sonder-Inference 912503a

Level is the level passed to `emit`. `metrics` events are always on when
telemetry is enabled; `standard` adds per-token and per-step detail.

| Event | Level | Attributes (abridged; see Inference `docs/TELEMETRY.md`) | Observatory use |
| --- | --- | --- | --- |
| `engine.started` | metrics | `version`, `commit`, `platform`, `device_count`, `text_capture` | class `session` |
| `engine.stopped` | metrics | none | class `session` |
| `scheduler.configured` | metrics | KV block size and count, prefix caching, step limits | class `resource` |
| `device.memory.sample` | metrics | at start and every `device_sample_interval` (default 10 s): `kind`, `name`, `logical_cores`, `total_bytes`, `available_bytes`, optional `used_bytes` | memory card and resource-pressure (`used_bytes`, else `total_bytes - available_bytes`) |
| `backend.registered` | metrics | `backend`, `description`, `capabilities[]` | class `inference` |
| `model.load.started` / `.completed` / `.failed`, `model.unload` | metrics | `backend`, `model`, …; `.completed` adds `resident` (false for metadata-only loads) | topology model node, model-churn (request-scoped load reports are ignored for churn) |
| `telemetry.dropped` | metrics (bypasses the queue) | `dropped_events` (cumulative), `emitted_events`, `queue_capacity`, `final` | drop count: latest cumulative value per producer instance, summed over instances |
| `session.created` | metrics | `model`, `backend`, `priority`, `workload`, `text_capture`, `sampling{…}` | class `session`; capture policy |
| `session.closed` | metrics | `requests` | class `session` |
| `request.queued` | metrics | `kind` (`generate`), `priority`, `workload`, `prompt_bytes` | class `request` |
| `request.started` | metrics | `kind`, `sampling{…}`, `scheduled`, `sampler` | request span start |
| `request.completed` / `.cancelled` / `.failed` | metrics | `outcome`, `stop_reason`, token counts, `chunks`, `token_counts_from_backend`, `ttft_ms` (first visible output), `total_ms`, scheduler fields; `.failed` adds `error_code`, `error` | span end; `completion_tokens` → `backendTokens` (the request's token count) when `token_counts_from_backend`; `total_ms - ttft_ms` is the decode window when no `backend_eval_ms`; errors |
| `inference.decode.started` | metrics | `ttft_ms` | class `inference`; TTFT is derived from the first token event |
| `inference.token.generated` | standard | `index`, `bytes`, `elapsed_ms`, `unit` (`token` with `count`, `token_id`, `probability`; or `chunk`), optional `text` with capture | TTFT (first event of either unit). Only `unit: "token"` (or no `unit`) counts as tokens; `chunk` never does. A request's backend `completion_tokens` replaces its token events. See TELEMETRY_PROTOCOL.md "Tokens versus chunks" |
| `inference.prefill.completed`, `inference.decode.completed` | metrics | prompt/completion counts and timings; `.decode.completed` has `backend_eval_ms` / `backend_tokens_per_sec` when the backend reports eval time | class `inference`; `backend_eval_ms` is the preferred decode window for the token rate |
| `sampling.configured`, `sampling.failed` | metrics | sampler chain, failure status | class `other` (`sampling.failed` is an error) |
| `scheduler.enqueued` / `rejected` / `admitted` / `preempted` / `prefill.chunk` / `prefill.completed` / `batch.formed` / `batch.completed` | metrics or standard | see Inference docs | class `resource`; no scheduler metrics derived yet |
| `kv.allocated` / `reused` / `evicted` / `pressure` / `freed` | standard or metrics | `kv.pressure` has `level`, `occupancy` (0..1) | cache-thrash (`kv.reused` hit, `kv.allocated` miss), resource-pressure and the pressure counter (`occupancy`) |

The Ollama timing helper emits `backend.model.load.reported`,
`backend.timing.prefill` and `backend.timing.decode` (class `inference`); the
engine does not call it at 912503a.

### Prompt-cache reuse, speculative decoding and model-default sampling

Read by `promptCacheReport`, `speculationReport` and `samplerSettings`
(src/query/attributes.ts). All fields are optional; a stream without them
derives exactly the metrics it did before (tests/perf/metrics-parity.test.ts).

| Source | Attributes | Observatory reading |
| --- | --- | --- |
| Ollama timing (main a2aa72d): `backend.timing.prefill` and the timing attributes | `prompt_eval_count`, `prompt_eval_cached_count` (Ollama 0.33.3+ always reports it) | prompt tokens = `prompt_eval_count`, of which `prompt_eval_cached_count` came from the cache; evaluated = the difference. A present cached count, 0 included, is a report: 0 is a measured miss. An event without the field reports nothing |
| llamaserver backend (PR #32, `feat/llama-server-backend`): `request.completed`, `inference.prefill.completed`, `inference.decode.completed` | `backend_cached_tokens` with `prompt_tokens` (which already includes the cached tokens); `backend_draft_tokens`, `backend_draft_accepted_tokens` (`backend_draft_acceptance_ratio` is the same ratio and is not read) | cache as above; draft acceptance = accepted / drafted |
| raw llama-server timings, if forwarded | `prompt_n` + `cache_n` (`prompt_n` excludes the cache); `draft_n`, `draft_n_accepted` | same readings |
| `session.created`, `request.started` | `sampling{…}` with `explicit_only`; a null explicit-only field (`temperature`, `top_p`, `top_k`, `min_p`, `repeat_penalty`, `repeat_last_n`, `presence_penalty`, `frequency_penalty`) is the model's own default, `num_ctx: 0` means model default; `seed: null` means unset (the backend chooses, e.g. an entropy seed), independent of `explicit_only`; `typical_p` and `max_tokens` are always values | inspector "sampler settings" shows "model default" for those fields, "unset (backend chooses)" for a null seed, "unset" for any other null |

A request keeps its latest report of each kind; a report with more cached
(accepted) than prompt (drafted) tokens is ignored as inconsistent. Totals
are token-weighted and grouped per model (first `model` attribute on the
request, else the `session.created` model of its stream and session, else
`model_instance_id`) and per `session_id`. These are backend observations,
distinct from the scheduler's logical `reused_prompt_tokens`, which is not
read. A request with no prompt-cache report at all (the fields are absent)
is unknown, not a miss: it is excluded from the ratio and, once settled
(an open request may still report), counted in
`promptCache.unreportedRequests` (and per model / session group where that
group exists), and the Overview card says "N requests without cache data".
A producer that writes 0 for a cached count Ollama omitted (Ollama before
0.33.3) makes those requests read as misses; omitting the field instead
makes them unknown. Open question: the "mean accepted length" shown is
accepted draft tokens per request, because no producer reports the number of
draft rounds that a per-round accepted length needs.

The requests this document made at b2170c0 (name the stream, group a run,
declare the capture policy, live drop reports, periodic memory, tokens vs
chunks, helper duplicates, metadata-only loads, per-event level, KV and
scheduler names) are all answered in Inference's `docs/TELEMETRY.md` at
912503a; the `mono_ns` range is documented rather than changed.

## Sonder-Inference `serve` additions (contract section 7.1)

Specified for the `sonder-infer serve` work; **not present at 912503a**.
Observatory reads them as follows once a producer sends them:

| Addition | Observatory reading |
| --- | --- |
| `request.queued.kind` value `chat` | shown as-is |
| optional `attributes.parent_request_id` on `request.queued`, `started`, `completed`, `cancelled`, `failed` | the Runtime turn that caused the request; the inspector's related-events grouping is part of the UX work |
| `run_id` = the Runtime turn id when the request carries `X-Sonder-Run-Id` | cross-producer run grouping |
| `producer.role: "inference"` | producer identity, `.sobs` manifest `producers[].role` |
| `producer.synthetic: true` while the mock backend is served | synthetic badge and banner |
| optional `engine.started.attributes.server {host, port, api_version}` | shown as-is |

## Sonder Runtime vocabulary v1 (contract section 7.2)

Authoritative in Runtime's `docs/architecture/observatory-telemetry.md`. All
Runtime events are content-free (`text_capture: "none"`, `sampling.level:
"metrics"`); the producer is `{name: "sonder-runtime", role: "runtime",
instance_id: "rt-<12 hex>"}` and the process-scoped session id is
`rts-<same hex>`.

| Event | Attributes | When | Observatory class |
|---|---|---|---|
| `session.started` | `role: "runtime"`, `version`, `text_capture: "none"`, `provider_bindings {default_generation_provider, tier_providers, embedding_provider, fallbacks}` | export start | `session` |
| `session.ended` | `emitted_events`, `dropped_events` | best effort at shutdown | `session` |
| `request.started` | `surface` (`http.chat_completions` or `a2a`), `kind: "chat"`, `stream`, `requested_model` (≤ 96 chars), `workload` | turn start | `request` (span start) |
| `route.selected` | `provider` (`ollama`, `openai_compatible`, `sonder_inference`), `operation` (`chat` or `generate`), `model` (≤ 96 chars), `attempt` (1-based) | once per provider send | `agent` |
| `route.changed` | `from_provider`, `to_provider`, `reason_code` | provider differs from the previous attempt | `agent` |
| `request.completed` / `.failed` / `.cancelled` | `outcome`, `total_ms`, `http_status`, `provider`, `model`, `attempts`, optional `prompt_tokens`, `completion_tokens`, `error_code` | turn end | `request` (span end; `.failed` is an error) |
| `telemetry.dropped` | `dropped_events` (cumulative), `emitted_events`, `queue_capacity`, `final` | on drops | `telemetry` |

Existing Runtime EventSink codes are bridged with `correlation_id` →
`request_id` and `operation_id` → `run_id`; their `summary` is never exported.

**Turn correlation.** For one Runtime chat turn R: Runtime events carry
`request_id = R` and `run_id = R`; Runtime sends R to Inference as
`X-Sonder-Parent-Request-Id` and `X-Sonder-Run-Id`; Inference events for that
request carry `run_id = R`, their own `request_id`, and
`attributes.parent_request_id = R` on the request lifecycle events.
Observatory metrics key request spans by (producer stream, `request_id`), so
the Runtime turn and the Inference request stay separate spans
(`requestLatencyByProducer` reports each producer).

## 3D Inference readings

The 3D Inference tab (docs/integration/inference3d.md) additionally reads
`backend.registered.capabilities` and `session.created.backend` /
`model.load.*.backend` to name a producer's backend and what it can report,
`request.started.sampler`, `scheduler.configured.kv_num_blocks`,
`kv.allocated`/`kv.freed` `blocks`, `parent_request_id`, and, for live
connections, the discovery `links.health` document's `backends[]`. Layer,
operator and candidate events are reserved and not emitted yet; their proposed
shapes are in TELEMETRY_PROTOCOL.md.

## What Observatory reads that no producer sends yet

- agent topology beyond `route.*`: `agent.*`, `tool.*`, `memory.retrieval.*`,
  `context.forked`
- diagnostics: budget-pressure (`guard.budget_pressure`), compaction
  (`context.compaction.*`), no-progress-loop, duplicate-worker, retry-storm
- compute utilisation (`device.compute.sample`) and VRAM samples

These run on the synthetic fixture only.
