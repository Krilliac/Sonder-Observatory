# Source workspace

Directory placeholders only; no executable application or source modules exist.
The architecture proposes TypeScript and a Tauri shell, with Three.js/WebGPU
and WebGL for later spatial views. No dependencies or build tools are installed
or selected by this scaffold.

- `transport/`: Telemetry connection, negotiation, reconnect, and loss reporting.
- `recording/`: Bounded session recording with redaction and retention metadata.
- `replay/`: Recorded-session playback, seeking, and state reconstruction.
- `query/`: Event indexing, filtering, and correlation.
- `renderer/`: Live/replay views, timeline, and future evidence-grounded spatial views.
- `inspector/`: Resolve displayed values to source events and measurement provenance.
- `integrations/`: Consumer-side embedding and standalone launch boundaries.

See [architecture](../docs/ARCHITECTURE.md) and [scaffold status](../docs/SCAFFOLD.md).
