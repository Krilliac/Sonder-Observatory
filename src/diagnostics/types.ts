/**
 * Diagnostics findings model.
 *
 * A finding is a derived observation over protocol events. Every finding
 * cites the events it was computed from (`evidenceEventIds`, never empty)
 * so the inspector can show evidence instead of prose guesses. Detectors
 * are pure functions: same events + same config => same findings.
 */
import type { ObservatoryEvent } from "../protocol/events";

export const FINDING_KINDS = [
    "budget-pressure",
    "compaction",
    "no-progress-loop",
    "duplicate-worker",
    "retry-storm",
    "cache-thrash",
    "model-churn",
    "latency-outlier",
    "error-burst",
    "resource-pressure",
] as const;

export type FindingKind = (typeof FINDING_KINDS)[number];

export type Severity = "info" | "warning" | "critical";

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export interface Finding {
    /** Deterministic id: `${kind}:${discriminator}` (stable across re-runs). */
    id: string;
    kind: FindingKind;
    severity: Severity;
    /** Time range in producer monotonic nanoseconds (inclusive). */
    startNs: number;
    endNs: number;
    /** One-line factual summary with units; no speculation about causes. */
    summary: string;
    /** Ids of the events this finding was derived from, in replay order. Never empty. */
    evidenceEventIds: string[];
    /** Numeric/string facts backing the summary (units in the key name). */
    facts: Record<string, number | string>;
    /**
     * "producer-reported" when the finding restates a producer-emitted guard.* or pressure
     * event as reported; "derived" when Observatory computed it from other events.
     */
    provenance: "derived" | "producer-reported";
}

export interface DiagnosticsConfig {
    budget: {
        /** used/limit fraction at or above which a warning is raised. */
        warnFraction: number;
        criticalFraction: number;
    };
    compaction: {
        /** Compactions within `windowMs` at or above this count => churn warning. */
        churnCount: number;
        windowMs: number;
    };
    noProgress: {
        /** Consecutive identical tool calls (same agent/tool/signature). */
        repeatCount: number;
    };
    duplicateWorker: {
        /** Attributes used (in order) to identify the work an agent was spawned for. */
        taskKeys: readonly string[];
    };
    retryStorm: {
        count: number;
        windowMs: number;
    };
    cacheThrash: {
        /** Size of each hit-rate window (ms). */
        windowMs: number;
        /** Minimum kv lookups (reused + allocated) per window to judge the rate. */
        minLookups: number;
        /** Baseline hit rate needed before a collapse is meaningful. */
        baselineHitRate: number;
        /** Current rate <= baseline * dropRatio => collapse. */
        dropRatio: number;
        /** kv.evicted events within windowMs at or above this => eviction churn. */
        evictionCount: number;
    };
    modelChurn: {
        /** load/unload lifecycle events within windowMs at or above this => churn. */
        count: number;
        windowMs: number;
    };
    latency: {
        /** Number of prior completed requests forming the rolling baseline. */
        baselineSize: number;
        /** Minimum prior requests before any outlier is reported. */
        minBaseline: number;
        /** duration > baseline p95 * factor ... */
        factor: number;
        /** ... and exceeds baseline p95 by at least this many ms. */
        minExcessMs: number;
    };
    errorBurst: {
        count: number;
        windowMs: number;
    };
    resource: {
        warnFraction: number;
        criticalFraction: number;
    };
}

export const DEFAULT_CONFIG: DiagnosticsConfig = {
    budget: { warnFraction: 0.8, criticalFraction: 0.95 },
    compaction: { churnCount: 3, windowMs: 60_000 },
    noProgress: { repeatCount: 3 },
    duplicateWorker: { taskKeys: ["task_hash", "task", "objective_hash"] },
    retryStorm: { count: 3, windowMs: 10_000 },
    cacheThrash: { windowMs: 5_000, minLookups: 10, baselineHitRate: 0.5, dropRatio: 0.5, evictionCount: 20 },
    modelChurn: { count: 4, windowMs: 60_000 },
    latency: { baselineSize: 20, minBaseline: 5, factor: 2, minExcessMs: 250 },
    errorBurst: { count: 3, windowMs: 5_000 },
    resource: { warnFraction: 0.85, criticalFraction: 0.95 },
};

/** Deep-partial override; unspecified fields keep DEFAULT_CONFIG values. */
export type DiagnosticsConfigOverrides = {
    [K in keyof DiagnosticsConfig]?: Partial<DiagnosticsConfig[K]>;
};

export function resolveConfig(overrides: DiagnosticsConfigOverrides = {}): DiagnosticsConfig {
    const out = { ...DEFAULT_CONFIG } as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_CONFIG) as (keyof DiagnosticsConfig)[]) {
        out[key] = { ...DEFAULT_CONFIG[key], ...(overrides[key] ?? {}) };
    }
    return out as unknown as DiagnosticsConfig;
}

/** A detector: pure function over events already in replay order. */
export type Detector = (events: readonly ObservatoryEvent[], config: DiagnosticsConfig) => Finding[];
