# 3D Inference tab (src/inference3d)

The "3D Inference" tab (`?view=3d`) draws the request pipeline that Sonder
producers actually report, in three.js, at the replay cursor (live mode
follows the latest event). It is the concept board's "3D Inference View"
(`docs/assets/concepts/standalone-live-inference.png`) with the illustrative
parts replaced by telemetry: model layers, operators and token
probabilities appear only when a producer sends them.

## What the scene means

| Visual | Meaning | Source events |
| --- | --- | --- |
| Depth (x), left to right | Pipeline stages: Route → Queue → Prefill → [Layers] → Decode → Output | see stage rules below |
| Stage plane | One stage; outline pulse = stage event rate over the last 5 s (steady when idle or with reduced motion) | events mapped to the stage |
| Row (y) | One model on one node (`producer.node_id` × model name); bands group rows per node | model from `route.selected.model`, `request.completed.model`, `requested_model`, `session.created.model`, `model.load.*.model`, else `model_instance_id` |
| Sphere | A request (blue, Inference) or a Runtime turn (purple) in flight; green completed, red failed, amber cancelled | request lifecycle |
| Sphere size | Backend-reported tokens: `completion_tokens` (decode.completed or a backend-counted outcome), else `prompt_tokens`; smallest when not reported | |
| Sphere opacity | Age since the request finished (fades over 60 s, floor 0.3) | |
| Purple line | Runtime turn → the Inference request it caused (`parent_request_id`) | |
| Small cyan point | One sampled output event (`inference.token.generated`, usually `unit: "chunk"`); size = `bytes`; drifts from Decode to Output and fades over 8 s | |
| Box | Logical KV pool per producer instance; fill = blocks in use (`kv.allocated` − `kv.freed`) / `scheduler.configured.kv_num_blocks` (or `kv.pressure` `total_blocks`); amber/red for `kv.pressure.level` high/critical | `kv.*`, `scheduler.configured` |
| Thin planes L0…Ln | Only with `backend.layer.*`; brightness = `activation_rms` when reported | reserved events |
| Cube above a layer | Only with `backend.operator.*` (purple attention, cyan MLP, grey other) | reserved events |
| Amber bars beside Output | Only with `inference.sampling.candidates`: the latest token's alternatives, length = probability | reserved event |
| Outline cube | The selected entity | |

Stage rules (`stageOfEvent`, src/inference3d/derive.ts): Runtime
`request.started`/`route.*` → Route; `request.queued`, `scheduler.enqueued`,
`scheduler.preempted`, and `request.started` with `scheduled: true` → Queue;
`request.started` (unscheduled), `scheduler.admitted`, `scheduler.prefill.*`,
`kv.allocated`/`kv.reused`, `inference.prefill.started` → Prefill;
`inference.decode.started`, `inference.token.generated` → Decode;
`request.completed/failed/cancelled` → Output. `inference.prefill.completed`
and `inference.decode.completed` arrive at request end, so they count as
stage activity but never move a request back. Only `scheduler.preempted`
moves a request backwards (to Queue).

Every mapping is in the visible legend (UX.md "3D semantics").

Parent lines use the parent ID observed on a producer-scoped request's
lifecycle and pipeline evidence at the cursor. Known conflicting run IDs exclude a Runtime candidate; an absent run
ID is unknown. If a request reports different parent IDs or different known
run IDs, or several compatible Runtime instances share the parent ID, the
scene withholds the line instead of choosing an arbitrary instance. The
original evidence stays inspectable. The Inspector's Parent request group
can list multiple compatible evidence candidates; a drawn line requires one
unambiguous retained target. These are consumer derivations and change no
producer fields or protocol schema.
As with the existing pipeline derivation, only stage-moving events create a
request. Earlier nonmoving facts do not retroactively set lineage, and event
classes outside request lifecycle, stages, KV and scheduler do not contribute
parent/run facts to this view. Inference's supported parent metadata is on
the five request lifecycle types.

## Availability ("Capabilities")

