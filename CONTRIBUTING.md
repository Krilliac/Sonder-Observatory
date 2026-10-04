# Contributing

This repository is in Milestone 1 implementation. Read
[repository instructions](AGENTS.md), [scaffold status](docs/SCAFFOLD.md), and
[decisions](docs/DECISIONS.md) first.

Toolchain: Node.js 22.13+ or 24 LTS and npm (see the README quickstart). Before
committing run:

```bash
npm run lint
npm test
npm run build
git diff --check
```

CI (`.github/workflows/ci.yml`) runs lint, test, and build on Node 22 and 24,
plus a real Node 20 compatibility lane required by existing branch protection.
Node 20 is outside the upstream Vitest support range; prefer Node 22 or 24
for development. Unit tests default to two workers without relaxed budgets.
Feature branches (`feat/*`) stay inside their own directory and list any
needed dependency, script, or panel wiring in `INTEGRATION_NOTES.md` for the
integrator.

Keep commits focused and use DCO sign-off (`git commit -s`). Project licensing
must be settled before importing third-party source or publishing packages;
current npm packages are development dependencies only.
