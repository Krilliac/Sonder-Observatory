# Roadmap

## Milestone 0 — foundation

- [x] establish separate repository boundary
- [x] define architecture and telemetry taxonomy
- [x] define Flutter/standalone integration concept
- [x] capture UX/design direction
- [ ] settle protocol package ownership between Runtime/Inference/Observatory
- [ ] choose recording extension/container name
- [ ] define compatibility/version policy

## Milestone 1 — smallest useful Observatory

- [ ] Tauri shell + web renderer
- [ ] connect/disconnect to live WebSocket
- [ ] metric cards
- [ ] event timeline
- [ ] event table + inspector
- [ ] basic session recorder/replay
- [ ] no 3D dependency required for MVP
- [ ] synthetic telemetry fixture for tests

Success gate: developer can identify request latency, token rate, errors, agent/tool transitions, and resource pressure from a recorded session.

## Milestone 2 — Sonder topology

- [ ] agent graph
- [ ] route/model changes
- [ ] context transfer
- [ ] tool and memory nodes
- [ ] retry/recovery/guard events
- [ ] token/context budget visualization
- [ ] compaction visualization
- [ ] duplicate/no-progress diagnostics

## Milestone 3 — inference space

- [ ] 3D token/pipeline view
- [ ] KV/cache visualizer
- [ ] batch scheduler view
- [ ] model residency/device topology
- [ ] speculative decoding visualization
- [ ] layer/operator deep mode where supported
- [ ] evidence inspector for every 3D entity

## Milestone 4 — Flutter integration

- [ ] status card
- [ ] Open Embedded
- [ ] Launch Standalone
- [ ] Pop Out / reattach
- [ ] latest recordings
- [ ] telemetry/privacy settings
- [ ] optional pinned submodule/package workflow

## Milestone 5 — comparison and profiling

- [ ] compare two runs
- [ ] regression overlays
- [ ] latency/resource heatmaps
- [ ] cache hit/eviction analysis
- [ ] backend/model comparison
- [ ] export trace/metrics formats

## Milestone 6 — distributed Observatory

- [ ] multi-node topology
- [ ] clock synchronization diagnostics
- [ ] remote cache/context transfer
- [ ] node health/resource views
- [ ] distributed prefill/decode visualization
