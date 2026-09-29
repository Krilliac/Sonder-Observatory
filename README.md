# Sonder Observatory

[![CI](https://github.com/Krilliac/Sonder-Observatory/actions/workflows/ci.yml/badge.svg)](https://github.com/Krilliac/Sonder-Observatory/actions/workflows/ci.yml)
[![E2E](https://github.com/Krilliac/Sonder-Observatory/actions/workflows/e2e.yml/badge.svg)](https://github.com/Krilliac/Sonder-Observatory/actions/workflows/e2e.yml)

Sonder Observatory is a viewer for telemetry events emitted by
[Sonder Runtime](https://github.com/Krilliac/Sonder-runtime) and
[Sonder-Inference](https://github.com/Krilliac/Sonder-Inference). It ingests
live event streams or recorded sessions and shows them as a timeline, an event
table, diagnostics, an agent topology, a comparison of two runs and a 3D view
of the inference request pipeline. It runs in a browser (Vite web app) or in a
Tauri desktop shell.

Website: <https://sondercore.si>

Observatory only displays what producers report. It does not access model
internals and does not show a model's chain of thought; views that need data a
producer does not send (for example per-layer telemetry) say so instead of
drawing placeholders.

## Capabilities

- **Live ingest** from several producers at once over WebSocket, SSE or NDJSON,
  with producer discovery (`/.well-known/sonder-telemetry`), bearer tokens,
  reconnect with resume, and per-producer status cards
  ([docs/integration/live-ingest.md](docs/integration/live-ingest.md)).
- **Recording and replay**: `.sobs` recordings (also `.ndjson`, `.jsonl`,
  `.json`), replay with a scrubber, large recordings loaded in chunks
  ([docs/RECORDING_FORMAT.md](docs/RECORDING_FORMAT.md)).
- **Views**: Overview (metric cards and timeline), Events (table and evidence
  inspector), 3D Inference, Diagnostics, Agents (topology) and Compare
  (baseline against candidate).
- **3D Inference** (`src/inference3d`, three.js, loaded on demand): request
  pipeline stages by model and node, KV-cache pools, and layer, operator and
  sampling data only when a producer sends them
  ([docs/integration/inference3d.md](docs/integration/inference3d.md)).
- **Scrub and live indexes** for metrics, topology, timeline and inspector
  lookups, so scrubbing and live appends do not recompute the whole session.
  Measurements and budgets are in
  [docs/integration/perf.md](docs/integration/perf.md).
- **Export**: HTML report, Markdown summary, findings and metrics JSON, or a
  `.sobs` range, with a confirmation step when a session contains captured text
  or tool payloads ([docs/integration/export.md](docs/integration/export.md)).
- **Desktop shell** (`src-tauri/`, Tauri v2): native open and save dialogs,
  recent recordings and a `--connect` / `--token-file` / `--open` launch
  contract ([src-tauri/README.md](src-tauri/README.md)).

Not implemented: Flutter embedding. Tauri bundling (`tauri build`) is not
verified; see [docs/ROADMAP.md](docs/ROADMAP.md).

## Requirements

- Node.js 20.19 or later (`engines` in `package.json`; CI tests Node 20 and 22)
  and npm.
- For the desktop shell: Rust 1.88 or later and the Tauri platform
  prerequisites listed in [src-tauri/README.md](src-tauri/README.md).

## Install

```bash
git clone https://github.com/Krilliac/Sonder-Observatory.git
cd Sonder-Observatory
npm ci
```

## Run

```bash
npm run dev          # web app at http://127.0.0.1:5173, loads the synthetic fixture
npm run build        # type check and production bundle in dist/
npm run preview      # serve dist/ at http://127.0.0.1:4173
npm run tauri dev    # desktop shell around the dev server
```

`npm run dev`, `npm run build` and `npm test` first regenerate the synthetic
fixture `fixtures/synthetic-session.ndjson` (`npm run fixture` does it on
demand). Fixture data is labelled synthetic in the UI
([fixtures/README.md](fixtures/README.md)). `npm run fixture:large` writes
seeded 10k, 100k and 1M event recordings to `artifacts/fixtures/`.

Live mode without Sonder, using the synthetic fake producer:

```bash
npm run fake-live-producer    # discovery and /sse, /ndjson, /ws on http://127.0.0.1:8766
# then open http://127.0.0.1:5173/?connect=http://127.0.0.1:8766
```

Options include `--role runtime|inference`, `--token-file PATH`,
`--pace timeline|burst` and `--disconnect-after N`; see the header of
`scripts/fake-live-producer.mjs`.

URL parameters: `?connect=<url>` (repeatable), `?fixture=0`,
`?view=overview|events|3d|diagnostics|agents|compare`, `?theme=light|dark`.
Tokens are never accepted in URLs; `token` and `access_token` parameters are
removed with a warning. The UI reference is [docs/UX.md](docs/UX.md).

## Connecting to Sonder Runtime and Sonder-Inference

Observatory runs as a separate process and only consumes versioned events. The
producers implement the live producer protocol in
[docs/TELEMETRY_PROTOCOL.md](docs/TELEMETRY_PROTOCOL.md) (JSON Schemas in
[protocol/](protocol/)). Both publish a discovery document, so base URLs are
enough. The Sources panel presets are Sonder Runtime at
`http://127.0.0.1:11435` and Sonder-Inference at `http://127.0.0.1:11437`:

```text
http://127.0.0.1:5173/?connect=http://127.0.0.1:11435&connect=http://127.0.0.1:11437
```

Each producer must allow the viewer's origin (CORS):

- Sonder-Inference: `sonder-infer serve --cors-origin <origin>`.
- Sonder Runtime: `SONDER_OBSERVATORY_ORIGINS` (telemetry routes only);
  runtimes without that setting use `SONDER_CORS_ORIGINS`, which also opens
  admin routes to that origin.

Plain `http://` and `ws://` are accepted only for loopback hosts. Details:
[docs/INTEGRATION.md](docs/INTEGRATION.md).

The unit tests run against the fake producer, not the real producers.
`npm run test:ecosystem` builds and runs Sonder-Inference and Sonder Runtime
locally and checks them against Observatory in Playwright (Linux or macOS;
[docs/integration/ecosystem-e2e.md](docs/integration/ecosystem-e2e.md)).
`tests/conformance/` checks a running producer when `SONDER_CONFORMANCE_URLS`
is set ([tests/README.md](tests/README.md)).

## Project layout

| Path | Contents |
| --- | --- |
| `src/protocol/`, `protocol/` | Event and discovery types, validators, JSON Schemas |
| `src/ingest/`, `src/transport/` | Live producer clients and connection manager |
| `src/recording/`, `src/replay/` | `.sobs` and NDJSON recordings, session store, replay cursor |
| `src/query/` | Metric derivation and metrics index |
| `src/renderer/` | App shell, timeline, event table, panels |
| `src/inference3d/` | 3D Inference view |
| `src/diagnostics/`, `src/topology/`, `src/compare/`, `src/inspector/`, `src/export/` | Diagnostics, agent topology, run comparison, evidence inspector, export |
| `src/integrations/` | Tauri desktop bridge |
| `src-tauri/` | Tauri v2 desktop shell (Rust) |
| `scripts/` | Fixture generators, fake producers, ecosystem test orchestrator |
| `tests/`, `e2e/` | Vitest unit tests, Playwright end-to-end tests |
| `docs/`, `design/` | Architecture, protocol, UX, decisions, design tokens |

## Development and testing

```bash
npm run lint         # ESLint, then npm run typecheck
npm run typecheck    # tsc --noEmit with TypeScript 7 (typescript-native)
npm test             # Vitest unit tests (vitest run)
npm run build        # type check and production bundle
npm run test:e2e     # Playwright; install a browser first: npx playwright install chromium
```

CI ([ci.yml](.github/workflows/ci.yml)) runs lint, unit tests and build on
Node 20 and 22, plus `cargo check` and `cargo test` for `src-tauri/` on
Windows. [e2e.yml](.github/workflows/e2e.yml) runs the Playwright suite in
Chromium. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/integration/e2e.md](docs/integration/e2e.md).

## Links

- Website: <https://sondercore.si>
- Sonder Runtime: <https://github.com/Krilliac/Sonder-runtime>
- Sonder-Inference: <https://github.com/Krilliac/Sonder-Inference>
- Documentation index: [docs/README.md](docs/README.md)

## License

Apache License 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
Third-party dependencies keep their own licenses.
