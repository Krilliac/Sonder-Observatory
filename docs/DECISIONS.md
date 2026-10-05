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
  `npm run typecheck`: the TypeScript 7 native compiler (`typescript-native`,
  strict, `noUncheckedIndexedAccess`). `typescript` stays on 6.x only as the
  compiler API typescript-eslint loads, until it supports TS 7.
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

## 2026-09-26 — License changed to Apache-2.0

Supersedes the "License" entry above, at the owner's request. `LICENSE` holds
the standard Apache License 2.0 text, and `NOTICE` reads "Sonder-Observatory,
Copyright 2026 Nate Witkowski". `package.json`, `src-tauri/Cargo.toml` and the
Tauri bundle metadata say `Apache-2.0`.

## 2026-09-26 — Rust MSRV 1.87

`src-tauri/Cargo.toml` now says `rust-version = "1.87"`. The committed
`Cargo.lock` already needed 1.87 (`yoke-derive` 0.8.3, see "Lockfiles"), and CI
builds with stable Rust. This replaces pinning `yoke-derive` to an older
release.

Update: raised to `rust-version = "1.88"` because the committed `Cargo.lock`
pins `time` 0.3.55 (dependabot #9), whose `time`, `time-core` 0.1.9 and
`time-macros` 0.2.32 all declare `rust-version = "1.88.0"` (ported from #21).

## 2026-09-26 — Live ingest in the renderer

The renderer connects through `src/ingest/live` (`connectLiveSession`) instead
of `src/transport/live.ts`'s `LiveConnection`. The endpoint field takes
`ws(s)://` and `http(s)://` (SSE or NDJSON), checked by `resolveEndpoint`.
`#live-status` shows `describeStatus()` (reconnecting, dropped counts), and
renders stay batched in `requestAnimationFrame`. `src/transport/live.ts` stays
for the `WebSocketLike` types and `DEFAULT_ENDPOINT`. The Tauri CSP
`connect-src` also allows loopback `http://` and `https:`. In the desktop
shell, `--connect <ws-url>` starts the same connection through
`ObservatoryApp.connectLive()`, and `--open` wins when both are given.

## 2026-09-26 — Live producer protocol v1

Implements Observatory's part of the Sonder ecosystem integration contract v1
(sections 5 to 8). The full protocol is in
[telemetry protocol](TELEMETRY_PROTOCOL.md), "Live producer protocol v1".
Recorded for owner review: it resolves the protocol-ownership and handshake
questions that were open below.

- **Ownership.** Observatory owns the telemetry shapes in `protocol/`: the
  envelope (`sonder.observatory.event/1`, now declaring the additive optional
  `producer.instance_id`, `role` and `synthetic`) and the discovery document
  (`sonder.telemetry.producer/1`). Each producer owns its event-vocabulary doc.
  Additive changes stay within a major; renames and removals need a new major
  that lands in `protocol/` first. Schema first, then the TypeScript mirror
  and its drift test, then consumers.
- **SSE-first producers.** Sonder Runtime and Sonder-Inference serve
  telemetry as SSE (default) and NDJSON over HTTP GET, not WebSocket: a
  browser cannot send `Authorization` on a WebSocket handshake, and HTTP
  avoids in-house WebSocket framing in the producers. Observatory keeps its
  WebSocket client for other producers.
- **Direct multi-producer connections.** Observatory connects to each
  producer itself (`LiveConnectionManager`, one `LiveIngestClient` per
  producer, one shared `SessionStore`) and correlates them: replay order is
  `mono_ns` (host-monotonic, same host only) then `sequence`; a Runtime turn
  id is the Inference request's `run_id` and `parent_request_id`. Runtime does
  not relay Inference telemetry. Metrics key request spans by
  (producer stream, `request_id`).
- **Discovery document.** `GET /.well-known/sonder-telemetry` names the
  producer (including `instance_id`, `role`, `synthetic`), its streams, resume
  window, auth and clock. A base URL resolves through it; a stream URL still
  works directly. Observatory refuses another discovery major or event schema
  with a message. Validation is the hand-written `validateDiscovery` (no
  JSON-Schema library, per "Runtime dependencies"), kept aligned by
  `tests/protocol-discovery-drift.test.ts`.
- **Resume.** `event_id = <instance_id>-<sequence>`; `Last-Event-ID` (over
  `?last_event_id=`) resumes within the same instance; another instance
  replays the retained window; a lost window is announced as
  `: resume-gap <from>-<to>`.
- **Token handling.** Bearer tokens are per producer, in memory only, sent as
  `Authorization` on HTTP requests to that producer, never in URLs, argv,
  logs or storage, never over WebSocket, never to a stream on another origin.
  Plain `http://` / `ws://` to non-loopback hosts, URL credentials and
  `token` / `access_token` query parameters are refused (this replaces the
  earlier warning-only behaviour for remote plain endpoints). The desktop
  shell's `--token-file` binds to the `--connect` it follows.
- **Drop accounting.** `telemetry.dropped` counts are cumulative per producer
  instance: metrics and `.sobs` manifests take the latest value per instance
  and sum over instances; a report without a count no longer counts as 1.
  Per-subscriber stream losses are not `telemetry.dropped` (they show as
  sequence gaps).
- **Conformance.** `tests/conformance/` checks a running producer
  (`SONDER_CONFORMANCE_URLS`); the fake producer's `--role` modes conform.
  CORS answers must echo the origin exactly with `Vary: Origin` (a wildcard
  fails), the first SSE line must be `retry: 2000`, and
  `SONDER_CONFORMANCE_DENIED_ORIGIN` checks that another origin gets 403
  `forbidden_origin`.
- **Envelope producer fields.** Declaring `producer.instance_id`, `role` and
  `synthetic` in the envelope schema is a deliberate v1 tightening, not a
  purely additive change: before, any value was accepted as an additional
  property; now `null` ("not stated") or the declared type is accepted and
  any other type rejects the event. Producers must honour these types.
- **No redirects.** Discovery and stream requests never follow redirects,
  so the endpoint policy (loopback-only plain http/ws, no credentials or
  token parameters) cannot be bypassed by a producer redirecting elsewhere.
  Discovery documents are capped at 64 KiB.
- **Single-URL path resolves discovery.** `LiveIngestClient` (and so
  `connectLiveSession` and the desktop `--connect` launch through the
  current renderer) resolves a base or discovery URL through the discovery
  document, so a Runtime or Inference base URL works before the renderer
  moves to `LiveConnectionManager`.
- **Tokens and argv.** Only file-sourced tokens (`--token-file` /
  `--capability-file`) authenticate launched URLs; the legacy argv
  `--capability` is passed through for old frontends but never used as a
  bearer token. Tokens are printable ASCII without spaces, checked the same
  way in the shell and in the manager.

## 2026-09-27 — Token counts: chunks are not tokens

Supersedes the token sentences of "Metrics provenance" and the "Token metrics
still count" bullet of "Sonder-Inference event shapes". Found against a live
Sonder Inference (qwen3:14b over Ollama): 15 chunk events for a request whose
backend reported 463 completion tokens showed as "33 tokens", and the overall
rate divided by the whole session span showed "0.0 tok/s".

- `inference.token.generated` counts only when `unit` is `"token"` (or absent,
  for older producers); `unit: "chunk"` and any other unit are output events,
  never tokens (`outputTokenCount`, src/query/attributes.ts).
- A request's token count is its backend count (`completion_tokens` with
  `token_counts_from_backend`) when reported, else its token events. The
  total is backend counts plus event counts of the other requests, labelled
  `backend-reported`, `derived`, `mixed` or `unavailable` (chunks only).
- The overall rate is decode tokens over the summed request decode windows:
  `backend_eval_ms`, else `total_ms - ttft_ms`, else first output to the end
  (tokens after the first one for the last two, as Sonder-Inference's bench
  computes it). With hidden thinking, `ttft_ms` includes the thinking time, so
  the fallbacks can overstate the rate; `backend_eval_ms` does not.
- The trailing-window rate counts token events in the window plus backend
  counts spread evenly over their decode window.
- `sampling.sampled` is not used: every producer sets it on every event
  (including the synthetic fixture's per-token events), so excluding sampled
  events would zero every count.

## 2026-09-27 — three.js and the 3D Inference view

Supersedes the "3D" bullet of "Web toolchain". At the owner's request the
viewer gets a "3D Inference" tab (docs/integration/inference3d.md).

- **Dependency:** `three` `0.186.1` (MIT), pinned exactly, the first 3D
  runtime dependency; `@types/three` `0.186.0` (MIT) is a dev dependency
  (it pulls type-only helpers: `@types/webxr`, `@types/stats.js`,
  `meshoptimizer`, `fflate`, `@tweenjs/tween.js` (MIT) and
  `@dimforge/rapier3d-compat` (Apache-2.0), none bundled). WebGL 2 only
  (three r163+); without it the tab shows a 2D summary. WebGPU stays a
  proposal.
- **Bundle:** three is imported only by `src/inference3d/scene.ts` and the
  tab is loaded with `import()`, so it is its own chunk:
  `inference3dPanel-*.js` 605.99 kB (154.41 kB gzip) plus 10.24 kB CSS.
  The main chunk has no three code; it went from 509.63 kB (74.12 kB gzip) to
  519.88 kB (77.42 kB gzip) for the UX refresh (metric strip, sparkline
  series, status chips) and the health-link reader.
- **CSP:** three is bundled locally (no CDN). The chunk contains no `eval` or
  `new Function`, so the Tauri CSP (`script-src 'self'`, no
  `unsafe-eval`) is unchanged; WebGL needs no CSP source. Labels use inline
  `style` attributes, already allowed by `style-src 'unsafe-inline'`.
- **Semantics:** depth is the reported request pipeline (Runtime route,
  queue, prefill, decode, output), not transformer layers. Layer planes,
  operators and token alternatives are drawn only from
  `backend.layer.*`, `backend.operator.*` and
  `inference.sampling.candidates`, whose names were already in this
  repository's taxonomy; their attribute shapes are proposed in
  TELEMETRY_PROTOCOL.md for Sonder-Inference, which emits none of them yet.
  When a panel cannot be fed, the tab names the producer, backend and
  capability that is missing.
- **Capabilities:** read from `backend.registered` in the stream and, for
  live connections, from the discovery `links.health` document (same origin
  only, the producer's token, no redirects, 64 KiB cap, silent on failure).
- **Design tokens:** added the design-board neutral scale (`neutral.n900` …
  `n100`), `font.size.xxl` (24 px) and Inter first in the sans stack. Inter is
  not bundled (no font download, CSP `font-src 'self' data:`); machines
  without it fall back to Segoe UI Variable / system-ui.

## 2026-10-04 — supported Node toolchain

Supersedes the Node and Vitest version choices in "Web toolchain". The
installed Vitest 5 requires Node 22.12+, 24, or 26+, and ESLint 10 requires
22.13+ on the Node 22 line. The package engine is their intersection:
`^22.13.0 || ^24.0.0 || >=26.0.0`. CI tests the supported Node 22 and 24
release lines. Node 20 is no longer a supported development toolchain;
a passing individual test on it does not establish dependency support.

## 2026-10-04 — protected legacy compatibility and bounded test concurrency

Main's branch protection still requires `check (20)`, so CI retains a real
Node 20 lane alongside Node 22 and 24. The development engine declaration
remains unchanged: upstream Vitest 5 does not declare Node 20 support.
Installation on Node 20 emits those engine warnings rather than concealing
them. The legacy lane runs all normal lint, unit and build checks.

Unit tests default to two concurrent workers. Starting many workers on a
shared large host inflated existing timing checks; limiting concurrency keeps
memory and CPU contention bounded. All tests and their original time/throughput
budgets remain enabled. Ordinary HTTP stress also exposed coalesced reads
larger than the event queue; payload consumption now awaits per-event capacity
instead of relying only on capacity before the next network read.

## Open questions

- Producer attribute names for memory/compute samples and tool call ids
  beyond what docs/telemetry-schema.md records.
- A read-only, short-lived telemetry capability issued by Runtime (today
  Runtime telemetry needs admin authorization, granted by local-open
  loopback mode).
- A discovery field for per-subscriber loss counts (for example
  `subscriber_dropped_events`); not pinned by the v1 contract.
- Cross-host clock alignment (v1 merges producers on one host only).
- Discovery `producer.role` and `auth.schemes` are closed enums in the pinned
  contract, so a new producer kind or auth scheme (for example a
  Runtime-issued telemetry capability) forces `sonder.telemetry.producer/2`.
  Owners to decide: keep them closed (new values need /2), or relax them to
  strings with known values documented, consumers ignoring unknown schemes
  and roles.


## 2026-10-04 — Diagnostics presentation bounds

The Diagnostics finding/evidence lists use 50-item pages instead of mounting
every row/button. All derived findings/evidence stay in the model and exports;
selection highlights all evidence, and keyboard navigation crosses pages.
The renderer cache tracks the controller's presentation revision. This bounds
these DOM lists only; detector evaluation and recording retention are unchanged.
See [the integration contract](integration/diagnostics-pagination.md).

## 2026-10-05 — Derived request parent lineage

The Inspector resolves parent evidence across events of the same producer
stream and request ID, because Inference reports `parent_request_id` on
request lifecycle events while output events retain only the request ID.
Conflicting observed parents or runs withhold the derived parent group;
original fields remain unchanged. Known request runs exclude conflicting
parent runs, and absent run metadata remains unknown. Compatible parent
instances can appear as multiple evidence candidates in the Inspector.

The 3D request join preserves distinct Runtime instances instead of indexing
one last parent by bare request ID. It draws a parent line only for one
compatible retained Runtime entity, and withholds conflicting or ambiguous
lineage. This changes consumer derivations only, with no producer contract,
schema, session/run override, consent or execution-state changes.
