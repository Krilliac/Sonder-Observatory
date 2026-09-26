# Query

Responsibility: Event indexing, filtering, and correlation.

- `classify.ts` maps event types to timeline classes; unknown types stay visible as `other`.
- `metrics.ts` derives request latency, time to first token, token rate,
  errors, agent/tool activity, resource pressure, and dropped telemetry, each
  with its evidence. Missing evidence is reported as unavailable, never estimated.

Indexed seeking for long recordings is not implemented yet. See [source workspace](../README.md).
