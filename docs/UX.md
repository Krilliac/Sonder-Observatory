# UX and Product Design

## Product character

Observatory should feel like a serious developer/scientific tool: dark, restrained, information-dense, and calm. Avoid decorative "AI" effects that are not carrying information.

The generated concept screens establish the initial direction:

1. standalone live inference dashboard
2. Sonder Flutter embedded/control view
3. session replay + agent topology
4. design-system board
5. conceptual 3D transformer/inference visualization

See `docs/assets/concepts/README.md`.

## Navigation

```text
Overview
Live Session
Replay
Agents
Models
Memory
Diagnostics
Settings
```

When embedded in Sonder Flutter, Observatory appears under **Developer > Observatory** with:

- install/status
- telemetry status
- runtime endpoint
- Open Embedded
- Launch Standalone
- Open Latest Recording
- recording/sampling controls

## Overview

Primary dashboard:

- tokens/sec
- prefill throughput
- p50/p95 time-to-first-token
- p50/p95 inter-token latency
- context usage
- KV allocated/reused/evicted
- VRAM/RAM
- active model/backend
- active agents
- recorder state

The central visual should answer **what is active now?**, not merely decorate the metrics.

## Live Session

Three synchronized regions:

### Scene

Selectable views:

- inference pipeline
- cache/memory
- agent topology
- device topology
- event-flow graph

### Inspector

Selection persists until dismissed. Inspectors display evidence and units, not prose guesses.

Example token/node inspector:

- token ID/text (if capture enabled)
- position
- selected probability/logprob
- candidate distribution
- request/run/agent
- backend/device
- timings
- related events

### Timeline

One timeline drives all views.

Tracks can include:

- tokens
- requests
- agents
- tools
- model lifecycle
- cache
- compaction
- retries/errors
- device transfers
- resource pressure

## Replay

Replay is a first-class mode, not a video player.

Capabilities:

- time scrub
- play/pause/speed
- filter by event type
- jump to error/retry/compaction
- compare two runs
- inspect state snapshot
- open selected interval in diagnostics
- preserve selected entity while scrubbing where identity remains valid

## 3D semantics

3D should be used when spatial structure makes a relationship easier to understand:

- layer/operator pipeline
- multi-node device topology
- agent graph
- cache pools/tiers
- context lineage

Do **not** label arbitrary latent clusters as "reasoning", "knowledge", or "safety" unless a specific measured/derived signal actually maps to those categories.

Recommended mappings:

- node size -> bytes/tokens/work
- edge width -> context bytes/tokens transferred
- pulse rate -> event frequency
- opacity -> activity/age
- stable semantic color -> event class/state
- depth -> explicit pipeline or topology dimension

Every mapping needs a visible legend.

## Visual system

Base direction from the concept board:

- deep navy/near-black background
- cool blue primary interaction accent
- cyan for activation/throughput/transfer
- purple for attention/relationship class
- green for success/healthy
- amber for warning/backpressure/probability emphasis
- red for error
- thin borders; limited glow; glow carries active-state meaning

Accessibility:

- state must not be communicated by color alone
- keyboard navigation for all inspectors/timelines
- reduced-motion mode
- pause for continuous motion
- legible 100–200% scaling
- no hover-only critical controls
- color-contrast audit before release

## Useful diagnostic visualizations

- context growth vs compaction
- KV hit/miss/eviction timeline
- scheduler queue and running batch
- per-agent token/latency allocation
- duplicate work detector
- retry/no-progress loop visualization
- model residency and load/unload churn
- CPU/GPU/NPU placement
- network transfer between Sonder nodes
- speculative decoding accepted/rejected token runs
- MoE expert routing when exposed
