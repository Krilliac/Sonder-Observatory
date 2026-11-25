/**
 * Report model shared by every export format. Built only from public APIs:
 * deriveMetrics (query), runDiagnostics (diagnostics), deriveTopology /
 * layoutTopology / buildScene (topology) and the timeline LOD model. Pure and
 * deterministic for a given (events, range, generatedAt).
 */
import { runDiagnostics, type DiagnosticsConfigOverrides, type Finding } from "../diagnostics";
import type { ObservatoryEvent } from "../protocol/events";
import { classifyEvent, type EventClass } from "../query/classify";
import {
    deriveGpuMemory,
    deriveNodeGpuMemory,
    type CombinedGpuPool,
    type GpuDeviceClass,
    type GpuWeightsEvidence,
} from "../query/gpuMemory";
import { deriveMetrics, type Metrics } from "../query/metrics";
import { bucketize, getEventIndex, TRACKS } from "../renderer/timelineModel";
import { buildScene, deriveTopology, layoutTopology, type TopologyScene } from "../topology";
import { describeRange, filterEvents, type ExportRange } from "./filter";

export const EXPORT_FORMAT = "sonder.observatory.export/1";

const MAX_TIMELINE_COLUMNS = 2048;
const MAX_GPU_NODES = 64;
const MAX_GPU_DEVICES_PER_NODE = 64;
const MAX_GPU_BACKENDS = 64;
const MAX_GPU_WARNING_CODES = 32;

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

/** Bounded per-device discrete / integrated-UMA GPU summary for exports. */
export interface ReportGpuDeviceSummary {
    deviceId: string;
    name: string;
    vendor: string | null;
    gpuClass: GpuDeviceClass;
    isIntegratedUma: boolean | null;
    dedicatedTotalBytes: number | null;
    sharedTotalBytes: number | null;
    effectiveTotalBytes: number | null;
    effectiveUsedBytes: number | null;
    effectiveFreeBytes: number | null;
    peakUsedBytes: number | null;
    usedFraction: number | null;
    carryingModelWeights: boolean;
    weightsEvidence: GpuWeightsEvidence;
    sampleCount: number;
}

export interface ReportGpuNodeSummary {
    nodeId: string;
    producer: string;
    instanceId: string | null;
    synthetic: boolean;
    devices: ReportGpuDeviceSummary[];
    combinedPool: CombinedGpuPool | null;
}

export interface ReportGpuBackendSummary {
    backend: string | null;
    producer: string;
    nodeId: string;
    instanceId: string | null;
    dedicatedBytes: number | null;
    sharedBytes: number | null;
    spillLimitBytes: number | null;
    spilled: boolean | null;
    fittedCtx: number | null;
    sampleCount: number;
    warningCount: number;
    warningCodes: string[];
}

export interface ReportGpuSummary {
    nodes: ReportGpuNodeSummary[];
    backends: ReportGpuBackendSummary[];
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
    /** Present when exported events include GPU/UMA device or backend GPU telemetry (Wave 2+). */
    gpu?: ReportGpuSummary;
    /** The events the report covers (the exported range), replay order. */
    events: readonly ObservatoryEvent[];
}

function unique<T>(values: Iterable<T>): T[] {
    return [...new Set(values)];
}

function safeIsoDate(d: Date | undefined): string {
    const candidate = d instanceof Date && Number.isFinite(d.getTime()) ? d : new Date();
    return candidate.toISOString();
}

function clampTimelineColumns(columns: number | undefined): number {
    if (typeof columns !== "number" || !Number.isFinite(columns)) {
        return 96;
    }
    return Math.max(1, Math.min(Math.floor(columns), MAX_TIMELINE_COLUMNS));
}

