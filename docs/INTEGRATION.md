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
  Runtime endpoint    ws://127.0.0.1:<port>
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

1. Flutter requests/reads the active runtime telemetry endpoint.
2. Runtime creates or returns a session capability.
3. Flutter either:
   - opens bundled Observatory web renderer in WebView, or
   - launches Observatory executable with endpoint/session arguments.
4. Observatory performs protocol negotiation.
5. Runtime emits `session.started` + capability descriptor.
6. Viewer begins live consumption.

Illustrative launch contract:

```text
sonder-observatory
  --endpoint ws://127.0.0.1:49152/telemetry
  --session ses_...
  --capability <short-lived-token>
```

Do not put long-lived secrets in process arguments on platforms where other users/processes can inspect them; prefer inherited handles/files/IPC as implementation matures.

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

Observatory joins both using session/run/request/agent correlation IDs.
