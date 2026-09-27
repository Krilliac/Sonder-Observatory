/**
 * Session comparison: A (baseline) vs B (candidate).
 */
import type { ObservatoryEvent } from "../protocol/events";
import { alignUnits, type Alignment } from "./align";
import { deltas, type MetricDelta } from "./delta";
import { diffFindings, type FindingsDiff, type SubjectMap } from "./findings";
import { diffGraphs, type GraphDiff } from "./graphDiff";
import { analyzeSession, type AlignMode, type SessionAnalysis } from "./summary";

export interface AlignedRow {
    label: string;
    status: "matched" | "only-a" | "only-b";
    deltas: MetricDelta[];
}

export interface Comparison {
    mode: AlignMode;
    a: SessionAnalysis;
    b: SessionAnalysis;
    /** Whole-session deltas. */
    totals: MetricDelta[];
    alignment: Alignment;
    rows: AlignedRow[];
    findings: FindingsDiff;
    graph: GraphDiff;
}

/**
 * Maps B request ids onto the A request they are aligned with, so findings
 * about "the same" request keep one signature even when the recordings use
 * different request ids (requests aligned by position). Uses the request
 * alignment whatever the view's mode, so the findings diff does not depend on it.
 */
function requestSubjectMap(a: SessionAnalysis, b: SessionAnalysis, requestAlignment?: Alignment): SubjectMap {
    const alignment = requestAlignment ?? alignUnits(a.groups.request, b.groups.request);
    const map = new Map<string, string>();
    for (const p of alignment.pairs) {
        if (p.a && p.b && p.a.key !== p.b.key) {
            map.set(p.b.key, p.a.key);
        }
    }
    return (id) => map.get(id) ?? id;
}

/** Compares two analyses (see analyzeSession) aligned by `mode`. */
export function compareAnalyses(a: SessionAnalysis, b: SessionAnalysis, mode: AlignMode = "request"): Comparison {
    const alignment = alignUnits(a.groups[mode], b.groups[mode]);
    return {
        mode,
        a,
        b,
        totals: deltas(a.totals, b.totals),
        alignment,
        rows: alignment.pairs.map((p) => ({ label: p.label, status: p.status, deltas: deltas(p.a, p.b) })),
        findings: diffFindings(a.findings, b.findings, requestSubjectMap(a, b, mode === "request" ? alignment : undefined)),
        graph: diffGraphs(a.topology, b.topology),
    };
}

/** Convenience: analyze and compare two event lists. */
export function compareSessions(
    a: readonly ObservatoryEvent[],
    b: readonly ObservatoryEvent[],
    mode: AlignMode = "request",
): Comparison {
    return compareAnalyses(analyzeSession(a), analyzeSession(b), mode);
}
