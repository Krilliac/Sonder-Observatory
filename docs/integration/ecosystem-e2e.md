# Ecosystem end-to-end proof (Inference + Runtime + Observatory)

Owned paths: `scripts/ecosystem-e2e.mjs`, `e2e/ecosystem.spec.ts`, this
file, the `test:ecosystem` entry in `package.json` and the
`E2E_CHROMIUM_PATH` / `E2E_ECOSYSTEM` handling in `playwright.config.ts`
(this lane acts as the integrator for those two root files).

`npm run test:ecosystem` proves, on one host and with nothing but loopback
traffic, that the three Sonder repositories work together:

1. Sonder-Inference is built offline (mock backend: no weights, no network)
   and serves its HTTP API and live telemetry.
2. A Sonder Runtime with isolated state and **no Ollama** is bound to it
   (`SONDER_MODEL_BACKEND=sonder-inference`) and answers real chat turns
   through both chat paths.
3. Both producers pass the live producer conformance suite.
4. The Observatory, in Playwright, shows both producers live, correlates one
   Runtime turn with the Inference request it caused, labels the mock output
   synthetic, saves and replays the session, and passes an axe scan.
5. The Runtime Flutter app parses the ecosystem document the Runtime served.
6. Negative controls show the checks can fail.

Everything the mock backend produces is synthetic word salad. The run asserts
presence, correlation and labelling only; it is never a quality or
performance signal.

## Prerequisites

- Linux or macOS (the orchestrator uses POSIX process groups).
- Node 22.x (22.13 or newer), 24.x or 26+ as declared in `package.json`, and `npm ci` in
  this repository. Node 20 is retained only as a legacy CI compatibility lane.
- A Sonder-Inference checkout with the `serve` module, CMake 3.21+, a C++20
  compiler, Ninja optional.
- A Sonder Runtime checkout and a Python with its requirements
  (`requirements-dev.txt`).
- Flutter (for the app step; `--no-flutter` skips it).
- A Chromium Playwright can drive: either `npx playwright install chromium`,
  or an existing build named by `E2E_CHROMIUM_PATH`.
- Free ports 18435, 18436, 18437 and 4173, and nothing listening on Ollama's
  11434 (two controls rely on Ollama being absent).

## Commands

```sh
npm ci
SONDER_INFERENCE_DIR=../sonder-inference SONDER_RUNTIME_DIR=../Sonder-runtime \
SONDER_RUNTIME_PYTHON=/path/to/runtime/venv/bin/python \
E2E_CHROMIUM_PATH=/path/to/chromium FLUTTER_BIN=/path/to/flutter \
E2E_WORKDIR=$(mktemp -d) npm run test:ecosystem
```

Flags (after `--`, e.g. `npm run test:ecosystem -- --skip-build`):

| Flag | Effect |
|---|---|
| `--skip-build` | Reuse `$E2E_WORKDIR/inf/sonder-infer` (or `$E2E_INFERENCE_BIN`) and this repository's `dist/` from an earlier run. |
| `--keep-running` | After the checks, leave Inference and the main Runtime running (the viewer and the extra Runtime are stopped) and skip the teardown gates. `stack.json` in the work dir records them. |
| `--stop` | Stop a stack left by `--keep-running` (needs the same `E2E_WORKDIR`), then exit. |
| `--no-flutter` | Skip the Flutter step. |

Manual negative control 1 against a kept stack (the spec must fail):

```sh
E2E_WORKDIR=$W npm run test:ecosystem -- --skip-build --keep-running
E2E_ECOSYSTEM=1 E2E_RUNTIME_URL=http://127.0.0.1:18435 E2E_INFERENCE_URL=http://127.0.0.1:1 \
  E2E_CHROMIUM_PATH=/path/to/chromium npx playwright test e2e/ecosystem.spec.ts   # must FAIL
E2E_WORKDIR=$W npm run test:ecosystem -- --stop
```

