# Sonder Integration

## Repository relationship

Recommended runtime layout:

```text
Sonder-runtime/
  packages/
    observability_protocol/
  apps/
    sonder_flutter/
  external/
    observatory/        -> git submodule Krilliac/Sonder-Observatory
  tooling/
    observatory_launcher/
```

Observatory remains independently cloneable/buildable.

## Important rule

A normal Sonder Runtime checkout/build must work when the Observatory submodule is absent.

```bash
git clone Sonder-runtime
# core runtime still builds

git clone --recurse-submodules Sonder-runtime
# includes companion tools
```

Pin the submodule commit. Do not auto-pull an arbitrary Observatory head at runtime.

## Flutter UX

Developer > Observatory:

```text
Observatory
  Installed           yes/no + version
  Telemetry           connected/disconnected
  Producers           http://127.0.0.1:11435 (Runtime), http://127.0.0.1:11437 (Inference)
  [Open Embedded]
  [Launch Standalone]
  [Open Latest Recording]
```

Settings:

- auto-connect
- local/remote runtime
- record sessions
- telemetry level
- token sampling rate
- history/storage limit
- text capture policy
- theme / reduced motion

## Launch handshake

v1 (live producer protocol, docs/TELEMETRY_PROTOCOL.md). Observatory connects
to each producer directly; Runtime does not relay Inference telemetry. Steps 1
and 2 are the Sonder Runtime / Flutter side (contract sections 9 and 10; they
are specified there and are not part of any merged Runtime release this
document can point to yet); steps 3 and 4 are Observatory's
(`LiveConnectionManager`, docs/integration/live-ingest.md).

1. The Flutter app reads `GET /v1/sonder/ecosystem` from the runtime (admin
   authorization). Its `observatory.connect_urls` lists the base URLs of the
   runtime and of each provider that publishes telemetry (loopback listener
   addresses), and `observatory.warnings` explains missing pieces.
2. Flutter launches Observatory (`LocalManager.launchObservatory(connectUrls)`):
   - Executable, resolved in order: the Settings "Observatory executable",
     env `SONDER_OBSERVATORY_BIN`, then `sonder-observatory` on PATH. It is
     started detached with one `--connect <url>` per URL. Flutter never passes
     tokens or API keys.
   - Otherwise, if an Observatory web URL is configured, the OS opener
     (`xdg-open`, `open`, `cmd start`) opens
     `<webUrl>?fixture=0&connect=<url>&connect=<url>`. The Vite dev server
     (`http://127.0.0.1:5173/`) or the preview build (`:4173`) are the local
     options; which default the app ships is the app's decision.
   - Otherwise the app shows guidance. Web builds show a copyable URL only.
   - When the app talks to a non-loopback runtime, launching is disabled with
     an explanation: producer telemetry is loopback on the runtime host.
3. For each URL, Observatory fetches `/.well-known/sonder-telemetry`,
   validates it (`sonder.telemetry.producer/1`), and opens the SSE stream
   (then NDJSON, then WebSocket). Status in this repo:
   `LiveConnectionManager` does this for every URL it is given, but the
   renderer does not use the manager yet (producer cards and `connectAll`
   wiring are the renderer/UX work, obs-ux-upgrade). Until that lands the
   desktop shell's frontend opens only the first URL (`LaunchInfo.connect`)
   through the single-URL path, which also resolves a base URL through
   discovery but sends no token; further URLs and their tokens are ignored.
4. Each producer replays its retained window, then streams live. Observatory
   merges them in one session and correlates Runtime turns with Inference
   requests by `run_id` and `parent_request_id`.

Desktop launch arguments (src-tauri/src/launch.rs,
docs/integration/tauri-shell.md):

```text
sonder-observatory
  --connect http://127.0.0.1:11435
  --connect http://127.0.0.1:11437 [--token-file <path>]
```

- `--connect` / `--endpoint` are repeatable; `ws`, `wss`, `http`, `https`;
  plain `ws` / `http` only to loopback; credentials and token query
  parameters are rejected.
- `--token-file` (alias `--capability-file`) is read once (max 4 KiB,
  trimmed, printable ASCII without spaces), kept in memory only, never
  logged. It binds to the `--connect` it follows and becomes that producer's
  `Authorization: Bearer` token. Tokens are never taken from the command
  line or URLs: the legacy `--capability <token>` argument is passed to the
  frontend as `capability` for older frontends but never used to
  authenticate a `--connect` URL.
- Browser URL parameters (contract section 8.2, renderer work):
  `?connect=` (repeatable), `?ws=` (legacy alias), `?fixture=0`, `?view=`,
  `?theme=`; `?token=` / `?access_token=` are ignored with a visible warning.
  The manager already refuses any URL that carries a token.

Not specified yet: a short-lived, read-only telemetry capability issued by
Runtime. Until it exists, Runtime telemetry needs Runtime's admin
authorization, which local-open loopback mode grants; see
docs/SECURITY_PRIVACY.md.

## Embedded vs standalone

**Embedded**
- convenient normal workflow
- low-friction inspection
- shares Flutter app navigation
- use conservative GPU/render budgets

**Standalone**
- full 3D scene
- multi-monitor
- long replay/diagnostics
- isolated crash/resource domain
- independent renderer GPU budget

Support "Pop out" from embedded to standalone while retaining the same session/time selection.

## Sonder-Inference

Sonder-Inference is expected to implement the richest producer:

- scheduler
- KV/cache
- model residency
- backend/device
- speculative decode
- distributed transfer

Sonder Runtime contributes orchestration events:

- agents
- routes
- tools
- memory
- budgets
- compaction/recovery

Observatory connects to both directly and joins them using session, run,
request and agent correlation IDs: a Runtime chat turn's id is the `run_id` of
the Inference request it caused, and `attributes.parent_request_id` links the
two requests (docs/TELEMETRY_PROTOCOL.md, "Correlation across producers").
Same-host producers share the host monotonic clock, so their events merge in
time order.
