# Roadmap

## Milestone 0 — foundation

- [x] establish separate repository boundary
- [x] define architecture and telemetry taxonomy
- [x] define Flutter/standalone integration concept
- [x] capture UX/design direction
- [ ] settle protocol package ownership between Runtime/Inference/Observatory. Proposed, pending owner review: Observatory owns the envelope and discovery shapes in `protocol/`; each producer owns its vocabulary doc; see [decisions](DECISIONS.md).
- [x] choose recording extension/container name (provisional: `.sobs` NDJSON + manifest, see [recording format](RECORDING_FORMAT.md))
- [ ] define compatibility/version policy. Proposed, pending owner review: additive within a major; renames/removals and new closed-enum values in discovery bump the major and land in `protocol/` first; see [protocol README](../protocol/README.md).

## Milestone 1 — smallest useful Observatory

- [x] web renderer (TypeScript + Vite, see [decisions](DECISIONS.md))
- [x] Tauri standalone shell (`src-tauri/`, Tauri v2, least-privilege capabilities; CI runs `cargo check`/`cargo test` on Windows). The desktop bridge is wired into the UI (`src/integrations/desktopUi.ts`: mode badge, native open, recent recordings, `--open` / `--connect`). `tauri build` bundling is not verified
- [x] connect/disconnect to live producers (`src/ingest/live`: WebSocket, SSE and NDJSON, reconnect with backoff, resume by `Last-Event-ID`)
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

Update 2026-10-04: real Runtime and Inference processes now pass the
[ecosystem end-to-end qualification](integration/ecosystem-e2e.md#qualified-scope-2026-10-04),
including discovery, live telemetry correlation, recording/export/replay,
Flutter payload parsing, failure controls and supervised cleanup. Inference
uses its explicitly **synthetic mock backend**. This closes the producer
interoperability blocker within that scope; it does not qualify real model
quality, GPU performance, every analytical view or the open protocol proposals.

Deferred from Milestone 1: Tauri bundle/installer, a Runtime-issued telemetry capability token, indexed seeking for long recordings (replay currently loads the whole file), recorder quota/rotation, ZIP `.sobs` packaging, event-type filters beyond class/text.

## Ecosystem integration (live producer protocol v1)

Added 2026-09-26 on top of Milestone 1, for the Sonder ecosystem contract v1:

- [x] producer discovery schema (`protocol/producer-discovery.schema.json`) with mirror and drift test
- [x] multi-producer live ingest (`LiveConnectionManager`, discovery, per-producer bearer tokens, endpoint policy)
- [x] per-producer request spans and cumulative drop accounting; `.sobs` manifests record producer roles
- [x] fake producer role modes and the producer conformance suite (`tests/conformance/`)
- [x] desktop launch: repeatable `--connect`, `--token-file` bound per URL
- [x] renderer producer cards, presets and repeatable `?connect=` parameters (`LiveConnectionManager`; browser connection tests)
- [x] end-to-end run against real Sonder Runtime and Sonder-Inference processes with a synthetic mock inference backend; see [qualified scope and receipts](integration/ecosystem-e2e.md#qualified-scope-2026-10-04)

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

- [x] 3D token/pipeline view (request pipeline stages × model/node lanes; see [3D Inference notes](integration/inference3d.md))
- [ ] KV/cache visualizer
- [ ] batch scheduler view
- [ ] model residency/device topology
- [ ] speculative decoding visualization
- [ ] layer/operator deep mode where supported (Observatory side done: draws `backend.layer.*` / `backend.operator.*` / `inference.sampling.candidates` in the proposed shapes; no Sonder Inference backend emits them yet)
- [x] evidence inspector for every 3D entity

Status 2026-09-27: the "3D Inference" tab is three.js in a lazy chunk. KV is
shown as a logical pool volume per producer (not yet a full cache
visualizer); batch scheduler, residency/device topology and speculative
decoding views remain open.

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
