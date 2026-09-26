# Architecture

## Boundary

Sonder Observatory is a **consumer** of telemetry, never the owner of inference or orchestration state.

```text
Sonder Runtime / Sonder Inference / remote nodes
                     |
               event producers
                     |
          versioned telemetry stream
                     |
        +------------+-------------+
        |                          |
        v                          v
   live transport              recorder
  WebSocket / IPC          session event log
        |                          |
        +------------+-------------+
                     v
               Observatory
          +----------+----------+
          | renderer | replay   |
          | query    | inspector|
          +----------+----------+
```

The renderer must be able to crash, restart, disconnect, or be absent without affecting generation.

## Major components

### 1. Producer adapters

Producer adapters live with the runtime that owns the underlying state. Initial producers:

- Sonder Runtime orchestration events
- Sonder Inference execution events
- compatibility adapter for Ollama/llama.cpp metrics where available
- system/device sampler
- remote-node transport bridge

A producer may expose only the events it can prove. Unsupported fields remain absent; Observatory does not synthesize fake layer/attention information.

### 2. Transport

Preferred initial transport:

- local: loopback WebSocket with a random session capability token
- embedded: same loopback endpoint, consumed by Flutter WebView
- standalone: Tauri/native shell connects to the endpoint
- remote: authenticated TLS WebSocket through Sonder's existing trust model

Requirements:

- monotonic sequence number per stream
- UTC wall clock plus monotonic runtime timestamp
- bounded producer queues
- sampling/backpressure
- reconnect + resume from last retained sequence when possible
- explicit dropped-event counters

### 3. Recorder

The recorder writes an append-oriented event log plus metadata.

Initial logical format:

```text
session/
  manifest.json
  events.ndjson
  snapshots/
  attachments/
```

A packaged `.sobs`/Observatory recording can later become a ZIP-compatible container or a compact binary format. Start with a debuggable representation first.

Recordings must declare:

- schema version
- producer versions
- session/run IDs
- sampling policy
- redaction policy
- dropped-event counts
- clocks/time origin
- model/backend/device descriptors

### 4. Query/index layer

The viewer needs indexed access by:

- sequence/time
- request/run/session
- model instance
- agent/task
- device
- token position
- cache allocation
- tool call
- error/retry
- context lineage

Replay should not require replaying the whole file from the beginning just to inspect minute 40 of a long run.

### 5. Renderer

Preferred first implementation: TypeScript + Three.js/WebGPU with a fallback WebGL path, packaged by Tauri for standalone use and hosted in an embedded WebView inside Sonder Flutter.

The renderer has two semantic spaces:

**Inference Space**
- prompt/prefill
- decode
- token stream
- cache occupancy/reuse
- device transfer
- model/layer/operator events only where the backend exposes them
- output distribution/sampling state when capture is enabled

**Sonder Space**
- owner/worker/critic topology
- routing
- memory/retrieval
- tools
- context transfer
- compaction
- retries/recovery
- duplicate/no-progress safeguards
- distributed nodes

### 6. Inspector

Every drawable object must resolve to underlying evidence:

```text
visual object -> event IDs -> producer -> captured fields
```

The inspector should show whether a value is:

- measured
- backend-reported
- derived from measured values
- estimated
- unavailable

## Runtime cost budgets

Observability levels:

| Level | Purpose | Raw text | Per-token | Deep backend events |
|---|---|---:|---:|---:|
| Off | production minimum overhead | no | no | no |
| Metrics | health/throughput | no | sampled | no |
| Standard | normal Observatory use | configurable | yes | sampled |
| Deep | diagnostics | opt-in | yes | yes where supported |

Deep instrumentation must be opt-in and bounded. If telemetry backpressure develops, inference wins and Observatory receives a dropped-event marker.

## Failure isolation

- no renderer code in inference hot path
- bounded lock-free or low-contention producer queues where practical
- no synchronous network writes from token generation
- no dependency on Observatory availability
- recorder disk limits and rotation
- watchdog-able standalone process
- corrupt recordings fail closed and remain inspectable as partial logs

## Technology choices to validate

- **Renderer:** Three.js + WebGPU/WebGL
- **Standalone shell:** Tauri
- **Flutter embedding:** WebView served from local Observatory bundle
- **Live transport:** WebSocket initially
- **Serialization:** JSON/NDJSON for bring-up; evaluate MessagePack/Protobuf/FlatBuffers only after profiling
- **Tracing interoperability:** export/import bridges rather than making a third-party tracing format the internal source of truth
