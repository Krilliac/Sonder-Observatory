# Decisions

Decisions taken while implementing Milestone 1. Each one is provisional and can
be revisited; record the replacement here rather than editing history.

## 2026-09-26 — Web toolchain

- **Language/build:** TypeScript 6.0 (`~6.0.3`) + Vite 8, npm. pnpm was not
  installed on the development machine, so npm avoids an extra tool.
- **Lockfile:** not committed yet because the initial push went through the
  GitHub API, where an 86 kB generated lockfile is impractical. CI uses
  `npm install`. Next step: commit a `package-lock.json` generated on a dev
  machine (with the `.npmrc` below in place), then switch CI to `npm ci`.
- **Peer deps:** on Node 22, npm 10.9's peer-set resolution crashes
  (`Cannot read properties of null (reading 'edgesOut')`) on the
  Vite 8 / Vitest 4 peer graph. The committed `.npmrc` sets
  `legacy-peer-deps=true` so `npm install` works on Node 20 and 22. npm 11
  does not crash; revisit once npm 10 is no longer the Node 22 default.
- **Fixture file:** `fixtures/synthetic-session.ndjson` is generated
  deterministically by `scripts/generate-fixture.mjs` via npm `pre*` scripts
  and is git-ignored, so it can never drift from its generator.
- **TypeScript 7 not used yet:** typescript-eslint 8 supports TypeScript
  `<6.1`, so TypeScript stays on 6.0 until the linter supports 7.
- **Tests:** Vitest 4 in the Node environment. Vitest 5 requires Node 22.12+;
  Vitest 4 keeps Node 20.19+ working.
- **Lint:** ESLint 10 flat config + typescript-eslint recommended, plus
  `tsc --noEmit` (strict, `noUncheckedIndexedAccess`).
- **Node:** `>=20.19.0` (Vite 8 requirement). CI runs Node 20 and 22.
- **UI framework:** none. The Milestone 1 UI is plain TypeScript + DOM/SVG to
  keep the dependency surface small; revisit when views multiply.
- **Runtime dependencies:** none. `ws` is a dev dependency used only by the
  fake producer script.
- **3D:** not included (Milestone 1 requires no 3D dependency). Three.js /
  WebGPU remains the proposal for Milestone 3.
- **Tauri:** see ROADMAP; the standalone shell is the next step and is only
  added once a Rust toolchain is available and the shell builds.

## 2026-09-26 — Protocol types and validation

- `protocol/observatory-events.schema.json` stays the source of truth and is
  unchanged. `src/protocol/` holds a hand-written TypeScript mirror and a
  dependency-free runtime validator. `tests/protocol-schema-drift.test.ts`
  reads the schema file and fails if required fields, nullable ids, the schema
  id constant, sampling levels or producer fields diverge.
- A hand-written validator was chosen over a generated one (for example Ajv)
  to avoid a runtime dependency for a 9-field envelope. Revisit if the schema
  grows event-type-specific payload schemas.
- Unknown additive fields are preserved; unknown event types are shown as the
  generic `other` class (TELEMETRY_PROTOCOL.md compatibility rules).
- Protocol package ownership between Runtime, Inference and Observatory is
  **unresolved**. Observatory does not define handshake, resume, capability
  or authentication messages; the WebSocket client accepts plain event frames
  only. See "Open questions" below.

## 2026-09-26 — Recording extension and container

See [recording format](RECORDING_FORMAT.md). Summary: `.sobs` is UTF-8 NDJSON
whose first line is an Observatory manifest record; the remaining lines are
unmodified protocol events. ZIP packaging is deferred; loaders detect it by
the leading `PK` bytes.

## 2026-09-26 — Replay ordering

Events are deduplicated by `event_id` (first wins) and ordered by `mono_ns`,
then `sequence`, then `event_id`. Sequence gaps are reported per stream
(`session_id` + producer name + node) as possible dropped telemetry. This
assumes one shared monotonic time base per session, which holds for a single
local producer; cross-node clock alignment belongs to Milestone 6.

## 2026-09-26 — Metrics provenance

Metric cards are derived only from events present up to the replay cursor and
state their provenance (derived, producer-reported, measured, unavailable).
One `inference.token.generated` event counts as one token unless the producer
sets an integer `attributes.count`. Memory pressure uses
`device.memory.sample` `attributes.used_bytes` / `attributes.total_bytes`;
compute uses `device.compute.sample` `attributes.utilization`. These attribute
names are Observatory's reading convention for the synthetic fixture, not a
producer contract; they must be confirmed with Sonder-Inference.

## Open questions

- Protocol package ownership and compatibility/version policy (Milestone 0).
- Producer attribute names for token counts, memory/compute samples, tool
  call ids and dropped-event counts.
- Live transport handshake: capability token, resume-from-sequence, and
  producer capability advertisement at session start.
- Redaction/capture policy field in `session.started` (the manifest reads
  `attributes.text_capture` if present, otherwise records `unspecified`).
