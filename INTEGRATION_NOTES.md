# Integration notes — feat/topology (Milestone 2 Sonder topology)

Owned paths: `src/topology/**`, `tests/topology/**`, this file. Nothing else
was changed.

## Dependencies

None. Layout is a small deterministic layered layout in
`src/topology/layout.ts`; no graph-layout library was needed. No 3D.

## Test config

Tests live in `tests/topology/*.test.ts`, so they are already picked up by the
current `vite.config.ts` `test.include: ["tests/**/*.test.ts"]` in the Node
environment. No DOM environment is required (the renderer's visual encoding is
tested through the pure `buildScene`). Run: `npx vitest run tests/topology`.

## Mounting the panel (lead wiring, `src/renderer/app.ts`)

```ts
import { TopologyPanel } from "../topology";

// in the constructor / layout
this.topology = new TopologyPanel({
    // open the evidence event in the existing inspector and move the cursor
    onSelectEvent: (event) => { this.selectedId = event.event_id; this.queueRender(); },
    relativeTime: (event) => fmtRelNs(event.mono_ns - this.store.firstMonoNs()), // or existing helper
});
sceneContainer.append(this.topology.element); // "Agents" tab / Live Session scene selector "agent topology"

// whenever the session store changes (fixture load, live append, recording open)
this.topology.setEvents(this.store.events());

// on every replay cursor move / animation frame (null = live, show all)
this.topology.setTime(this.follow ? null : this.cursor.currentMonoNs());
```

Adjust the store/cursor accessor names to the real ones. `setEvents` recomputes
the layout from the full session so nodes stay put while scrubbing; `setTime`
re-derives the graph at the cursor (O(events), fine for M1-sized sessions; add
memoisation/checkpoints if sessions grow large).

Selection: click or Tab + Enter/Space on a node/edge; Esc clears. The panel
lists the selection's evidence events; clicking one calls `onSelectEvent`.
Optional `onSelectionChange(selection, evidenceEventIds)` lets the app
highlight those events in the timeline/table. Selection persists while
scrubbing as long as the node/edge exists at the cursor (UX.md).

Navigation: UX.md lists an "Agents" section — suggested tab name "Agents"
or a Scene option "agent topology" in Live Session / Replay.

## Styling

The panel uses existing token CSS variables (`--color-primary`, `--color-purple`,
`--color-cyan`, `--color-success`, `--color-warning`, `--color-error`,
`--color-border`) and app vars `--muted`, `--text`, with hex fallbacks. It reuses
existing classes `panel-head`, `muted`, `kv`, `related`, `link`. Suggested
additions to `src/renderer/styles.css`:

```css
.topology-svg { display: block; max-height: 60vh; }
.topology-node, .topology-edge { cursor: pointer; outline: none; }
.topology-node:focus-visible path, .topology-edge:focus-visible path { stroke-width: 4; }
.topology-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; }
.topology-legend-item { display: inline-flex; align-items: center; gap: 4px; }
```

## Public API (`src/topology/index.ts`)

- `deriveTopology(events, { atMonoNs? }) -> TopologyGraph` (pure)
- `evidenceFor(graph, selection)`, `selectionValid(graph, selection)`, `allDiagnostics(graph)`
- `layoutTopology(graph)`, `buildScene(graph, layout, { selection, atMonoNs })`, `buildLegend(graph)`
- `TopologyPanel` (DOM)
- `topologyFixtureEvents()` from `src/topology/fixtures/topology-synthetic.ts`
  (synthetic; could be offered as a second demo fixture, e.g. `?fixture=topology`)

## Open questions for protocol owners

Per-event attribute payloads are not defined by the schema. The derivation
reads the conventions listed at the top of `src/topology/derive.ts` (e.g.
`attributes.parent`, `attributes.tool`, `attributes.tool_call_id`,
`attributes.store`, `attributes.to_agent_id`, `attributes.from_model`,
`attributes.tokens`). Record the agreed names in `docs/TELEMETRY_PROTOCOL.md`
when settled. Token/context budget and compaction visualisations (also in
Milestone 2) are not part of this branch.
