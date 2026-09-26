# Sonder Observatory

**Sonder Observatory** is the visualization, replay, and diagnostics companion for the Sonder ecosystem.

It turns structured runtime telemetry into an explorable view of inference, context/KV-cache behavior, model routing, agent orchestration, tool calls, retries, compaction, memory retrieval, and resource pressure.

> Observatory is an observability product, not a claim to expose a model's private chain-of-thought. Visualizations must be grounded in events, metrics, model outputs, or instrumentation the runtime actually exposes.

## Project role

```text
Sonder Runtime / Sonder Inference
             |
      versioned telemetry
             |
             v
    Sonder Observatory
       |           |
   live view     replay
       |           |
   3D inference  agent topology
   diagnostics   event timeline
```

Observatory is intended to remain a separate repository and process so renderer failures or GPU-heavy visualization cannot destabilize inference. Sonder's Flutter application can launch it standalone or host its web renderer in an embedded view.

## Core experiences

- **Live inference space** — token/prefill/decode flow, layers when instrumented, KV-cache state, probabilities, latency, throughput, memory pressure, and device placement.
- **Sonder space** — agent topology, model routing, context transfer, memory retrieval, tool calls, retries, critic/synthesis lanes, and distributed workers.
- **Replay** — deterministic inspection of recorded telemetry with a scrubber, event filters, state snapshots, and comparative runs.
- **Diagnostics** — token-budget pressure, compaction, no-progress loops, duplicate workers, cache thrash, model load/unload churn, and latency/resource hotspots.
- **Embedded + standalone UX** — launch from Sonder Flutter, pop out into a dedicated window, or attach to a remote/local telemetry endpoint.

## Repository map

- `docs/ARCHITECTURE.md` — process boundaries and component design
- `docs/UX.md` — product/interaction design
- `docs/TELEMETRY_PROTOCOL.md` — event envelope and semantics
- `docs/INTEGRATION.md` — Flutter, Runtime, and Sonder-Inference integration
- `docs/SECURITY_PRIVACY.md` — redaction, storage, and safe observability
- `docs/ROADMAP.md` — phased build plan
- `docs/RESEARCH.md` — research and upstream references
- `design/` — visual-system notes/tokens
- `docs/assets/concepts/` — generated concept art used as design references
- `docs/DECISIONS.md` — toolchain, protocol-mirror, ordering, and metric decisions
- `docs/RECORDING_FORMAT.md` — `.sobs` recording container
- `protocol/` — event envelope JSON Schema (source of truth)
- `src/` — Milestone 1 web app (protocol mirror, transport, recording, replay, query, inspector, renderer)
- `fixtures/` — synthetic telemetry fixture (clearly labeled synthetic)
- `scripts/` — fixture generator and dev fake producer
- `tests/` — Vitest unit tests

## Design principles

1. **Grounded visuals over pretty fiction.** Never label synthetic geometry as literal internal reasoning.
2. **Zero-observability mode remains cheap.** Instrumentation must be bounded and sampling-aware.
3. **Renderer isolation.** Observatory is never in the critical inference path.
4. **Replayability.** Events use stable IDs, clocks, schema versions, and session/run boundaries.
5. **Cross-runtime compatibility.** The protocol can describe Sonder-Inference, llama.cpp-backed execution, Ollama compatibility mode, remote nodes, and future backends.
6. **Useful at multiple scales.** From one token to an entire multi-agent/distributed session.
7. **Privacy by default.** Payload capture is opt-in or redacted; metrics/events should work without retaining raw prompts.

## Relationship to Sonder-Inference

Sonder-Inference is the preferred telemetry producer and owns inference scheduling, cache/model lifecycle, and device execution policy. Observatory consumes versioned events and must not reach into engine internals directly.

See **Krilliac/Sonder-Inference** for the execution-engine research and architecture.

## Status

Milestone 1 in progress (2026-09-26): a small, trustworthy live viewer + replay
recorder, web renderer first, before heavier 3D interpretation layers. What
exists: Overview (metric cards and event timeline), Events (table and evidence
inspector), Diagnostics and Agents views; live ingest from several producers at
once (WebSocket, SSE, NDJSON, with producer discovery and bearer tokens), a
Sources panel and producer cards, an onboarding empty state, light and dark
themes, keyboard shortcuts, the `.sobs` recorder, replay with a scrubber, a
synthetic fixture and a Tauri desktop shell in `src-tauri/`. Not yet: Tauri
bundle, Flutter embedding, 3D views. The live producer protocol that Sonder Runtime
and Sonder-Inference implement on their side is
[docs/TELEMETRY_PROTOCOL.md](docs/TELEMETRY_PROTOCOL.md); this repository tests
against its synthetic fake producer, not against those producers; what the UI does is in
[docs/UX.md](docs/UX.md). See [roadmap](docs/ROADMAP.md) and
[decisions](docs/DECISIONS.md).

