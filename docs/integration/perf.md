# Performance at scale (feat/perf)

This branch makes the timeline, the event table and recording loading work with
100k–1M events. It adds a seeded fixture generator and Vitest perf budgets.

## What changed

| Area | Before | After |
| --- | --- | --- |
| Fixtures | Only the 575-event synthetic session | `scripts/gen-large-fixture.mjs` generates seeded 10k / 100k / 1M recordings. The output is byte-identical for the same `(count, seed)`, so the fixtures don't need to be committed. |
| Timeline | Rebuilt as SVG on every render. That walked **every** event (classify, string key, `Set`) and created up to tracks × width `<rect>`s. | Sessions over 2,000 events (`SVG_MAX_EVENTS`) render to one `<canvas>` (`timelineView.ts`). It keeps a class/time index per events array and does level-of-detail bucketing per (track, pixel column) (`timelineModel.ts`), cached by `TimelineLod`. Scrubbing and replay only move the cursor, so they redraw from cached buckets in O(tracks × width). Future events are dimmed by one overlay. Click hit-testing uses binary search. Small sessions, such as the 575-event fixture, keep the SVG markup built from the same model, so the e2e suite's DOM contract still holds (`rect.tick`, `line.cursor-line`, `.future`, `.evidence`, `.selected`). |
| Event table | Filtered all visible events on every render and showed only the **latest 400** rows. | Virtualized (`eventTable.ts`, `virtualWindow.ts`). Every filtered event at the cursor is reachable, and only about 30 rows are in the DOM. Filter results are cached as positions (a `Uint32Array`) and narrowed as you type. Rows at the cursor are found by binary search. Above 8M px the scroll range is compressed so 1M rows stay reachable within browser height limits. The spacers sit in `thead` and `tfoot`, so `tbody tr` is exactly the rendered event rows. |
| Loading | `file.text()` followed by a synchronous `loadRecording`, which blocks for the whole parse. A 1M-event file (about 585 MiB) is over V8's maximum string length (0x1fffffe8 chars), so it **cannot load at all**. | Files of 2 MiB or more stream through `loadRecordingStream(file.stream())`. Large text such as the fixture button uses `loadRecordingChunked`. Both parse in adaptive ~8 ms slices, yield to the event loop between slices (`scheduler.yield` / `MessageChannel`), report progress in the source badge and can be cancelled by a newer load. Results are identical to `loadRecording`, including rejected-line numbers and manifest rules (tested). |

### Files

New files (all owned by this branch):

- `scripts/gen-large-fixture.mjs`, `scripts/gen-large-fixture.d.mts` (types for the tests)
- `src/renderer/timelineModel.ts`, `timelineCanvas.ts`, `timelineView.ts`
- `src/renderer/virtualWindow.ts`, `eventTable.ts`, `eventTable.css`
- `src/renderer/chunkedLoad.ts`
- `tests/perf/*.test.ts`, `tests/perf/helpers.ts`

Modified: `src/renderer/app.ts`, limited to the timeline and table code and the load path:

- `renderTimeline` delegates to `TimelineView`. It still updates the scrubber and cursor label.
- `renderTable`, `tableRows` and `onTableKey` delegate to `EventTable`. `TABLE_LIMIT` is removed.
- `loadText` and the file input use the chunked or streaming loader for large inputs through a new `loadChunked`, and `applyLoaded` holds the old `loadText` body. `connect()` bumps a load token so a slow load can't overwrite a live session.
- The unused `svg`, `classifyEvent` and `summarizeAttributes` imports are removed.

