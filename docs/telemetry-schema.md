# Shared telemetry schema: Sonder-Inference → Observatory

This maps what Sonder-Inference **actually emits** at `main` `b2170c0` onto what
Observatory's ingest, metrics, diagnostics and topology read. It was written
from the Inference source, read-only:

- `include/sonder/inference/telemetry.hpp` and `src/telemetry/telemetry.cpp` (bus, envelope)
- `src/engine/engine.cpp` and `src/sessions/session.cpp` (every `emit` call on main)
- `src/backends/ollama/ollama_telemetry.cpp` (Ollama timing helpers)
- `docs/OBSERVATORY_CONTRACT.md`, `docs/integration/{scheduler,kv-cache,sampling}.md`

`protocol/observatory-events.schema.json` is still the only envelope contract.
Nothing here changes it. Attribute names below are producer conventions that
Observatory reads. They are not part of the schema.

Test fixture: `tests/fixtures/sonder-inference-b2170c0.jsonl` has 26 events in
Inference's exact shape (engine start, device sample, Ollama backend, model
load, one session with a completed, a cancelled and a failed request, shutdown,
`telemetry.dropped`). It is **hand-built from the emitter code, not a recorded
run**, and it lives under `tests/`, so the UI never loads it.
`tests/inference-compat.test.ts` runs it through ingest, replay ordering,
metrics, diagnostics and topology.

## Envelope

Inference envelopes are valid against the v1 schema as they are.

| Field | Inference (b2170c0) | Observatory reading |
| --- | --- | --- |
| `schema` | `sonder.observatory.event/1` | required, checked |
| `event_id` | `<bus instance>-<sequence>`, e.g. `tel-3f9c2a7b1d4e5f60-12` | dedup key; the prefix identifies the sequence stream (see below) |
| `sequence` | one counter per `TelemetryBus`, shared by all sessions; contiguous. Dropped events don't take a number | gap detection per stream |
| `wall_time` | RFC 3339 UTC, millisecond precision | display only |
| `mono_ns` | `steady_clock` ns (since boot on Linux/Windows) | replay order. Values above 2^53 (about 104 days of uptime) lose precision in JS |
| `session_id` | engine-scoped events use the **engine id** (`engine-…`), session events use the session id (`sess-…`), `telemetry.dropped` uses the **bus instance id** (`tel-…`), and `unscoped` if empty | all shown in one view. Not used for stream identity when the instance is known |
| `run_id`, `agent_id`, `task_id` | from `SessionOptions`; `null` unless the host sets them | topology/diagnostics scope keys |
| `request_id` | `req-…` on request, decode and token events | request spans, TTFT |
| `model_instance_id` | `model-…` on model and session events | topology model node, churn grouping |
| `device_id` | `cpu:0`-style ids on device samples and model events | resource grouping |
| `producer` | `{name: "sonder-inference", version, node_id: host name}` | synthetic detection is by name only (Inference is never flagged synthetic) |
| `sampling` | `{level: <bus configured level>, sampled: true}`. The level is the bus's, **not** the event's | not interpreted yet |
| `attributes` | object, always present | per event below |

**Stream identity (ingest change).** Observatory used to key sequence streams
by `session_id + producer + node`. Inference numbers engine, session and
`tel-` events from one counter, so every session would show false "possible
dropped telemetry" gaps. `streamKey` now uses the producer instance when an
event reveals it: `producer.instance_id` if present, otherwise the prefix of an
`event_id` shaped `<instance>-<sequence>` whose number equals `sequence`.
Anything else falls back to the old key.

## Events emitted on main

Level is the level passed to `emit`. `metrics` events are always on, and
`standard` needs the bus level to be at least `standard`.

