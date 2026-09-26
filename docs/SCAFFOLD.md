# Scaffold status

Created 2026-09-26. **Documentation and directory structure only.**

## Included

- [Source ownership placeholders](../src/README.md).
- [Future test location](../tests/README.md).
- [Existing protocol workspace](../protocol/README.md).
- [Ecosystem boundaries](BOUNDARIES.md).
- Git/editor conventions and contribution instructions.

Existing architecture, research, UX notes, design tokens, and event schema are
preserved. Technology preferences in the architecture are not changed by this
scaffold. There is no application, renderer, recorder, transport, test suite,
dependency manifest, build system, or CI workflow implemented yet.

## Next design work

1. Resolve protocol ownership and compatibility policy with Runtime and Inference.
2. Define an initial fixture and acceptance criteria for timeline/inspector/replay.
3. Validate the proposed TypeScript/Tauri toolchain and project/dependency licenses.
4. Request a bounded implementation slice from the existing roadmap.

Producer instrumentation stays with Runtime/Inference. Observatory must remain
optional, isolated, and grounded in telemetry evidence. Raw payload capture and
recording storage must follow the existing security/privacy design.
