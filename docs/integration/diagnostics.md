# Integration notes: `feat/diagnostics`

Owner area: `src/diagnostics/` (+ tests in `tests/diagnostics/`). No changes to
package.json, root config, CI, protocol schema, or other areas.

## What it provides

Pure detector functions over protocol events (`ObservatoryEvent` from
`src/protocol/events.ts`) that emit **findings**:

```ts
interface Finding {
    id: string;                // deterministic `${kind}:${discriminator}`
    kind: FindingKind;         // see table below
    severity: "info" | "warning" | "critical";
    startNs: number;           // mono_ns of first evidence event
    endNs: number;             // mono_ns of last evidence event
    summary: string;           // factual, with units; no cause speculation
    evidenceEventIds: string[]; // never empty; all ids exist in the input
    facts: Record<string, number | string>;
    provenance: "derived" | "producer-reported";
}
```

Entry point (`src/diagnostics/index.ts`):

```ts
import { runDiagnostics, FindingsController, renderFindingsPanel } from "./diagnostics";
const findings = runDiagnostics(store.events, { config: { retryStorm: { count: 5 } } });
```

`runDiagnostics(events, { config?, kinds? })` sorts a copy into replay order
(`compareEvents` from `src/replay/order.ts`), runs the detectors, drops any
finding whose evidence is not in the input (defensive; cannot happen by
construction), and returns findings sorted by start time, then severity.
Thresholds: `DEFAULT_CONFIG` / `resolveConfig(overrides)` in `types.ts` (deep
partial overrides per detector).

## Detectors

| kind | inputs (event types / attributes) | rule (defaults) |
| --- | --- | --- |
| budget-pressure | `guard.budget_pressure` (`used_fraction`, `budget`); any non-guard event with `used_tokens`/`context_tokens` + `limit_tokens`/`context_limit`/`max_tokens`/`context_window` | guard restated; usage runs >= 80% per scope (context_id > request > agent > session), critical >= 95% |
| compaction | `context.compaction.started/completed/failed` (`tokens_before`, `tokens_after`, `context_id`) | info per compaction (duration, token reduction); warning on failure or start without completion; churn warning at 3 per 60 s |
| no-progress-loop | `tool.called` (`tool`, `args_hash`/`input_hash`/`content_hash` or unredacted `args`), `tool.completed` (`output_hash`/`result_hash`), `guard.no_progress` | >= 3 consecutive identical calls (or outputs) per actor; critical at 6. Redacted/absent args are never considered identical |
| duplicate-worker | `agent.spawned` (`task_hash`/`task`/`objective_hash`, else envelope `task_id`), `agent.completed/cancelled`, `guard.duplicate_work` | spawn while another agent with the same task identity is active; critical at 3 agents |
| retry-storm | `retry.scheduled` | >= 3 within 10 s; critical at 6 |
| cache-thrash | `kv.reused` (hit), `kv.allocated` (miss), `kv.evicted` | per 5 s window (>= 10 lookups) hit rate <= 0.5x the mean of previous <= 3 windows when that baseline >= 50%; eviction churn >= 20 per 5 s |
| model-churn | `model.load.completed`, `model.unload` | >= 4 transitions within 60 s; critical at 8 |
| latency-outlier | `request.started` -> `request.completed`/`request.failed` | duration > 2x p95 of previous 20 requests (min 5) and >= 250 ms over it; critical at 4x |
| error-burst | `*.failed`, `*.error` | >= 3 within 5 s; critical at 6 |
| resource-pressure | `device.memory.sample` (`used_bytes`/`total_bytes` or `used_fraction`, `kind`), `kv.pressure` (`occupancy`) | runs >= 85% per device/kind, critical >= 95%; kv.pressure restated |

Attribute names are **assumptions** (the envelope schema leaves `attributes`
open). They follow `docs/TELEMETRY_PROTOCOL.md` and the lead's synthetic
fixture; when Runtime/Inference settle attribute contracts, update the key
lists at the top of each detector. Missing attributes mean "no claim", not a
guess.

## Hooking into the lead's selection / inspector model

`FindingsController` (DOM-free) needs a host implementing:

```ts
interface DiagnosticsSelectionHost {
    highlightEvents(eventIds: readonly string[]): void; // [] clears
    selectEvent(eventId: string): void;                 // inspector + cursor
}
```

Suggested wiring in `src/renderer/app.ts` (lead-owned, not edited here):

```ts
private highlighted = new Set<string>();
private diag = new FindingsController({
    highlightEvents: (ids) => { this.highlighted = new Set(ids); this.render(); },
    selectEvent: (id) => this.select(this.store.events.find((e) => e.event_id === id)),
});
// after events change:
this.diag.setFindings(runDiagnostics(this.store.events));
// in the Diagnostics nav view:
panel.replaceChildren(...renderFindingsPanel(this.diag, {
    relativeTime: (ns) => formatRelative(ns - sessionStartNs),
    onChange: () => this.render(),
    synthetic: session.synthetic,
}));
// timeline ticks / table rows: add class "evidence" when this.highlighted.has(e.event_id)
```

Selecting a finding highlights all evidence ids and opens the first evidence
event in the inspector; the expanded row lists each evidence id as a button
that opens that event. Keyboard: rows are buttons; ArrowUp/ArrowDown move,
Escape clears. Severity is shown as text (INFO/WARN/CRIT) plus
`sev-info|sev-warning|sev-critical` classes; styling classes used:
`diag-findings`, `diag-finding`, `selected`, `sev-label`, `diag-kind`,
`diag-summary`, `diag-evidence` (plus existing `panel-head`, `provenance`,
`synthetic`, `muted`, `mono`, `link`). The lead may add CSS for these.

`panel.ts` uses a local minimal DOM helper instead of `src/renderer/dom.ts` so
the branch builds whether or not the renderer has landed.

## Fixtures and tests

- `src/diagnostics/fixtures.ts`: `DIAGNOSTIC_CASES`, 20 labelled SYNTHETIC
  cases (one positive + one negative per detector). Every event has
  `producer.synthetic = true` and `attributes.synthetic = true`.
- `tests/diagnostics/*.test.ts`: per-detector positive/negative/threshold
  tests, engine purity/order tests, controller selection tests, and a run
  over `fixtures/synthetic-session.ndjson` (skipped if the file is absent).
- Tests live in `tests/diagnostics/` because `vite.config.ts` only includes
  `tests/**/*.test.ts`. Run: `npx vitest run tests/diagnostics`.

## Open points for the lead

- `src/query/classify.ts#isErrorEvent` counts retries and guards as errors;
  diagnostics uses a narrower `isFailureEvent` (`*.failed`, `*.error`) so
  error bursts do not double-count retry storms / guards.
- `renderFindingsPanel` is not unit-tested (no DOM environment in vitest
  config); its behaviour is in `FindingsController`, which is tested.
- Findings over a live stream are recomputed from scratch; fine for M1-sized
  sessions. Incremental evaluation can be added later without API change.


## 2026-10-04 — finding and evidence pagination

The renderer now pages finding rows and selected evidence buttons at 50 each,
while preserving all findings/evidence, severity counts, highlight semantics,
exports and keyboard access across page boundaries. The host DOM cache uses
controller.revision so page changes render even with the same selected id.
The [pagination contract and qualification](diagnostics-pagination.md) records
the real browser baseline, candidate scale checks, controls and remaining scope.
