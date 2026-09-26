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
exists: metric cards, event timeline, event table + evidence inspector, live
ingest (WebSocket, SSE, NDJSON), `.sobs` recorder, replay with scrubber, and a synthetic
fixture, plus agent topology and diagnostics tabs (Milestone 2) and a Tauri
desktop shell in `src-tauri/`. Not yet: Tauri bundle, Flutter embedding, 3D
views, real producer integration. See [roadmap](docs/ROADMAP.md) and
[decisions](docs/DECISIONS.md).

## Quickstart

Requires Node.js 20.19+ (or 22.12+) and npm.

```bash
npm ci              # install from package-lock.json
npm run dev         # http://127.0.0.1:5173 — opens with the synthetic fixture
npm test            # Vitest unit tests
npm run lint        # ESLint + TypeScript type check
npm run build       # type check + production bundle in dist/
npm run tauri dev   # desktop shell (needs a Rust toolchain; see src-tauri/README.md)
```

Live mode with the dev fake producer (replays the fixture over a loopback
WebSocket; the data stays labeled synthetic):

```bash
npm run fake-producer -- --speed 2          # ws://127.0.0.1:8765
# then press Connect in the UI, or open http://127.0.0.1:5173/?ws=ws://127.0.0.1:8765

npm run fake-live-producer -- --pace timeline   # one port, three transports:
# ws://127.0.0.1:8766/ws, http://127.0.0.1:8766/sse, http://127.0.0.1:8766/ndjson
# add --disconnect-after 100 to watch reconnect + resume in the #live-status badge
```

Other options: `?fixture=0` starts empty; **Open recording…** loads a `.sobs`
or `.ndjson`/`.jsonl` file; **Save** writes the current session as `.sobs`;
`npm run fixture` regenerates `fixtures/synthetic-session.ndjson`
deterministically; `npm run fixture:large` writes seeded 10k/100k/1M-event
recordings to `artifacts/fixtures/` for performance work.

The endpoint field accepts `ws(s)://` (WebSocket frames with one JSON event or
several NDJSON lines) and `http(s)://` (Server-Sent Events, or NDJSON lines).
The client reconnects with backoff and asks the producer to resume after the
last event id; see [live ingest notes](docs/integration/live-ingest.md). There
is no capability handshake yet, and the resume parameters are proposals; that
contract is unresolved with Sonder Runtime / Sonder-Inference.

## Repository scaffold

See [scaffold status](docs/SCAFFOLD.md), [source workspace](src/README.md),
and [ecosystem boundaries](docs/BOUNDARIES.md).

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See
[NOTICE](NOTICE). Third-party dependencies keep their own licenses.
