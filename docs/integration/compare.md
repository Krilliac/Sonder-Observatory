# Integration notes: feat/compare (session comparison view)

Owned paths: `src/compare/**`, `tests/compare/**`, `e2e/compare.spec.ts`,
`e2e/compare-harness.entry.ts`, `scripts/generate-fixture-regressed.mjs` (+ `.d.mts`),
this file. Nothing under `src/replay/session.ts`, SessionStore, `src/query/metrics.ts`,
`src/diagnostics/**` or `src/topology/**` was changed; compare uses only their public
APIs (`deriveMetrics`, `runDiagnostics`, `deriveTopology`, `orderEvents`, `loadRecording`)
and the readers in `src/query/attributes.ts`.

## What it does

- Two sides: **A = baseline**, **B = candidate**. Each side can be a loaded recording
  (`.sobs` / NDJSON / JSONL, via `loadRecording`) or the viewer's **current session**
  (fixture, opened file or live connection). "Swap A ↔ B", "Use current session", "Clear".
  A growing live session is re-analyzed at most once per second (`liveThrottleMs`).
- **Align by** run, request or turn. Units pair by id when both sides share ids; otherwise
  by position (for example different run ids between recordings). When no turn ids are
  reported, turns are inferred from request start order, and the view says so.
- **Deltas** (session totals and per aligned unit): TTFT p50/p95, decode tok/s, prompt and
  completion tokens, cost (`cost_usd`), cost budget used (`cost_budget_usd`), context budget
  peak (`guard.budget_pressure` `used_fraction`), retries (`retry.scheduled`), failed
  requests, error events, and cache hit rate (`kv.reused` = hit, `kv.allocated` = miss). A value
  no event reports shows as "—" / "only in A|B", never as 0.
- **Findings diff**: new in B, resolved (only in A) and persisting (with severity escalated or
  eased). Matching uses a signature of the kind plus subject facts, not event ids.
- **Call graph diff** over the topology model: added and removed nodes and edges, plus nodes
  and edges whose status, call count or failures changed.

New attribute conventions (readers in `src/compare/readers.ts`, candidates for
`src/query/attributes.ts`): `turn_id` / `turn` / `turn_index`, `cost_usd` / `total_cost_usd`,
`cost_budget_usd` / `budget_usd`, `decode_tokens_per_sec` / `backend_tokens_per_sec`,
`prompt_eval_count`.

## Hooks for the lead (files I did not touch)

**Status (2026-09-27): hook 1 is wired.** `app.ts` has the Compare tab
(`VIEWS`, `#view-compare`, `?view=compare`), renders the panel only while the
tab is visible with the same PanelContext as the extra panels, and labels the
current session `live: <urls>` or the file/fixture name. The "app" e2e test
now runs. Hooks 2-4 are still open.

1. **Compare tab** (`src/renderer/app.ts`): add `{ id: "compare", title: "Compare" }` to
   `VIEWS`, create `private readonly compare = new ComparePanel({ describeCurrent: () => <source label, e.g. "live: " + url or the file name> })`
   (`import { ComparePanel } from "../compare/panel"`), and in `renderViews()` call
   `this.compare.render(byId("view-compare"), ctx)` when the tab is visible, with the same
   PanelContext that `renderExtraPanels` builds.
   *Alternative with no app.ts change:* in `src/renderer/main.ts`
   `const panels: ObservatoryPanel[] = [new ComparePanel()];` (renders under `#extra-panels`).
2. **package.json scripts** (optional): `"fixture:regressed": "node scripts/generate-fixture-regressed.mjs"`.
   Tests and e2e generate the variant in memory, so no pre-hook is required.
3. **.gitignore**: add `/fixtures/synthetic-session-regressed.ndjson`.
4. Optional desktop hook: `comparePanel.loadRecordingText("a", text, name)` for a "Compare with…" menu item.

## Fixture variant

`node scripts/generate-fixture-regressed.mjs [out] [base]` writes
`fixtures/synthetic-session-regressed.ndjson` (624 events, deterministic) from the base
synthetic fixture. The changes: slower TTFT and decode for req_005 onward, prompts 25%
larger, two extra tool retries (a new retry-storm finding), a critical context budget
guard, kv lookups and `cost_usd`, and `synthetic.search` → `synthetic.search_v2` plus a new
`synthetic.rerank` tool. It is synthetic: `producer.synthetic: true`.

## Tests

- `tests/compare/compare.test.ts` (Vitest): variant determinism, deltas, alignment modes,
  findings diff, graph diff, formatting, controller (load, swap, live throttle, errors).
- `e2e/compare.spec.ts` (Playwright): the **harness** tests bundle `src/compare/panel.ts`
  with Vite's build API, inject it into the built app and mount it like an extra panel. They
  cover the full flow (load, swap, deltas, align run/turn/request, findings, graph, a live
  session growing, an unreadable file) and an axe WCAG A/AA scan. The **app** test drives the
  real Compare tab (wired, so it runs). `e2e/a11y.spec.ts` scans the tab in
  both themes.