Without `E2E_BASE_URL`, that Playwright run builds and serves the viewer
itself (`playwright.config.ts` web server on 4173). A default
`npx playwright test` (no `E2E_ECOSYSTEM=1`) ignores `ecosystem.spec.ts`.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `SONDER_INFERENCE_DIR` | a sibling `sonder-inference` checkout | Sonder-Inference source tree |
| `SONDER_RUNTIME_DIR` | a sibling `Sonder-runtime` checkout | Sonder Runtime source tree |
| `SONDER_RUNTIME_PYTHON` | `<runtime>/.venv/bin/python`, else `python3` | Python that runs the Runtime |
| `E2E_WORKDIR` | a fresh temporary directory | where every log and artifact goes |
| `E2E_INFERENCE_PORT` / `E2E_RUNTIME_PORT` / `E2E_RUNTIME_ALT_PORT` / `E2E_PORT` | 18437 / 18435 / 18436 / 4173 | Inference, main Runtime, control Runtimes, viewer (origin `http://127.0.0.1:$E2E_PORT`) |
| `E2E_CHROMIUM_PATH` | Playwright's own browser | Chromium executable (`launchOptions.executablePath`) |
| `E2E_INFERENCE_BIN` | build into `$E2E_WORKDIR/inf` | use this `sonder-infer` instead of building |
| `FLUTTER_BIN` | `flutter` on `PATH` | Flutter tool |
| `E2E_RUNTIME_MIN_FREE_DISK_BYTES` | 536870912 | `[state].minimum_free_disk_bytes` in the e2e's own Runtime config (the Runtime default of 5 GiB refuses to start on busy CI disks; the e2e state is a few megabytes) |
| `E2E_GUARD_PATHS` | none (`~/.sonder` is always guarded) | extra directories (`:`-separated) that must be unchanged after the run, for example a host's shared Sonder home |

No path of any particular machine is built in: the repositories default to
sibling checkouts and everything else comes from the environment.

## What runs, and what each gate proves

Gates are recorded in `summary.json` (`gates[]`, `failed[]`, `ok`). The run
exits non-zero if any gate fails.

