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
- **Runtime dependencies:** `@tauri-apps/api` only, used by
  `src/integrations/desktop.ts` (not imported by the web renderer yet, so it
  is not in the web bundle). `ws` is a dev dependency used only by the fake
  producer script.
- **3D:** not included (Milestone 1 requires no 3D dependency). Three.js /
  WebGPU remains the proposal for Milestone 3.
- **Tauri:** the v2 shell lives in `src-tauri/` (PR #3). CI runs
  `cargo check` and `cargo test` on `windows-latest`; `tauri dev` /
  `tauri build` have not been run yet. Vite uses `strictPort` because
  `tauri.conf.json` expects `http://127.0.0.1:5173`. No `Cargo.lock` is
  committed yet. `src/integrations/desktop.ts` (launch args, native
  recording picker) is present but not wired into the UI.

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

## 2026-09-26 — License

MIT (`LICENSE`, "Copyright (c) 2026 Krilliac"). Chosen to match Krilliac's
other repositories: MIT is the most common license among them (DuetOS,
Lightforge, BrowserGame, SparkTemplates, plus ReSymbol as MIT/Apache-2.0),
ahead of Apache-2.0 (Sonder-runtime, OmegaStrain-Reimplementation) and
GPL-3.0 (Blackice-Server). The holder name "Krilliac" is the one those MIT
files use most. `package.json`, `src-tauri/Cargo.toml` and the Tauri bundle
metadata say `MIT`.

## 2026-09-26 — Lockfiles

Supersedes the "Lockfile" bullet above. `package-lock.json` and
`src-tauri/Cargo.lock` are committed and CI installs with `npm ci` and runs
`cargo check/test --locked`.

- Both files are generated by `.github/workflows/lockfiles.yml`, a manual
  `workflow_dispatch` job that commits them to a named feature branch (never
  `main`) for review in a normal PR. This keeps large generated files
  byte-exact; they are never retyped through the GitHub API.
- npm: Node 22 / npm 10.9.8, `npm install --package-lock-only
  --legacy-peer-deps --ignore-scripts` (the `.npmrc` setting still applies).
  Checked with `npm ci` on Node 22 / npm 10.9.8 and Node 20 / npm 10.8.
- Cargo: stable Rust with `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback`,
  so crates that declare a newer `rust-version` than 1.85 are avoided where an
  older compatible release exists. The lock does not build with rustc 1.85:
  `yoke-derive` 0.8.3 needs 1.87 but does not declare it. CI uses stable Rust,
  so `rust-version = "1.85"` is not enforced; raise it or pin crates if an
  MSRV matters.
- To refresh: create a feature branch, run the workflow with that branch name,
  then open a PR.

## 2026-09-26 — Sonder-Inference event shapes

See [telemetry schema](telemetry-schema.md). Observatory now accepts the
shapes Sonder-Inference `b2170c0` emits without changing the envelope schema.
Shared readers live in `src/query/attributes.ts`.

- Sequence streams are keyed by producer instance when the event reveals it
  (`producer.instance_id`, or an `<instance>-<sequence>` event id), because
  Inference numbers all of its sessions from one counter. This refines the
  "Replay ordering" entry.
- Memory: `used_bytes`/`total_bytes`, or `total_bytes - available_bytes`, or
  `used_fraction`. Dropped telemetry: `dropped_count` or `dropped_events`.
  This refines the "Metrics provenance" entry.
- Token metrics still count `inference.token.generated` events. Inference
  emits one per streamed chunk, so backend-reported counts
  (`request.*.completion_tokens` with `token_counts_from_backend: true`) are
  kept separately as `RequestSpan.backendTokens` and `tokens.backendReported`.
  The token card doesn't show them yet.
- model-churn ignores `model.load.completed` events that carry a
  `request_id` (request-scoped load reports such as Ollama `load_duration`).
- `engine.*` events are in the `session` timeline class. `session.created`
  may declare `text_capture`, like `session.started`.
- Since PR #8 the renderer imports `src/integrations/desktop.ts` for the
  desktop/browser mode badge, so `@tauri-apps/api/core` is in the web bundle
  (this updates the "Runtime dependencies" bullet).

## Open questions

- Protocol package ownership and compatibility/version policy (Milestone 0).
- Producer attribute names for token counts, memory/compute samples, tool
  call ids and dropped-event counts.
- Live transport handshake: capability token, resume-from-sequence, and
  producer capability advertisement at session start.
- Redaction/capture policy field in `session.started` (the manifest reads
  `attributes.text_capture` if present, otherwise records `unspecified`).