The selected-row contrast comes from the upstream fix in `views.css` (#16), and `eventTable.css` does not override it. The virtualized rows keep `tr.row`, `tr.selected`, `td.muted` and `aria-selected`, and `tbody tr` contains only event rows, so the e2e selectors still match.

The e2e suite (`npx playwright test`) passes locally with current main merged in (through #18, which includes the #16 a11y fixes and the #17 live ingest wiring): 22 passed.

Not touched: diagnostics, topology, `src/integrations`, `src/recording`, `src/transport`, `src/protocol`, `src/replay`, `src/query`, `package.json` and root config.

## Usage

```sh
node scripts/gen-large-fixture.mjs                          # 10k, 100k, 1m -> artifacts/fixtures/
node scripts/gen-large-fixture.mjs --sizes 100k --seed 7
node scripts/gen-large-fixture.mjs --sizes 1m --out /tmp/sobs
```

Output goes to `artifacts/fixtures/`, which the existing `/artifacts/` rule in `.gitignore` already covers. Open a file with **Open recording…**.
Approximate sizes: 10k ≈ 5.8 MiB, 100k ≈ 58 MiB, 1M ≈ 585 MiB.

The perf tests generate their 10k and 100k fixtures in memory, so they don't need files.
`SOBS_PERF_BUDGET_SCALE=2 npm test` doubles every budget on a slow machine.

## Perf budgets (tests/perf/perf-budget.test.ts, 100k events)

The thresholds are CI-safe: each is 10–100× the box measurement.

| Budget | Threshold | Box measurement |
| --- | --- | --- |
| `loadRecording` of 100k events (sync) | < 15 s | ~0.35–1.3 s |
| Chunked parse of 100k: total / longest slice | < 20 s / < 250 ms | ~0.35–0.7 s / ~10–18 ms |
| Class/time index build | < 1 s | ~40 ms |
| Cold bucketing, 1600 px | < 250 ms | ~7 ms |
| Cached scrub frame (draw, median / p95) | < 5 ms / < 20 ms | ~0.4 ms |
| Zoomed re-bucketing / 1000 click hit-tests | < 50 ms / < 250 ms | < 1 ms / < 1 ms |
| Table render window per scroll frame | < 2 ms | ~0.003 ms |
| Text filter over 100k rows / 10k filtered scrubs | < 500 ms / < 50 ms | ~31 ms / < 1 ms |

## Measured before/after (box measurements)

These numbers were measured on the shared agent box, **not** on Nate's computer: 8 vCPU Intel Xeon, Linux, Node 20.19.2, headless Google Chrome 151 through playwright-core at a 1600×1000 viewport.
- "Before" is main at f5e3ff5.
- "After" is this branch, measured with the canvas path. The 10k+ sessions use canvas in the final code too, because the SVG path only applies at 2,000 events or fewer.
- The fixtures come from `gen-large-fixture.mjs` with seed 20260926.
- Browser figures are the median of 2 runs. The box is shared, so expect roughly ±30% run-to-run noise.

### In the browser (whole app, built with `vite build`)

| Metric | 10k before | 10k after | 100k before | 100k after |
| --- | --- | --- | --- | --- |
| Open file → rendered (ms) | ~190 | ~115 | ~710 | ~620 |
| Longest main-thread task during load (ms) | ~135 | 0 (none over 50 ms) | ~560 | ~210 |
| Scrub frame: input handler plus forced layout, median / p95 (ms) | ~40 / 58 | ~7 / 12 | ~86 / 127 | ~13 / 19 |
| Timeline DOM nodes | 2,900 | 1 | 7,428 | 1 |
| Table rows in DOM / rows reachable | 400 / 400 | 29 / all 9,989 | 400 / 400 | 29 / all 99,900 |

At larger sizes, after this branch only:

- **300k events:** loads in about 1.8 s, and scrubbing has a median of about 27 ms.
  - Before, the recording never loaded. `SessionStore.append` fails with `RangeError: Maximum call stack size exceeded` (see wiring note 1).
- **1M events:** loads in about 9.8 s. Parsing streams at about 5 s with no long task. The single long task of about 6.2 s is after parsing: store ordering, diagnostics and metrics, all outside this branch. Scrubbing has a median of about 125 ms, almost all of it in `deriveMetrics` and similar per-render O(n) work outside the timeline and table.
  - Before, the file could not be read into a string at all.

### Algorithmic cores in Node (per frame, no DOM)

| Per-frame cost (ms) | 10k before → after | 100k before → after | 1M before → after |
| --- | --- | --- | --- |
| Timeline bucketing per render | 6.9 → 0.43 | 36.5 → 0.42 | 479 → 0.12 |
| Table rows, no filter | 0.12 → 0.03 | 1.4 → 0.03 | 16.2 → 0.015 |
| Table rows, text filter "tool" | 1.2 → 0.014 | 10.0 → 0.009 | 117 → 0.006 |
| Timeline click hit-test | 3.0 → 0.15 | 23.7 → 0.04 | 279 → 0.2 |

One-time costs after this branch, per events array:

| One-time cost | 100k | 1M |
| --- | --- | --- |
| Index build | ~42 ms | ~305 ms |
| Cold bucketing | ~7 ms | ~4 ms |
| Cold text filter | ~31 ms | ~222 ms |

Loading in Node (event-loop delay measured with `monitorEventLoopDelay`):

| Load path | 100k | 1M |
| --- | --- | --- |
| Sync `loadRecording` | blocks ~350 ms | impossible: string too long |
| Chunked (from text) | max loop delay ~18 ms | impossible: string too long |
| Streamed (from file) | ~0.5 s total, max delay ~14 ms | ~4.9 s total, max delay ~20 ms, p99 ~7.5 ms |

## Wiring needs for the integrator (outside this branch's files)

1. **`src/replay/session.ts`: remove the spread pushes.** `this.raw.push(...events)` and `this.rejected.push(...lines)` overflow the call stack somewhere above about 120k items in Chromium.
   - `app.ts#applyLoaded` works around this by appending in batches of 50k (`APPEND_BATCH`). Each batch re-runs `orderEvents` over the whole store, which costs about 8× a single sort at 1M.
   - Fix: replace both with a `for` loop. Then the batching in `applyLoaded` can be deleted, or `APPEND_BATCH` set to `Infinity`.
2. **`SessionStore.append` re-sorts everything on every call.** Live ingest is O(n log n) per batch. An incremental merge (append when `mono_ns` is non-decreasing, otherwise insertion or merge) would fix both live ingest and item 1.
3. **Per-render O(n) work outside the timeline and table.** This is what remains in the scrub frame (about 13 ms at 100k, 125 ms at 1M):
   - `deriveMetrics(visible)` in `render()` (`src/query/metrics.ts`) costs about 45 ms in Node at 100k. Fix: cache it per (events, visibleCount), or make it incremental or prefix-based.
   - `cursor.visibleEvents()` makes a slice copy on every render.
   - `SessionStore.capturePolicy` scans all events on every `renderHeader`.
   - `renderInspectorPanel` and the diagnostics `selectEvent` use `store.events.find(...)`. `eventPosition(getEventIndex(events), id)` from `timelineModel.ts` is a cached O(1) replacement.
4. **Load-time work after parsing** (about 6 s at 1M): `orderEvents` (about 2.3 s at 1M), `runDiagnostics` over the whole session (about 150 ms at 100k), and topology `setEvents`. These could move behind a yield or into idle callbacks.
5. **DOM growth in other panels.** The total DOM node count still grows with session size: about 8.4k nodes at 100k and 81k at 1M. That comes from the diagnostics or topology views, not the timeline or table.
6. **Worker parsing (optional).** Parsing currently runs as main-thread time slices. A Worker (`new Worker(new URL("./parseWorker.ts", import.meta.url), { type: "module" })`) could take the whole parse off the main thread. However, structured-cloning 1M events back to the main thread is itself expensive (seconds). It only pays off if the store and index also live in the worker, so this was left out.
7. **`fixtures/README.md` and root `README.md`** (owned by the lead): could mention `node scripts/gen-large-fixture.mjs`. An optional npm script could be `"fixture:large": "node scripts/gen-large-fixture.mjs"`, but `package.json` is not touched here.
8. **`renderHeader` overwrites the loading progress** in `#source-badge` if something else triggers a render mid-load (for example a resize). This is cosmetic.

## Scrub and live indexes (ported from `feat/perf-2`, 2026-09-28)

The unmerged `feat/perf-2` branch was re-evaluated against current main (after
#33, #34, #37). Its incremental `SessionStore` and gap tracking were superseded
by #34. The indexes below were still missing and were ported, adapted to the
current metrics, topology and inspector semantics. Each one returns exactly
what the full computation returns; tests compare them directly.

- `src/replay/lookup.ts`: `SessionStore` and `orderEvents` mark their arrays
  as deduplicated, ordered and immutable (`isOrdered`), and the store reports
  in-order appends (`onPrefixExtended`) so indexes extend instead of
  rebuilding. Only marked arrays are cached.
- `src/query/metricsIndex.ts`: `metricsAt(events, count)` (and
  `ReplayCursor.metrics()`, used by `render()`) equals
  `deriveMetrics(events.slice(0, count))`. Spans, token/chunk events, decode
  reports and errors are position lists; the small counters are checkpointed
  every 2048 events. `deriveMetrics` and the index share `assembleMetrics`.
- `TopologyTimeline` (`src/topology/derive.ts`): `graphAt(t)` equals
  `deriveTopology(events, { atMonoNs: t })`. It keeps only topology events and
  snapshots the builder every 512 of them (or more when the state is large,
  keeping snapshot memory linear); snapshots store array lengths, not copies.
  `TopologyPanel` uses it; `deriveTopology` skips `orderEvents` for marked arrays.
- `relatedGroups` (`src/inspector/related.ts`): a correlation index supplies
  only the candidate events per group; the group checks are unchanged.
- `getEventIndex` / `eventPosition` (`src/renderer/timelineModel.ts`): an
  in-order append copies the previous index and classifies only the tail; the
  id map is shared along the session.
- `runDiagnostics` does not copy and re-sort a marked array, and checks
  evidence ids against a set of the evidence ids only.
- `SessionStore.synthetic` / `capturePolicy` are cached per events array.

Node, deterministic fixture (`npm run fixture:large`, seed 20260926), mean of
two runs, main at 9c6a7b3 vs this port:

| Path | 100k main | 100k port | 300k main | 300k port |
| --- | --- | --- | --- | --- |
| Metrics per scrub frame | 16 ms | 1.0 ms | 48 ms | 2.7 ms |
| Topology per scrub frame | 37 ms | 0.2 ms | 143 ms | 0.4 ms |
| Live batch (500 events): metrics + topology | 65 ms | 2.8 ms | 197 ms | 7.0 ms |
| Live batch: timeline index + selection lookup | 22 ms | 0.3 ms | 54 ms | 0.5 ms |
| Inspector related groups, later selections | 47 ms | 7.4 ms | 168 ms | 21 ms |
| `synthetic` + `capturePolicy` per render | 2.8 ms | 0.0 ms | 7.9 ms | 0.0 ms |
| `runDiagnostics` on the store array | 86 ms | 79 ms | 250 ms | 219 ms |

The diagnostics gain is small (about 12% at 300k, within run-to-run noise at 100k); it also avoids a full copy and a set of every event id.

One-time costs of the port at 300k: metrics index ~100 ms, topology timeline
~33 ms, correlation index ~140 ms (first selection; main pays ~170 ms on every
selection).

Not ported: time-sliced session preparation (`sessionPrep.ts`,
`replay/slices.ts`, chunked store append) needs load-path wiring in `app.ts`
and a browser to measure; the paged findings list and capped topology side
lists change DOM only (not measurable in the Node suite); the
`producerInstance` fast path saves ~8 ms per 300k-event pass; caching
`visibleEvents()` saves under 1 ms per render.