| Gate | Proves |
|---|---|
| `ports.free`, `ollama.absent` | The fixed ports are ours, and no Ollama can quietly serve a turn. |
| `inference.build` | Inference builds with tests, llama.cpp and TLS off (no FetchContent, so no network) and `sonder-infer version --json` reports `api_version` 1. |
| `observatory.build`, `viewer.start` | `vite preview` serves the production build on the pinned origin. |
| `inference.health`, `inference.discovery`, `inference.identity` | `serve --backend mock` is ready and synthetic; discovery names `sonder-inference` with role `inference`; identity has backend `mock`. |
| `runtime.migrate`, `runtime.start` | `migrate --adopt-epoch2` and `serve --skip-ollama` work on isolated state (`SONDER_HOME`, `SONDER_CONFIG`, `SONDER_SECRETS`, `SONDER_DB`, `SONDER_FLEET_DB`, `SONDER_LIVE_RELOAD=0`, `SONDER_ALLOW_CLOUD=0`), with the viewer origin in the route-scoped `SONDER_OBSERVATORY_ORIGINS` (never the global `SONDER_CORS_ORIGINS`, which would also open admin routes). |
| `runtime.ecosystem` | `GET /v1/sonder/ecosystem` reports `sonder_inference` ready with a mock, synthetic identity, telemetry URLs, export enabled, and both base URLs in `connect_urls`. Saved as `ecosystem.json`. |
| `runtime.doctor` | `doctor --skip-ollama --json` grades `sonder_inference` OK or WARN (synthetic), never FAIL. |
| `turn.chat`, `turn.a2a` | `POST /v1/chat/completions` (the legacy HTTP path, now through the gateway) and `/a2a` `SendMessage` both complete with Ollama absent. The A2A `messageId` is unique per run because `SendMessage` is idempotent per id. |
| `turn.correlation`, `turn.a2a.correlation` | From the recorded NDJSON streams: the Runtime turn `R` (the `X-Sonder-Correlation-Id`) has `request.started`, `route.selected` (provider `sonder_inference`) and `request.completed`; Inference has `request.queued` (kind `chat`, `parent_request_id` `R`), `request.started`, `inference.token.generated` and `request.completed` under `run_id` `R`, all labelled synthetic; Runtime events are not. |
| `conformance` | `tests/conformance` passes for both producers (discovery, CORS preflight and headers, a refused origin, SSE framing, envelopes, event ids and sequences, resume via `Last-Event-ID`, NDJSON), with no test skipped. |
| `playwright.ecosystem` | `e2e/ecosystem.spec.ts`: two live cards through discovery plus SSE; a turn made after connecting shows the Runtime and Inference rows filtered by `R`; the Runtime `request.completed` row relates to Inference events (child and run groups); synthetic badge and banner name `sonder-inference` only; the A2A turn's events are present; received > 0 and rejected = 0 for both; the saved `.sobs` reopens through `#file-input` with the same event count and a manifest listing both producers with their roles; axe WCAG A/AA is clean on the connected Events and Overview views; no uncaught page errors. |
| `negative.runtime-without-origin` | Negative control 2: a Runtime started without the viewer's origin leaves its card `failed`, with advice naming `SONDER_OBSERVATORY_ORIGINS` and `SONDER_CORS_ORIGINS`. |
| `negative.closed-inference-port` | Negative control 1: the same spec, with `E2E_INFERENCE_URL=http://127.0.0.1:1`, fails on the inference card. |
| `flutter.ecosystem` | `flutter test test/ecosystem_status_test.dart` with `SONDER_ECOSYSTEM_JSON` parses the live payload (the test must run, not skip). |
| `inference.sigint`, `inference.engine-stopped` | SIGINT stops Inference with exit 0, and `engine.stopped` reaches the stream before it closes. |
| `negative.inference-down` | Negative control 3: with Inference stopped and no fallback, `/v1/chat/completions` answers 503 promptly, names the base URL, and makes no Ollama attempt (no Ollama route event). |
| `runtime.stop` | The Runtime drains on SIGINT. |
| `negative.fallback-fails-closed` | Negative control 4: a Runtime with `SONDER_INFERENCE_FALLBACK=ollama` and Ollama absent still fails closed, promptly, and its stream shows `route.changed` from `sonder_inference` to `ollama`. |
| `processes.none-left` | No running or stopped members remain in the supervised groups. On Linux, two matching process-state observations distinguish zombie-only remnants awaiting an init reaper; missing, changing or unreadable membership remains unknown/alive. Other POSIX hosts use conservative signal-zero checks. This is cleanup evidence after supervised exit, not an atomic census during arbitrary concurrent spawning. |
| `hygiene.git-status-unchanged`, `hygiene.guarded-paths-untouched` | `git status` of all three repositories is unchanged, and `~/.sonder` plus `E2E_GUARD_PATHS` are untouched. |

## Artifacts (in `E2E_WORKDIR`)

`summary.json`; `inference-build.log`, `observatory-build.log`,
`inference.log`, `runtime.log`, `runtime-noorigin.log`,
`runtime-fallback.log`, `viewer.log`, `*.migrate.log`; `inference-health.json`,
`inference-discovery.json`, `inference-identity.json`, `ecosystem.json`,
`doctor.json`, `chat-response.json`, `a2a-response.json`; the recorded
streams `inference-stream.ndjson`, `runtime-stream.ndjson`,
`runtime-fallback-stream.ndjson`; `conformance.log` and `conformance.json`;
`playwright.log`, `playwright-results.json`, `playwright-report/index.html`,
`test-results/` (traces of failures); `screenshots/` (`e2e-inspector`,
`e2e-connected-events`, `e2e-connected-overview`, `e2e-producers`,
`e2e-replay`, `e2e-negative-cors`); `ecosystem.sobs` and `recording-manifest.json`;
`negative-closed-port/`; `flutter.log`. A rerun in the same work dir moves
the previous run's files to `previous-run-<time>/` (the Inference build is
kept for `--skip-build`).

