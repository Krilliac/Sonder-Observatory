# Query

Responsibility: Event indexing, filtering, and correlation.

- `classify.ts` maps event types to timeline classes; unknown types stay visible as `other`.
- `metrics.ts` derives request latency, time to first token, token rate,
  errors, agent/tool activity, resource pressure, dropped telemetry, and
  backend prompt-cache reuse and speculative-decoding acceptance (per request,
  per model and per session), each with its evidence. Missing evidence is reported as unavailable, never estimated.
- `attributes.ts` holds the producer attribute conventions shared by metrics,
  diagnostics and replay, accepting both the synthetic fixture's names and
  Sonder-Inference's (see [telemetry schema](../../docs/telemetry-schema.md)).

`metricsIndex.ts` answers `metricsAt(events, count)`, equal to
`deriveMetrics(events.slice(0, count))`, incrementally for replay scrubbing. See [source workspace](../README.md).
