# Scaffold status

Created 2026-09-26 as documentation and directory structure only. On
2026-09-26 the owner requested implementation; the repository is now in
**Milestone 1 implementation** (see [AGENTS.md](../AGENTS.md)).

## Included

- [Source workspace](../src/README.md) with Milestone 1 modules.
- [Tests](../tests/README.md) (Vitest unit tests).
- [Existing protocol workspace](../protocol/README.md) — schema unchanged.
- [Ecosystem boundaries](BOUNDARIES.md).
- [Decisions](DECISIONS.md) and [recording format](RECORDING_FORMAT.md).
- Git/editor conventions, contribution instructions, and CI
  (`.github/workflows/ci.yml`).

Existing architecture, research, UX notes, design tokens, and event schema are
preserved.

## Implemented (Milestone 1)

- [x] dependency manifest and build system (npm, TypeScript, Vite)
- [x] protocol TypeScript types + runtime validator (mirror of the schema)
- [x] synthetic telemetry fixture and generator
- [x] live WebSocket transport + recording file loading
- [x] recorder (`.sobs`) and replay with scrubber
- [x] web renderer: metric cards, timeline, event table, inspector
- [x] unit test suite and CI workflow
- [ ] Tauri standalone shell (next step, see [roadmap](ROADMAP.md))
- [ ] Flutter embedding (`src/integrations/` remains a placeholder)

## Next design work

1. Resolve protocol ownership and compatibility policy with Runtime and Inference.
2. Confirm producer attribute names used by metric derivation ([decisions](DECISIONS.md)).
3. Validate the Tauri shell and project/dependency licenses.
4. Record a real producer session and re-check the Milestone 1 success gate.

Producer instrumentation stays with Runtime/Inference. Observatory must remain
optional, isolated, and grounded in telemetry evidence. Raw payload capture and
recording storage must follow the existing security/privacy design.
