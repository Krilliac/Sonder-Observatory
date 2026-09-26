/**
 * Report model shared by every export format. Built only from public APIs:
 * deriveMetrics (query), runDiagnostics (diagnostics), deriveTopology /
 * layoutTopology / buildScene (topology) and the timeline LOD model. Pure and
 * deterministic for a given (events, range, generatedAt).
 */
import { runDiagnostics, type DiagnosticsConfigOverrides, type Finding } from "../diagnostics";
import type { ObservatoryEvent } from "../protocol/events";
import { classifyEvent, type EventClass } from "../query/classify";
import { deriveMetrics, type Metrics } from "../query/metrics";
import { bucketize, getEventIndex, TRACKS } from "../renderer/timelineModel";
import { buildScene, deriveTopology, layoutTopology, type TopologyScene } from "../topology";
import { describeRange, filterEvents, type ExportRange } from "./filter";

export const EXPORT_FORMAT = "sonder.observatory.export/1";

export interface EvidenceRef {
    eventId: string;
    eventType: string;
    /** Seconds relative to the first exported event; null if the id is not in the export. */
    relS: number | null;
    cls: EventClass | null;
}

export interface ReportFinding extends Finding {
    evidence: EvidenceRef[];
    startRelS: number;
    endRelS: number;
}

export interface TimelineSnapshot {
    tracks: readonly EventClass[];
    width: number;
    durationS: number;
    /** counts[track][column] */
    counts: number[][];
    maxPerTrack: number[];
    total: number;
}

export interface ReportInput {
    /** Session events in replay order (e.g. SessionStore.events). */
    events: readonly ObservatoryEvent[];
    range?: ExportRange;
    /** Stamp written into the export; pass a fixed Date for reproducible output. */
    generatedAt?: Date;
    title?: string;
    diagnostics?: DiagnosticsConfigOverrides;
    /** Timeline snapshot resolution (columns). Default 96. */
    timelineColumns?: number;
}

export interface Report {
    format: typeof EXPORT_FORMAT;
    title: string;
    generatedAt: string;
    source: {
        sessionIds: string[];
        producers: string[];
        synthetic: boolean;
        totalEvents: number;
        exportedEvents: number;
        range: string;
        firstWallTime: string | null;
        lastWallTime: string | null;
        originMonoNs: number;
        durationS: number;
    };
    metrics: Metrics;
    findings: ReportFinding[];
    topology: TopologyScene;
    timeline: TimelineSnapshot;
    /** The events the report covers (the exported range), replay order. */
    events: readonly ObservatoryEvent[];
}

function unique<T>(values: Iterable<T>): T[] {
    return [...new Set(values)];
}

export function buildReport(input: ReportInput): Report {
    const range = input.range ?? {};
    const events = filterEvents(input.events, range);
    const originNs = events[0]?.mono_ns ?? 0;
    const relS = (ns: number): number => Math.round((ns - originNs) / 1e6) / 1e3;
    const byId = new Map<string, ObservatoryEvent>();
    for (const e of events) {
        if (!byId.has(e.event_id)) {
            byId.set(e.event_id, e);
        }
    }
    const findings: ReportFinding[] = runDiagnostics(events, { config: input.diagnostics }).map((f) => ({
        ...f,
        startRelS: relS(f.startNs),
        endRelS: relS(f.endNs),
        evidence: f.evidenceEventIds.map((id) => {
            const e = byId.get(id);
            return { eventId: id, eventType: e?.event_type ?? "unknown", relS: e ? relS(e.mono_ns) : null, cls: e ? classifyEvent(e) : null };
        }),
    }));
    const graph = deriveTopology(events);
    const topology = buildScene(graph, layoutTopology(graph));
    const index = getEventIndex(events);
    const b = bucketize(index, input.timelineColumns ?? 96);
    const counts = TRACKS.map((_, t) => Array.from(b.counts.subarray(t * b.width, (t + 1) * b.width)));
    const last = events[events.length - 1];
    return {
        format: EXPORT_FORMAT,
        title: input.title ?? "Sonder Observatory session report",
        generatedAt: (input.generatedAt ?? new Date()).toISOString(),
        source: {
            sessionIds: unique(events.map((e) => e.session_id)),
            producers: unique(events.map((e) => `${e.producer.name} ${e.producer.version}`)),
            synthetic: events.some((e) => e.producer.synthetic === true),
            totalEvents: input.events.length,
            exportedEvents: events.length,
            range: describeRange(range, input.events[0]?.mono_ns ?? 0),
            firstWallTime: events[0]?.wall_time ?? null,
            lastWallTime: last?.wall_time ?? null,
            originMonoNs: originNs,
            durationS: last ? relS(last.mono_ns) : 0,
        },
        metrics: deriveMetrics(events),
        findings,
        topology,
        timeline: {
            tracks: TRACKS,
            width: b.width,
            durationS: relS(originNs + index.durationNs),
            counts,
            maxPerTrack: Array.from(b.maxPerTrack),
            total: b.total,
        },
        events,
    };
}
