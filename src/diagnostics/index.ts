/**
 * Diagnostics entry point: run all detectors over an event stream.
 * See INTEGRATION_NOTES.md (branch root) for wiring into the renderer.
 */
import type { ObservatoryEvent } from "../protocol/events";
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
    const sorted = sortEvents(events);
    const known = new Set(sorted.map((e) => e.event_id));
    const kinds = options.kinds ?? (Object.keys(DETECTORS) as FindingKind[]);
    const out: Finding[] = [];
    for (const kind of kinds) {
        for (const f of DETECTORS[kind](sorted, config)) {
            if (f.evidenceEventIds.length > 0 && f.evidenceEventIds.every((id) => known.has(id))) {
                out.push(f);
            }
        }
    }
    return out.sort(compareFindings);
}
