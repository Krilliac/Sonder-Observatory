# Source workspace

Milestone 1 web app: TypeScript + Vite, no UI framework and no runtime
dependencies (see [decisions](../docs/DECISIONS.md)). A Tauri shell and
Three.js/WebGPU spatial views remain proposals for later milestones.

- `protocol/`: TypeScript mirror of `protocol/observatory-events.schema.json` and the runtime validator.
- `transport/`: Live WebSocket connection, endpoint checks, and frame parsing (no negotiation/resume yet).
- `recording/`: NDJSON parsing and the `.sobs` recording container/manifest.
- `replay/`: Replay ordering, dedupe, sequence-gap detection, cursor, and the session store.
- `query/`: Event classification and metric derivation.
- `inspector/`: Evidence view and correlation lookup for a selected event.
- `renderer/`: App shell, metric cards, timeline, event table, styles, and the `ObservatoryPanel` extension point (`panels.ts`).
- `design/`: Resolves `design/tokens.json` into CSS variables.
- `integrations/`: Consumer-side embedding and standalone launch boundaries (placeholder).

See [architecture](../docs/ARCHITECTURE.md) and [scaffold status](../docs/SCAFFOLD.md).
