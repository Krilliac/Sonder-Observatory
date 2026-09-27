/**
 * Session comparison (src/compare): two recordings, or a recording and the
 * current/live session, aligned by run, request or turn. See
 * docs/integration/compare.md.
 */
export { alignUnits, type AlignedPair, type Alignment, type MatchedBy } from "./align";
export { compareAnalyses, compareSessions, type AlignedRow, type Comparison } from "./compare";
export {
    CompareController,
    SIDE_TITLES,
    type CompareControllerOptions,
    type LoadResult,
    type SideId,
    type SideSource,
    type SideView,
} from "./controller";
export { METRICS, deltas, metricDelta, type MetricDef, type MetricDelta, type MetricKey, type MetricUnit, type Polarity, type Verdict } from "./delta";
export { SIGNATURE_FACT_KEYS, diffFindings, findingSignature, type FindingsDiff, type PersistingFinding } from "./findings";
export { diffGraphs, type EdgeChange, type GraphDiff, type NodeChange } from "./graphDiff";
export { describeAlignment, formatDelta, formatValue, presentDelta, type MetricCell } from "./present";
export { ALIGN_MODES, analyzeSession, requestFacts, type AlignMode, type RequestFacts, type SessionAnalysis, type UnitGroup, type UnitStats } from "./summary";
export * from "./readers";
