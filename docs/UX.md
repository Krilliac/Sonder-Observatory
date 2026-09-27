# UX and Product Design

## Product character

Observatory should feel like a serious developer/scientific tool: dark, restrained, information-dense, and calm. Avoid decorative "AI" effects that are not carrying information.

The generated concept screens establish the initial direction:

1. standalone live inference dashboard
2. Sonder Flutter embedded/control view
3. session replay + agent topology
4. design-system board
5. conceptual 3D transformer/inference visualization

See `docs/assets/concepts/README.md`.

## Navigation

```text
Overview
Live Session
Replay
Agents
Models
Memory
Diagnostics
Settings
```

When embedded in Sonder Flutter, Observatory appears under **Developer > Observatory** with:

- install/status
- telemetry status
- runtime endpoint
- Open Embedded
- Launch Standalone
- Open Latest Recording
- recording/sampling controls

## Implemented versus planned (web renderer, 2026-09-26)

Implemented (src/renderer/, see src/renderer/README.md):

- Shell: header with the app mark, status badges and actions; a collapsible
  sidebar with **Producers** and **Sources**; views as tabs: **Overview**
  (metric cards and timeline), **Events** (table), **Diagnostics**,
  **Agents**; one replay bar for all views; the inspector docked beside every
  view with a keyboard-resizable splitter.
- Connection flow: producer URL, transport, in-memory bearer token, **Test**
  (discovery details, or which setting or token to fix), **Connect**, local
  presets and eight recent endpoints. Several producers merge into one
  session; each has a card with state, counters, last error and actions.
- Empty state with local producer discovery, open/drop recording and the
  synthetic demo.
- Timeline legend, a text alternative and keyboard stepping; Previous and
  Next error; a shortcuts dialog.
- Light and dark themes from design/tokens.json (AA contrast for every text
  role, checked by tests and axe), reduced-motion support, visible load
  progress with cancel, a polite warnings region.

Planned (not built): Live Session scene views, Replay comparison of two runs,
Models, Memory and Settings views, the Flutter embedded view, 3D views,
multi-select class chips and event-type facets.

UX decisions:

- Status is text, never colour or hover alone: producer state words and
  counters are visible on the cards; tone colours only repeat them.
- The inspector stays docked beside every view so evidence clicked in
  Diagnostics or Agents is visible without switching tabs.
- Views that are hidden are not rendered; switching tabs renders them at
  their real size.
- Shortcuts use single keys and are ignored while typing, with modifiers held,
  and for Space on controls Space already activates. Because they are active
  page-wide, WCAG 2.1.4 (Character Key Shortcuts, level A) requires a way to
  turn them off: the shortcuts dialog has a **Single-key shortcuts** switch,
  kept per viewer in localStorage (try/catch). When off, no single-key
  shortcut runs, including `?`; the header **Shortcuts** button opens the
  dialog to turn them back on. Remapping is not offered.
- Live panels are patched in place, never rebuilt per update: producer cards
  keep their elements (only text and state attributes change; action buttons
  are replaced only when the set of actions changes) and table rows are
  reused by event position. A rebuilt element under the pointer loses the
  click, which at live update rates makes buttons and rows unclickable at
  human speed.
- Every URL the page shows (cards, the Sources URL field, probe messages) is
  shown without credentials or token parameters.
- Per-viewer conveniences (theme, sidebar, splitter, recent endpoints) live in
  localStorage behind try/catch; tokens never do.
- At 900 px and below the layout stacks and the sidebar starts collapsed;
  nothing scrolls the page sideways at 420 px (wide tables scroll inside
  their own box).

## Overview

Primary dashboard:

- tokens/sec
- prefill throughput
- p50/p95 time-to-first-token
- p50/p95 inter-token latency
- context usage
- KV allocated/reused/evicted
- VRAM/RAM
- active model/backend
- active agents
- recorder state

The central visual should answer **what is active now?**, not merely decorate the metrics.

## Live Session

Three synchronized regions:

### Scene

Selectable views:

- inference pipeline
- cache/memory
- agent topology
- device topology
- event-flow graph

### Inspector

Selection persists until dismissed. Inspectors display evidence and units, not prose guesses.

Example token/node inspector:

- token ID/text (if capture enabled)
- position
- selected probability/logprob
- candidate distribution
- request/run/agent
- backend/device
- timings
- related events

### Timeline

One timeline drives all views.

Tracks can include:

- tokens
- requests
- agents
- tools
- model lifecycle
- cache
- compaction
- retries/errors
- device transfers
- resource pressure

## Replay

Replay is a first-class mode, not a video player.

Capabilities:

- time scrub
- play/pause/speed
- filter by event type
- jump to error/retry/compaction
- compare two runs
- inspect state snapshot
- open selected interval in diagnostics
- preserve selected entity while scrubbing where identity remains valid

## 3D semantics

3D should be used when spatial structure makes a relationship easier to understand:

- layer/operator pipeline
- multi-node device topology
- agent graph
- cache pools/tiers
- context lineage

Do **not** label arbitrary latent clusters as "reasoning", "knowledge", or "safety" unless a specific measured/derived signal actually maps to those categories.

Recommended mappings:

- node size -> bytes/tokens/work
- edge width -> context bytes/tokens transferred
- pulse rate -> event frequency
- opacity -> activity/age
- stable semantic color -> event class/state
- depth -> explicit pipeline or topology dimension

Every mapping needs a visible legend.

## Visual system

Base direction from the concept board:

- deep navy/near-black background
- cool blue primary interaction accent
- cyan for activation/throughput/transfer
- purple for attention/relationship class
- green for success/healthy
- amber for warning/backpressure/probability emphasis
- red for error
- thin borders; limited glow; glow carries active-state meaning

Accessibility:

- state must not be communicated by color alone
- keyboard navigation for all inspectors/timelines
- reduced-motion mode
- pause for continuous motion
- legible 100–200% scaling
- no hover-only critical controls
- color-contrast audit before release

## Useful diagnostic visualizations

- context growth vs compaction
- KV hit/miss/eviction timeline
- scheduler queue and running batch
- per-agent token/latency allocation
- duplicate work detector
- retry/no-progress loop visualization
- model residency and load/unload churn
- CPU/GPU/NPU placement
- network transfer between Sonder nodes
- speculative decoding accepted/rejected token runs
- MoE expert routing when exposed
