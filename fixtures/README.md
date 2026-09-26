# Fixtures

`synthetic-session.ndjson` is **synthetic** telemetry: a deterministic JSONL
(NDJSON) event log produced by `scripts/generate-fixture.mjs` (seeded PRNG), not
measurements from Sonder Runtime, Sonder-Inference, or any model. Every event
carries `producer.synthetic: true` and the UI shows a synthetic-data banner.

The file is generated, not committed: `npm run dev`, `npm run build`, and
`npm test` regenerate it first (npm `pre*` scripts), and `npm run fixture` does
so on demand. The fake producer generates it if missing.

It covers the Milestone 1 success-gate signals: request latency (10 requests),
token rate (per-token events), errors (a failed request, a failed tool call
with retry, budget/KV pressure guards), agent/tool transitions (owner, worker,
critic agents; three tool calls), resource pressure (VRAM samples rising above
90%), and a producer-reported `telemetry.dropped` event.
