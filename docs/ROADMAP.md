# Roadmap

## Milestone 0 — foundation

- [x] establish separate repository boundary
- [x] define architecture and telemetry taxonomy
- [x] define Flutter/standalone integration concept
- [x] capture UX/design direction
- [ ] settle protocol package ownership between Runtime/Inference/Observatory
- [x] choose recording extension/container name (provisional: `.sobs` NDJSON + manifest, see [recording format](RECORDING_FORMAT.md))
- [ ] define compatibility/version policy

## Milestone 1 — smallest useful Observatory

- [x] web renderer (TypeScript + Vite, see [decisions](DECISIONS.md))
- [x] Tauri standalone shell (`src-tauri/`, Tauri v2, least-privilege capabilities; CI runs `cargo check`/`cargo test` on Windows). `tauri dev`/`tauri build` not yet run on a dev machine; the desktop bridge (`src/integrations/desktop.ts`) is not wired into the UI yet
- [x] connect/disconnect to live WebSocket (configurable URL; plain event frames, no handshake yet)
- [x] metric cards
- [x] event timeline
- [x] event table + inspector
- [x] basic session recorder/replay (save live session to `.sobs`, open recordings, scrubber, play/speed, next error)
- [x] no 3D dependency required for MVP
- [x] synthetic telemetry fixture for tests (`fixtures/synthetic-session.ndjson`, labeled synthetic)
- [x] protocol TypeScript types + runtime validator with schema drift test
- [x] dev fake producer replaying a recording over WebSocket
- [x] unit tests (Vitest) and CI (lint, test, build)

Success gate: developer can identify request latency, token rate, errors, agent/tool transitions, and resource pressure from a recorded session.

Status 2026-09-26: met against the **synthetic** fixture only. Validating the gate against a real Sonder Runtime / Sonder-Inference recording is blocked on producer instrumentation and the open protocol questions in [decisions](DECISIONS.md).

Deferred from Milestone 1: Tauri bundle/installer and desktop-bridge wiring, live reconnect/resume, capability-token handshake, indexed seeking for long recordings (replay currently loads the whole file), recorder quota/rotation, ZIP `.sobs` packaging, event-type filters beyond class/text.

## Milestone 2 — Sonder topology

- [x] agent graph (`src/topology/`, "Agents" tab)
- [x] route/model changes
- [x] context transfer
- [x] tool and memory nodes
- [x] retry/recovery/guard events
- [ ] token/context budget visualization
- [ ] compaction visualization
- [x] duplicate/no-progress diagnostics

Status 2026-09-26: topology is derived only from events at the replay cursor
and validated against synthetic fixtures; the attribute names it reads are an
open protocol question (see [topology notes](integration/topology.md)).
Diagnostics findings (`src/diagnostics/`, "Diagnostics" tab) cover budget
pressure, compaction, no-progress loops, duplicate workers, retry storms,
cache thrash, model churn, latency outliers, error bursts and resource
pressure (see [diagnostics notes](integration/diagnostics.md)).

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
- [ ] clock synchronization diagnostics (replay currently assumes one monotonic time base per session)
- [ ] remote cache/context transfer
- [ ] node health/resource views
- [ ] distributed prefill/decode visualization