| Event | Level | Emitted by | Attributes | Observatory use |
| --- | --- | --- | --- | --- |
| `engine.started` | metrics | `Engine()` | `version`, `commit`, `platform`, `device_count` | class `session` (was `other`) |
| `device.memory.sample` | metrics | `Engine()` once per device when `sample_devices_on_start` | `kind`, `name`, `logical_cores`, `total_bytes`, `available_bytes` | memory card and resource-pressure: used = `total_bytes - available_bytes` (**ingest change**) |
| `backend.registered` | metrics | `register_backend` | `backend`, `description`, `capabilities[]` | class `inference` |
| `model.load.started` | metrics | `load_model` | `backend`, `model` | topology model node (loading) |
| `model.load.completed` | metrics | `load_model` | `backend`, `model`, `format`, `family`, `parameter_size`, `quantization`, `size_bytes`, `duration_ms` | topology model node (label = `model`), model-churn |
| `model.load.failed` | metrics | `load_model` | `backend`, `model`, `duration_ms`, `error_code`, `error` | error class, error-burst |
| `model.unload` | metrics | `unload_model` | `backend`, `model`, `outstanding_references` | topology, model-churn |
| `session.created` | metrics | `Session()` | `model`, `backend`, `priority`, `sampling{temperature, top_p, top_k, min_p, repeat_penalty, seed, max_tokens}` | class `session`. `text_capture` is read here too if present (**ingest change**; Inference doesn't send it yet) |
| `session.closed` | metrics | `Session::close` | `requests` | class `session` |
| `request.queued` | metrics | `generate` | `kind`, `priority`, `prompt_bytes` | class `request` (queue time not derived yet) |
| `request.started` | metrics | `generate` | `kind`, `sampling{…}` | request span start |
| `inference.decode.started` | metrics | first streamed chunk | `ttft_ms` | class `inference`. TTFT is derived from the first token event instead |
| `inference.token.generated` | standard | every streamed **chunk** | `index`, `bytes`, `elapsed_ms`, `text` only with `capture_text` | token rate, TTFT. One event = one token (no `count`), so for Ollama this counts chunks |
| `inference.decode.completed` | metrics | completed requests | `completion_tokens`, `chunks`, `decode_wall_ms`, `backend_eval_ms`?, `backend_tokens_per_sec`?, `backend_prompt_eval_ms`? | class `inference` (not used by metrics yet) |
| `request.completed` | metrics | `generate` | `outcome`, `stop_reason`, `prompt_tokens`, `completion_tokens`, `chunks`, `token_counts_from_backend`, `ttft_ms`, `total_ms` | span end. `completion_tokens` → `backendTokens` / `tokens.backendReported` when `token_counts_from_backend` is true (**ingest change**) |
| `request.cancelled` | metrics | `generate` | as completed, plus `cancel_latency_ms` | span end (cancelled) |
| `request.failed` | metrics | `generate` | as completed, plus `error_code`, `error` | span end (failed), error class, error-burst, latency-outlier |
| `engine.stopped` | metrics | `~Engine()` | none | class `session` |
| `telemetry.dropped` | (bypass) | `TelemetryBus::shutdown` only, if anything was dropped | `dropped_events`, `emitted_events`, `queue_capacity` | dropped count read from `dropped_events` or `dropped_count` (**ingest change**) |

`stop_reason` values: `none`, `max_tokens`, `stop_sequence`, `end_of_sequence`,
`cancelled`, `callback`, `error`. `error_code` values: `invalid_argument`,
`invalid_state`, `not_found`, `unavailable`, `cancelled`, `timeout`,
`backend_error`, `protocol_error`, `io_error`, `unsupported`, `internal`.

## Ollama timing helpers (`ollama_telemetry.cpp`)

- `timing_attributes(OllamaTimings)` returns a flat attribute bag and is not an event:
  - `backend`
  - `total_duration_ns`, `load_duration_ns`
  - `prompt_eval_count`, `prompt_eval_duration_ns`
  - `eval_count`, `eval_duration_ns`
  - `prompt_tokens_per_sec`, `decode_tokens_per_sec` (the server-timing fields appear only when Ollama reported them)
  - `ttfb_ms`, `ttft_ms` (only when measured), `wall_ms`, `content_chunks`
- `emit_timing_events(bus, ctx, timings, model)` emits up to three `metrics` events. Each carries `backend` and `model`:
  - `model.load.completed` with `load_duration_ns`, when `load_duration > 0`
  - `inference.prefill.completed` with `prompt_eval_count`, `prompt_eval_duration_ns`, `prompt_tokens_per_sec`
  - `inference.decode.completed` with `eval_count`, `eval_duration_ns`, `decode_tokens_per_sec`, and `ttft_ms` when measured
- **Not called by `Engine`/`Session` on main**, only by its unit test. When it
  is wired in:
  - Its `inference.decode.completed` would duplicate the session's event for
    the same request, with different attributes.
  - Its `model.load.completed` reports Ollama's `load_duration`, which is
    non-zero even for a warm model. Counted as residency transitions, those
    reports would set off model-churn after 4 requests a minute. Observatory
    now ignores any `model.load.completed` that carries a `request_id` for
    churn (**ingest change**; the helper takes the request's context).
- `inference.prefill.completed` is classified `inference`. No metric reads it yet.

## Scheduler, KV cache, sampler: not emitted yet

None of these modules emits telemetry on main: `src/scheduler`, `src/cache`
and `src/sampling` don't use `TelemetryBus`.

- **Scheduler**: `SchedulerStats` and `RequestTimeline` hold queue time, TTFT,
  ITL, occupancy, prefill/decode share, preemptions by reason and mode, and
  starvation age. Mapping them to events is "left to the telemetry owner".
  Observatory classifies `scheduler.*` as `resource` but derives nothing from
  them yet.
- **KV cache**: `KvCacheManager` has a synchronous `CacheEvent` listener. The
  proposed mapping (`docs/integration/kv-cache.md`) is:
  - `allocated` → `kv.allocated`
  - `reused` → `kv.reused` (with `avoided_prefill_tokens`)
  - `evicted` → `kv.evicted`
  - `pressure_changed` → `kv.pressure`
  - `copy_on_write` → `kv.allocated` with reason `cow`, or a new `kv.copied`

  Observatory already reads these names:
  - cache-thrash: `kv.reused` = hit, `kv.allocated` = miss, `kv.evicted` counted
  - resource-pressure and the pressure counter: `kv.pressure`, with `occupancy` as a 0..1 fraction
  - `PressureLevel` (`normal`/`high`/`critical`) is not read yet. Send `occupancy` too.
- **Sampler**: `src/sampling` is a library with no events. Sampling config
  appears only as the `sampling` object on `session.created` and `request.started`.
- **llama.cpp backend**: has its own internal `TelemetryKind` callback
  (`kModelLoaded`, `kModelUnloaded`, `kPrefillDone`, `kTokenDecoded`,
  `kGenerationDone`, …). The core adapter only uses it for load time. None of
  it reaches the bus.

## What Observatory expects that Inference doesn't send

These parts of Observatory work only with other producers (Sonder Runtime) or
the synthetic fixture:

- agent topology: `agent.*`, `route.*`, `tool.*`, `memory.retrieval.*`, `context.forked`
- diagnostics:
  - budget-pressure (`guard.budget_pressure`, token/limit attributes)
  - compaction (`context.compaction.*`)
  - no-progress-loop, duplicate-worker, retry-storm
  - cache-thrash (`kv.*`)
- metrics: compute utilisation (`device.compute.sample`), and memory over time
  (Inference samples memory once, at engine start)

Diagnostics that do run on Inference data today:

- latency-outlier and error-burst
- model-churn (engine-scoped load/unload only)
- resource-pressure (on the one startup sample)

## Requested changes on the Inference side

These are suggestions for the Inference lead. Observatory already handles the
current shapes, so none of them blocks it.

1. **Name the stream.** Add `producer.instance_id` (the bus `instance_id_`) so
   stream identity is explicit. Otherwise document the `<instance>-<sequence>`
   `event_id` format as a contract, since Observatory relies on it.
2. **Group a run.** Default `run_id` to the engine id on session and request
   events, or put the engine id in an attribute. Right now nothing links
   `engine-…` events to `sess-…` events except timing and `model_instance_id`.
3. **Declare the capture policy.** Add `text_capture: "off" | "on"` to
   `session.created` (and `engine.started`). Observatory shows it in the header
   and in `.sobs` manifests; today it shows `unspecified`.
4. **Report drops while running.** Emit `telemetry.dropped` periodically or on
   the first drop, not only at shutdown, so a live view sees drops. Keep
   `dropped_events`. Observatory reads it, and `dropped_count` as well.
5. **Sample memory periodically** (and VRAM where a backend can report it)
   instead of only at engine start. `total_bytes` + `available_bytes` is fine;
   `used_bytes` also works.
6. **Tokens vs chunks.** `inference.token.generated` is one event per streamed
   chunk. Either add an integer `count` when the backend reports tokens per
   chunk, or rename the event (for example `inference.chunk.generated`). The
   authoritative count stays in `request.completed.completion_tokens` with
   `token_counts_from_backend`.
7. **Wire the Ollama helper without duplicates.** Don't emit a second
   `inference.decode.completed` for a request. Merge `eval_*` into the
   session's event or use a distinct name (for example `backend.timing`). For
   the load report, use a distinct name (for example
   `backend.model.load.reported`), or keep `model.load.completed` with the
   request context (Observatory ignores that for churn). Also emit
   `inference.prefill.completed` from the session with `prompt_tokens` and
   `backend_prompt_eval_ms`.
8. **Mark metadata-only loads.** For Ollama, `Engine::load_model` fetches
   metadata (`/api/show`) and doesn't make the model resident. Add
   `resident: false` or `load_kind: "metadata"` to `model.load.completed` so
   residency views don't over-claim.
9. **Per-event level.** `sampling.level` carries the bus's configured level.
   Consider the level the event was emitted at (for example `standard` for
   token events), so consumers know what a lower setting would drop.
10. **`mono_ns` range.** `steady_clock` since boot passes 2^53 ns after about
    104 days of uptime and then loses precision in JavaScript. Consider
    `mono_ns` relative to bus start, or document the limit.
11. **KV and scheduler events.** When the cache listener is forwarded, include
    `occupancy` (0..1) on `kv.pressure` and `avoided_prefill_tokens` on
    `kv.reused`, and put the sequence's `request_id` in the envelope. For the
    scheduler, suggested events are `scheduler.enqueued` / `admitted` /
    `preempted` (with `reason`, `mode`, `queue_ms`) and
    `scheduler.batch.formed` (`batch_size`, `prefill_tokens`, `decode_tokens`).
    Observatory has no scheduler metrics yet and will derive them from these
    names.
