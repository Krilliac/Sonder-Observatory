/**
 * Diagnostics entry point: run all detectors over an event stream.
 * See INTEGRATION_NOTES.md (branch root) for wiring into the renderer.
 */
import type { ObservatoryEvent } from "../protocol/events";
import { isOrdered } from "../replay/lookup";
import { detectBudgetPressure } from "./detectors/budget";
import { detectCacheThrash } from "./detectors/cacheThrash";
import { detectCompaction } from "./detectors/compaction";
import { detectDuplicateWorkers } from "./detectors/duplicateWorker";
import { detectErrorBursts } from "./detectors/errorBurst";
import { detectLatencyOutliers } from "./detectors/latency";
import { detectModelChurn } from "./detectors/modelChurn";
import { detectNoProgress } from "./detectors/noProgress";
import { detectResourcePressure } from "./detectors/resource";
import { detectRetryStorms } from "./detectors/retryStorm";
import type { Detector, DiagnosticsConfigOverrides, Finding, FindingKind } from "./types";
import { SEVERITY_RANK, resolveConfig } from "./types";
import { sortEvents } from "./util";

export * from "./types";
export { FindingsController } from "./controller";
export type { DiagnosticsSelectionHost, FindingsFilter } from "./controller";
export { renderFindingsPanel } from "./panel";
export type { FindingsPanelOptions } from "./panel";

export const DETECTORS: Record<FindingKind, Detector> = {
    "budget-pressure": detectBudgetPressure,
    compaction: detectCompaction,
    "no-progress-loop": detectNoProgress,
    "duplicate-worker": detectDuplicateWorkers,
    "retry-storm": detectRetryStorms,
    "cache-thrash": detectCacheThrash,
    "model-churn": detectModelChurn,
    "latency-outlier": detectLatencyOutliers,
    "error-burst": detectErrorBursts,
    "resource-pressure": detectResourcePressure,
};

export interface RunOptions {
    config?: DiagnosticsConfigOverrides;
    /** Restrict to these detectors (default: all). */
    kinds?: readonly FindingKind[];
}

/** Findings ordered by start time, then severity (critical first), then id. */
export function compareFindings(a: Finding, b: Finding): number {
    return a.startNs - b.startNs || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Runs detectors over `events` (any order; sorted into replay order here).
 * Pure: never mutates input. Findings whose evidence ids are not in the
 * input are impossible by construction; this is asserted defensively.
 */
export function runDiagnostics(events: readonly ObservatoryEvent[], options: RunOptions = {}): Finding[] {
    const config = resolveConfig(options.config);
    // Session store / orderEvents arrays are already in replay order (and
    // never mutated; detectors only read), so a 1M-event session is not
    // copied and re-sorted.
    const sorted = isOrdered(events) ? events : sortEvents(events);
    const kinds = options.kinds ?? (Object.keys(DETECTORS) as FindingKind[]);
    const found: Finding[] = [];
    for (const kind of kinds) {
        for (const f of DETECTORS[kind](sorted, config)) {
            found.push(f);
        }
    }
    // Defensive evidence check: every evidence id must be in the input. Only
    // the (few) evidence ids are put in a set, not every event id.
    const missing = new Set<string>();
    for (const f of found) {
        for (const id of f.evidenceEventIds) {
            missing.add(id);
        }
    }
    for (let i = 0; i < sorted.length && missing.size > 0; i += 1) {
        missing.delete(sorted[i]!.event_id);
    }
    const out = found.filter((f) => f.evidenceEventIds.length > 0 && f.evidenceEventIds.every((id) => !missing.has(id)));
    return out.sort(compareFindings);
}
