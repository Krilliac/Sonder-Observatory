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

## OpenTelemetry bridge

A bridge may map selected Sonder events/spans/metrics into OpenTelemetry for external tooling. The Observatory schema remains the richer domain model for token/cache/agent semantics.
