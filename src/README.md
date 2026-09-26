# Source workspace

Milestone 1 web app plus Milestone 2 views: TypeScript + Vite, no UI
framework (see [decisions](../docs/DECISIONS.md)). The Tauri desktop shell
lives in `../src-tauri/`; Three.js/WebGPU spatial views remain proposals for
later milestones.

- `protocol/`: TypeScript mirror of `protocol/observatory-events.schema.json` and the runtime validator.
- `transport/`: Live WebSocket connection, endpoint checks, and frame parsing (no negotiation/resume yet).
- `recording/`: NDJSON parsing and the `.sobs` recording container/manifest.
- `replay/`: Replay ordering, dedupe, sequence-gap detection, cursor, and the session store.
- `query/`: Event classification and metric derivation.
- `inspector/`: Evidence view and correlation lookup for a selected event.
- `renderer/`: App shell, metric cards, timeline, event table, styles, and the `ObservatoryPanel` extension point (`panels.ts`).
- `design/`: Resolves `design/tokens.json` into CSS variables.
- `topology/`: Milestone 2 agent topology derivation, layout and the "Agents" tab panel.
- `diagnostics/`: Evidence-cited detectors and the "Diagnostics" findings list.
- `integrations/`: Embedding/launch boundaries; `desktop.ts` is the Tauri bridge (not wired into the UI yet).

See [architecture](../docs/ARCHITECTURE.md) and [scaffold status](../docs/SCAFFOLD.md).
