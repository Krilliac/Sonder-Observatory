# Contributing

This repository is in Milestone 1 implementation. Read
[repository instructions](AGENTS.md), [scaffold status](docs/SCAFFOLD.md), and
[decisions](docs/DECISIONS.md) first.

Toolchain: Node.js 20.19+ and npm (see the README quickstart). Before
committing run:

```bash
npm run lint
npm test
npm run build
git diff --check
```

CI (`.github/workflows/ci.yml`) runs lint, test, and build on Node 20 and 22.
Feature branches (`feat/*`) stay inside their own directory and list any
needed dependency, script, or panel wiring in `INTEGRATION_NOTES.md` for the
integrator.

Keep commits focused and use DCO sign-off (`git commit -s`). Project licensing
must be settled before importing third-party source or publishing packages;
current npm packages are development dependencies only.