## Reading failures

- Start with `summary.json`: `failed` lists gate names, and each gate's
  `detail` says what was expected and what was seen.
- `inference.*` failing: read `inference.log` (startup banner, access log)
  and `inference-build.log`.
- `runtime.start` failing: the tail of `runtime.log` is in the detail. A
  `PREFLIGHT FAIL` line names the failed check.
- `turn.*` failing: `chat-response.json` / `a2a-response.json` hold the
  bodies; `runtime.log` has the model-call error. A 503 naming the base URL
  means the Runtime could not reach Inference.
- `turn.correlation` failing: grep `runtime-stream.ndjson` and
  `inference-stream.ndjson` for the turn id in `turns.api_chat_turn_id`.
- `conformance` failing: `conformance.log` lists each failed check by name.
- `playwright.ecosystem` failing: open `playwright-report/index.html`; the
  failing step's trace is in `test-results/`. A card that never reached
  `live` is reported with every card's state and error text.
- A failure whose cause is in Sonder-Inference or Sonder Runtime is fixed in
  that repository; this lane reports it with the logs above.

## Qualified scope (2026-10-04)

A Linux run completed all **30 gates** in 93.1 seconds using the actual
Runtime and Inference servers with Inference's mock backend. Both live
producer conformance tests and both connected-browser tests ran with no
skips; the Flutter live-payload test ran. Chat and A2A correlation,
consented recording/export/replay, the four failure controls and all 14
supervised process-group cleanups passed. Git status and guarded home paths
were unchanged. These are interoperability and cleanup receipts; the
authored mock output does not establish provider or model quality.

The qualified sources are reproducible from these published revisions:

| Repository | Revision | Source tree |
|---|---|---|
| Runtime | `1abf048216d68d02c5a06d18397d5306ebc0ff75` ([PR #663](https://github.com/Krilliac/Sonder-runtime/pull/663)) | `8c35d40e47d31246ef5dafb9e394845f73a90568` |
| Inference | `3bdef59a7fa8bdb202d36b8117f9bb52bd904969` ([PR #53](https://github.com/Krilliac/Sonder-Inference/pull/53)) | `ad65a3bac03af736645f1d3d9eada61102b6db28` |
| Observatory | `0d830ea694750977fc1dde6026a3b077df0956ba` ([PR #47](https://github.com/Krilliac/Sonder-Observatory/pull/47)) | `806bba937f5c1cc19ad59b0803088551263914b2` |

The local Runtime checkout reported `9d5fb14228f3d25de2dfa7cfd043d4f8b290424f`
and the Observatory checkout reported `c7b673d8c871308ca0d6a762495338666ded38eb`;
their trees match the published revisions above exactly. Inference's tested
binary reported `3bdef59a7fa8`. Later merges or documentation edits do not
extend this receipt to different code automatically.

The run's `summary.json` uses schema `sonder.ecosystem.e2e/1`, started at
`2026-10-04T12:54:57.243Z` and finished at `2026-10-04T12:56:30.372Z`, with
`ok: true`, no failed gates, `keepRunning: false` and `noFlutter: false`.
Generated recordings, screenshots and logs remain outside Git. Use a fresh
`E2E_WORKDIR` with the command above to produce the same receipt structure;
gate outcomes, rather than a timing target, determine success.

## Limits

- Same-host only: cross-producer ordering relies on one monotonic clock.
- The Windows and macOS launch paths, remote (TLS) Inference, real model
  backends and real Ollama are out of scope; so is Tauri.
- The run takes a few minutes on an idle machine, most of it the Inference
  Release build; `--skip-build` or `E2E_INFERENCE_BIN` saves that.