## Quickstart

Requires Node.js 20.19+ (or 22.12+) and npm.

```bash
npm ci              # install from package-lock.json
npm run dev         # http://127.0.0.1:5173 — opens with the synthetic fixture
npm test            # Vitest unit tests
npm run lint        # ESLint + TypeScript type check
npm run build       # type check + production bundle in dist/
npm run test:e2e    # Playwright end-to-end suite (docs/integration/e2e.md)
npm run tauri dev   # desktop shell (needs a Rust toolchain; see src-tauri/README.md)
```

Live mode with the dev fake producer (replays the fixture; the data stays
labelled synthetic):

```bash
npm run fake-live-producer -- --pace timeline   # http://127.0.0.1:8766 (discovery),
# /sse, /ndjson and /ws on the same port; --role runtime|inference relabels the
# stream as that producer, --token-file PATH requires a bearer token,
# --disconnect-after 100 shows reconnect + resume on the producer card
# then open http://127.0.0.1:5173/?connect=http://127.0.0.1:8766
```

## Using the viewer

- **Sources** (sidebar, toggled by the **Sources** button): enter a producer
  URL, pick a transport (Auto uses the producer's discovery document), add a
  bearer token if the producer needs one, press **Test** to check it without
  ingesting, then **Connect**. Presets list the local defaults (Runtime 11435,
  Inference 11437, fake producer 8766); the last eight URLs are remembered
  (URL and transport only, in this browser's localStorage).
- **Producers**: one card per connection with its state (connecting, live,
  reconnecting, failed, disconnected), counters (received, appended, dropped,
  rejected, buffered, reconnects), last error and what to change, and
  Disconnect. Events already received stay after a disconnect. Several
  producers merge into one session in replay order.
- **Views**: Overview (cards and timeline with a legend and a text summary),
  Events (table with a producer column; the filter matches event type, ids,
  request, run, agent and producer), Diagnostics and Agents. The inspector is
  docked beside every view and lists related events across producers (same
  request, parent and child requests, same run, agent, tool call).
- **No source**: the empty state can look for local producers (1 s per
  preset), open a recording, or load the synthetic demo. Recordings
  (`.sobs`, `.ndjson`, `.jsonl`, `.json`) can also be dropped on the window.
- **Keyboard**: `?` lists shortcuts: Space play/pause, J/K next/previous
  event, `]`/`[` next/previous error, `/` filter, F follow latest, T theme.
  They are off while typing in a field.
- **Theme**: follows the system; the theme button (or T) switches and is
  remembered in this browser.

URL parameters:

| Parameter | Effect |
| --- | --- |
| `?connect=<url>` | Connect a producer; repeat for several. Base URL (discovery), discovery URL or stream URL. |
| `?ws=<url>` | Legacy alias of `connect`. |
| `?fixture=0` | Start without the synthetic fixture (onboarding). |
| `?view=overview\|events\|diagnostics\|agents` | Open that view. |
| `?theme=light\|dark` | Theme for this load (not saved). |

`token` and `access_token` parameters are ignored with a visible warning and
removed from the address bar: tokens are typed into the Sources panel (or given
to the desktop shell with `--token-file`), kept in memory only, and never put
in URLs, storage or logs.

### Connecting to Sonder Runtime and Sonder-Inference

Both producers publish `/.well-known/sonder-telemetry`, so their base URLs are
enough: `?connect=http://127.0.0.1:11435&connect=http://127.0.0.1:11437`.
The browser needs each producer to allow the viewer's origin (for example
`http://127.0.0.1:5173` for `npm run dev`, `http://127.0.0.1:4173` for
`vite preview`):

- **Sonder-Inference** allows the Observatory dev, preview and desktop origins
  by default; add others with `sonder-infer serve --cors-origin <origin>`.
- **Sonder Runtime** has no default: add the origin to the setting its docs
  name for telemetry routes (`SONDER_OBSERVATORY_ORIGINS` where available;
  `SONDER_CORS_ORIGINS` otherwise, which also opens its admin routes to that
  origin).

When a connection or **Test** fails for one of these reasons, the message names
the setting to change or says a token is needed. Plain `http://` and `ws://`
are accepted only for loopback hosts.

## Repository scaffold

See [scaffold status](docs/SCAFFOLD.md), [source workspace](src/README.md),
and [ecosystem boundaries](docs/BOUNDARIES.md).

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See
[NOTICE](NOTICE). Third-party dependencies keep their own licenses.
