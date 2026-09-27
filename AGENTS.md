# Repository instructions

## Current phase

Implementation, Milestone 1 ("smallest useful Observatory"), as of 2026-09-26.
The owner requested implementation on 2026-09-26, which replaces the earlier
scaffold-only restriction. Scope is the web renderer, protocol validation,
synthetic fixture, WebSocket/file transport, recorder/replay, tests, and CI
described in docs/ROADMAP.md Milestone 1. Do not add model downloads, backend
or inference code, or producer instrumentation in this phase. On 2026-09-27
the owner requested the 3D Inference view (Milestone 3 "3D token/pipeline
view"): three.js is allowed in `src/inference3d/` only, lazy-loaded, and it
may draw only what telemetry reports (docs/integration/inference3d.md).

## Working rules

- Read README.md, docs/SCAFFOLD.md, and docs/DECISIONS.md before changing the structure.
- Treat directory ownership as provisional; it does not freeze an API or language.
- Preserve existing architecture and research documents; extend rather than rewrite.
- Record unresolved design choices explicitly rather than inventing contracts.
- Keep secrets, model weights, generated outputs, recordings, and local runtime state out of Git.
- Before committing run `npm run lint`, `npm test`, `npm run build`, and `git diff --check`.
- Do not report empty test directories as passing runtime tests.
- Label synthetic data as synthetic everywhere it is displayed.
- Parallel feature branches (`feat/*`) own only their directory (for example
  `src/topology/`, `src/diagnostics/`, `src-tauri/`). They do not edit root
  config (package.json, tsconfig, vite/eslint config, CI, main.ts); list needed
  dependencies, scripts, and panel wiring in the branch's
  `INTEGRATION_NOTES.md` for the integrator. Before merging, the integrator
  moves that file to `docs/integration/<area>.md` so branches do not conflict.
  Analysis views are tabs in `src/renderer/app.ts` (`VIEWS`); simple panels
  implement `ObservatoryPanel` (src/renderer/panels.ts) and are registered in
  src/renderer/main.ts.

## Observatory boundary

Read docs/ARCHITECTURE.md, docs/INTEGRATION.md, and docs/SECURITY_PRIVACY.md.
Preserve the existing protocol schema and design tokens. The TypeScript types in
src/protocol mirror protocol/observatory-events.schema.json and a drift test
keeps them aligned; change the schema first, never only the mirror. Producer
instrumentation belongs in Runtime/Inference; Observatory consumes telemetry and
owns no execution state. Existing technology preferences remain proposals to
validate.