Each producer stream gets a row with one chip per concept panel (Stage
pipeline, Layer internals, Operator activity, Token probabilities, Top
alternatives, KV cache pool, Output text): available, not available, waiting
for data, or not applicable (Runtime). The reason is derived from what the
producer declares (src/inference3d/capabilities.ts): the backend its
sessions/models name, that backend's capabilities from
`backend.registered` or the live health document, `request.started.sampler`,
the highest `sampling.level`, and the text-capture policy. Example for an
Ollama-backed Sonder Inference: "backend `ollama` does not expose layer
telemetry (needs a backend advertising `layer_telemetry` and
`--telemetry-level deep`; no Sonder Inference backend advertises it yet)".
When layers are absent the scene collapses to the stage pipeline and says so
in a notice above the canvas. The event shapes are in
[TELEMETRY_PROTOCOL.md](../TELEMETRY_PROTOCOL.md) "3D Inference: reserved and
proposed events".

The live client fetches the health document named by discovery
`links.health` (same origin as discovery, the producer's token, no
redirects, 64 KiB cap; `src/ingest/live/health.ts`) and keeps it on
`ProducerConnection.health`.

## Evidence

Every drawn entity (stages, layers, operators, requests, KV pools, output
events, the token distribution) is pickable: click it in the scene
(three.js raycaster; a drag orbits instead), or use the "Scene entities"
table, the stage rail, the live-output rows or the token button. Selecting
opens the entity's newest evidence event in the Inspector (without moving
the cursor), highlights all its evidence ids in the timeline and table, and
lists up to 12 evidence events to open. Escape clears the selection. A
selection persists while scrubbing and returns when the entity exists at the
cursor again, like the Agents topology (docs/integration/topology.md).

## Accessibility and motion

- The canvas is `role="img"` with a text summary; the "Scene entities" table
  lists every entity with kind, place, state, measures and evidence count,
  and is the keyboard path (buttons). Camera buttons rotate, tilt, zoom and
  reset; the mouse wheel scrolls the page (Ctrl/Cmd + wheel zooms).
- `prefers-reduced-motion: reduce` stops the animation loop (frames render
  only on change; pulses become static brightness) and says so.
- Without WebGL 2 (three.js r163+ needs it) the tab shows a 2D table of
  requests per lane and stage plus the entity table.
- Rendering stops when the tab is hidden or the page is in the background.

## Bounds

At most 160 recent output events, 40 recent token-candidate entries, every
active request plus the 120 most recent finished requests are drawn
(`omittedFinished` is reported in the summary); stage counts use every
request. The model is re-derived from the events at the cursor when the
cursor or the session changes (O(events)).

## Build and CSP

three.js (MIT, pinned `0.186.1`) is imported only by
`src/inference3d/scene.ts`, which `inference3dPanel.ts` imports; the app
loads that module with `import()`, so three is in its own chunk
(`inference3dPanel-*.js`) and never in the main bundle. The chunk contains no
`eval` or `new Function`; the Tauri CSP (`script-src 'self'`) needs no
change, and WebGL needs none.

## Tests

- `tests/inference3d/derive.test.ts`: stages, lanes, links, KV, capability
  reasons, replay cursor, health fallback, synthetic deep producer.
- `tests/inference3d/scene-layout.test.ts`: plane/lane/band layout and the
  size/opacity/pulse mappings.
- `e2e/inference3d.spec.ts`: canvas draws (renderer draw calls), legend,
  picking in the scene updates the Inspector, keyboard path, cursor
  following, reduced motion, WebGL fallback, axe (WCAG 2.2 AA) in both themes
  for both fixtures.

Fixtures (`src/inference3d/fixtures.ts`, used by tests only):
`ollamaPoolFixture()` (Runtime + Inference on `workstation` serving
qwen3:14b and deepseek-r1:14b, Inference on `node1` serving qwen3:14b;
hand-built, marked synthetic when displayed) and `deepSyntheticFixture()`
(a synthetic producer emitting the reserved events in the proposed shapes).

`window.__observatory3d` is a read-only test hook: `webgl`, `animating()`,
`reducedMotion()`, `entities()`, `screenPoint(id)`, `selected()`,
`frameStats()`.