function buildGpuSummary(events: readonly ObservatoryEvent[]): ReportGpuSummary | undefined {
    const multiGpu = deriveNodeGpuMemory(events);
    const backendGpu = deriveGpuMemory(events);
    if (multiGpu.nodes.length === 0 && backendGpu.backends.length === 0) {
        return undefined;
    }
    const nodes: ReportGpuNodeSummary[] = multiGpu.nodes.slice(0, MAX_GPU_NODES).map((node) => ({
        nodeId: node.nodeId,
        producer: node.producer,
        instanceId: node.instanceId,
        synthetic: node.synthetic,
        devices: node.devices.slice(0, MAX_GPU_DEVICES_PER_NODE).map((dev) => ({
            deviceId: dev.deviceId,
            name: dev.name,
            vendor: dev.vendor,
            gpuClass: dev.gpuClass,
            isIntegratedUma: dev.isIntegratedUma,
            dedicatedTotalBytes: dev.latest?.dedicatedTotalBytes ?? null,
            sharedTotalBytes: dev.latest?.sharedTotalBytes ?? null,
            effectiveTotalBytes: dev.latest?.effectiveTotalBytes ?? null,
            effectiveUsedBytes: dev.latest?.effectiveUsedBytes ?? null,
            effectiveFreeBytes: dev.latest?.effectiveFreeBytes ?? null,
            peakUsedBytes: dev.peakUsedBytes,
            usedFraction: dev.latest?.usedFraction ?? null,
            carryingModelWeights: dev.carryingModelWeights,
            weightsEvidence: dev.weightsEvidence,
            sampleCount: dev.samples.length,
        })),
        combinedPool: node.combinedPool,
    }));
    const backends: ReportGpuBackendSummary[] = backendGpu.backends.slice(0, MAX_GPU_BACKENDS).map((b) => ({
        backend: b.backend,
        producer: b.producer,
        nodeId: b.nodeId,
        instanceId: b.instanceId,
        dedicatedBytes: b.latest?.dedicatedBytes ?? null,
        sharedBytes: b.latest?.sharedBytes ?? null,
        spillLimitBytes: b.latest?.spillLimitBytes ?? null,
        spilled: b.latest?.spilled ?? null,
        fittedCtx: b.fittedCtx,
        sampleCount: b.samples.length,
        warningCount: b.warnings.reduce((sum, w) => sum + w.count, 0),
        warningCodes: b.warnings.slice(0, MAX_GPU_WARNING_CODES).map((w) => w.code),
    }));
    return { nodes, backends };
}

export function buildReport(input: ReportInput): Report {
    const range = input.range ?? {};
    const events = filterEvents(input.events, range);
    const rawOrigin = events[0]?.mono_ns;
    const originNs = typeof rawOrigin === "number" && Number.isFinite(rawOrigin) ? rawOrigin : 0;
    const relS = (ns: number): number => (Number.isFinite(ns) ? Math.round((ns - originNs) / 1e6) / 1e3 : 0);
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
    const b = bucketize(index, clampTimelineColumns(input.timelineColumns));
    const counts = TRACKS.map((_, t) => Array.from(b.counts.subarray(t * b.width, (t + 1) * b.width)));
    const last = events[events.length - 1];
    const gpu = buildGpuSummary(events);
    const inputOrigin = input.events[0]?.mono_ns;
    return {
        format: EXPORT_FORMAT,
        title: input.title ?? "Sonder Observatory session report",
        generatedAt: safeIsoDate(input.generatedAt),
        source: {
            sessionIds: unique(events.map((e) => e.session_id)),
            producers: unique(events.map((e) => `${e.producer.name} ${e.producer.version}`)),
            synthetic: events.some((e) => e.producer.synthetic === true),
            totalEvents: input.events.length,
            exportedEvents: events.length,
            range: describeRange(range, typeof inputOrigin === "number" && Number.isFinite(inputOrigin) ? inputOrigin : 0),
            firstWallTime: events[0]?.wall_time ?? null,
            lastWallTime: last?.wall_time ?? null,
            originMonoNs: originNs,
            durationS: last ? Math.max(0, relS(last.mono_ns)) : 0,
        },
        metrics: deriveMetrics(events),
        findings,
        topology,
        timeline: {
            tracks: TRACKS,
            width: b.width,
            durationS: Math.max(0, relS(originNs + index.durationNs)),
            counts,
            maxPerTrack: Array.from(b.maxPerTrack),
            total: b.total,
        },
        ...(gpu ? { gpu } : {}),
        events,
    };
}
