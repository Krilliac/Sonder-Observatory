# Renderer

Responsibility: Live/replay views, timeline, and future evidence-grounded spatial views.

Web renderer (DOM + SVG/canvas, no 3D). `app.ts` builds the shell and wires
the modules below; everything shown is derived from received events.

| Module | What it does |
| --- | --- |
| `app.ts` | Shell: header, sidebar, view tabs (Overview, Events, Diagnostics, Agents), replay bar, docked inspector; owns the SessionStore and the LiveConnectionManager |
| `main.ts` | Injects the design-token stylesheet, sets the theme, starts the app and the desktop integration |
| `connectionPanel.ts` | Sources panel (#connection-panel): URL, transport, in-memory token, Test, presets, recent endpoints |
| `producersPanel.ts` | Producer cards (#producers) with the contract 8.6 hooks; built once per connection and patched in place, so buttons survive live counter updates |
| `onboarding.ts` | Empty state (#onboarding): probe local presets, open recording, synthetic demo |
| `dropZone.ts` | Window drop target for recordings |
| `shortcuts.ts` | Key map, the #shortcuts-dialog and its persisted on/off switch (#shortcuts-enabled) |
| `theme.ts` | Light/dark selection (URL, saved choice, system) |
| `params.ts` | URL parameters (`connect`, `ws`, `fixture`, `view`, `theme`; token params refused) and `redactUrlSecrets` for every URL the page shows |
| `navigation.ts` | Error navigation, producers in a session, synthetic banner and timeline summary text |
| `splitter.ts` | Keyboard/pointer splitter between the views and the inspector |
| `brand.ts` | Header mark from `src-tauri/icons/app-icon.svg` |
| `timelineView.ts`, `timelineCanvas.ts`, `timelineModel.ts` | Timeline (SVG for small sessions, canvas with level-of-detail buckets for large ones) |
| `eventTable.ts`, `virtualWindow.ts` | Virtualized event table and its filter; row elements are reused across repaints, so clicks land during live ingest |
| `chunkedLoad.ts` | Large recordings parsed in slices, with progress and cancel |

Synthetic sessions show a persistent banner naming the synthetic producers,
a badge, and SYNTHETIC tags on producer cards. Pure helpers are unit-tested in
`tests/renderer/`; the DOM is covered by the Playwright suite in `e2e/`.

See [source workspace](../README.md).
