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


## Complete request-fact minimum (2026-10-06)

Compare reduces request start timestamps with a scalar `Math.min` loop. This
retains complete request facts and native signed-zero behavior without spreading
an unbounded request array into function arguments. Protocol validation, unknown
metrics, group attribution, cursor behavior and the existing 200-row display
bound are unchanged.

At baseline `15b26eaffe6de936a34705d86451acfafd9fb384`, a deterministic
synthetic recording with 131,072 distinct `request.started` events reproduced
`RangeError: Maximum call stack size exceeded` in `statsFor`. The candidate
completed five full analyses of that same recording, preserving every request,
request order, unknown metrics and complete output across cycles. Individual
analysis times were 1,292.58–1,487.66 ms in the local Node 24.19.0 experiment;
these are synthetic processing measurements, not provider/model quality or a
speed ratio against the failed baseline. Whole-process memory includes fixtures,
parsing and serialization; these cycles are not a leak proof.

The recording SHA256 is
`e868b3500f157c1c18c22f516572212fa881efc0aa3f82bc1c822e760f865cab`.
`tests/compare/summary-minimum.test.ts` covers complete retention, empty input,
validator-admitted native signed zero and source replacement.
`e2e/compare-minimum.spec.ts` drives the real file input and Compare tab, including
complete totals, bounded rendered rows, run/turn alignment and source replacement.
