/**
 * Execution-mode routing, ensemble, and fanout telemetry reducer.
 *
 * Reads structured `execution_route` payloads (Sonder Runtime PR #881
 * Difficulty -> Execution-Mode Router) as well as flattened `execution_mode`,
 * `ensemble.*`, and `fanout.*` telemetry attributes/events when emitted.
 *
 * Legacy streams without explicit execution_route / ensemble / fanout markers
 * yield zero records so existing views stay unchanged.
 */
import type { ObservatoryEvent } from "../protocol/events";
import { streamKey } from "../replay/order";
import { scopedRequestKey } from "./identity";

export type ExecutionMode = "single" | "ensemble" | "fanout" | "agent";
export type DifficultyBand = "quick" | "standard" | "hard" | "multi_scope";

export interface ExecutionRouteRecord {
    key: string;
    eventId: string;
    monoNs: number;
    wallTime: string;
    requestId: string | null;
    producer: string;
    nodeId: string;
    synthetic: boolean;
    mode: ExecutionMode;
    band: DifficultyBand | null;
    difficultyScore: number | null;
    recommendedTiers: string[];
    ensembleMode: string | null;
    fanoutScope: string | null;
    autoSelected: boolean | null;
    reason: string | null;
    signals: string[];
    summaryLine: string | null;
    /** Number of workers / candidates participating in ensemble or fanout, if reported. */
    participantCount: number | null;
}

export interface ExecutionRouteMetrics {
    total: number;
    byMode: Record<ExecutionMode, number>;
    byBand: Record<DifficultyBand, number>;
    autoCount: number;
    manualCount: number;
    synthetic: boolean;
    latest: ExecutionRouteRecord | null;
    records: ExecutionRouteRecord[];
}

const VALID_MODES: ReadonlySet<string> = new Set(["single", "ensemble", "fanout", "agent"]);
const VALID_BANDS: ReadonlySet<string> = new Set(["quick", "standard", "hard", "multi_scope"]);
const MAX_ROUTE_LIST = 16;
const MAX_ROUTE_TEXT = 256;

function asObject(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return null;
    }
    return trimmed.length > MAX_ROUTE_TEXT ? `${trimmed.slice(0, MAX_ROUTE_TEXT - 1)}…` : trimmed;
}

function stringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const out: string[] = [];
    for (const v of value) {
        const t = text(v);
        if (t !== null) {
            out.push(t);
            if (out.length >= MAX_ROUTE_LIST) {
                break;
            }
        }
    }
    return out;
}

function parseMode(value: unknown): ExecutionMode | null {
    const s = text(value)?.toLowerCase();
    return s && VALID_MODES.has(s) ? (s as ExecutionMode) : null;
}

function parseBand(value: unknown): DifficultyBand | null {
    const s = text(value)?.toLowerCase().replace(/-/g, "_");
    return s && VALID_BANDS.has(s) ? (s as DifficultyBand) : null;
}

function parseScore(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function positiveInt(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** Fast check used by the sparse index so unrelated events are skipped in O(1). */
export function isExecutionRouteEvent(event: ObservatoryEvent): boolean {
    const t = event.event_type;
    if (t.startsWith("ensemble.") || t.startsWith("fanout.") || t.startsWith("execution_route.")) {
        return true;
    }
    const a = event.attributes;
    return (
        a.execution_route !== undefined ||
        a.execution_mode !== undefined ||
        a.ensemble !== undefined ||
        a.fanout !== undefined ||
        a.operation === "ensemble" ||
        a.operation === "fanout" ||
        a.difficulty_band !== undefined ||
        a.difficulty_score !== undefined
    );
}

/** Parses one event's execution_route / ensemble / fanout payload, or null when absent. */
export function parseExecutionRoute(event: ObservatoryEvent): ExecutionRouteRecord | null {
    const t = event.event_type;
    const a = event.attributes;

    const routeObj = asObject(a.execution_route);
    const ensembleObj = asObject(a.ensemble);
    const fanoutObj = asObject(a.fanout);

    let mode: ExecutionMode | null =
        parseMode(routeObj?.mode) ??
        parseMode(a.execution_mode) ??
        (t.startsWith("ensemble.") ? "ensemble" : null) ??
        (t.startsWith("fanout.") ? "fanout" : null) ??
        (a.operation === "ensemble" ? "ensemble" : a.operation === "fanout" ? "fanout" : null) ??
        (a.ensemble === true || ensembleObj !== null ? "ensemble" : null) ??
        (a.fanout === true || fanoutObj !== null ? "fanout" : null);

    // If difficulty metadata is present without an explicit mode on a route/request event,
    // default mode only if mode was specified; otherwise require an explicit mode signal.
    if (mode === null && routeObj !== null) {
        mode = parseMode(routeObj.execution_mode);
    }
    if (mode === null) {
        return null;
    }

    const band = parseBand(routeObj?.band) ?? parseBand(routeObj?.difficulty_band) ?? parseBand(a.difficulty_band) ?? parseBand(a.band);
    const difficultyScore = parseScore(routeObj?.difficulty_score) ?? parseScore(a.difficulty_score);

    const tiersRaw =
        stringArray(routeObj?.recommended_tiers).length > 0
            ? stringArray(routeObj?.recommended_tiers)
            : stringArray(routeObj?.tiers).length > 0
              ? stringArray(routeObj?.tiers)
              : stringArray(a.recommended_tiers).length > 0
                ? stringArray(a.recommended_tiers)
                : stringArray(ensembleObj?.tiers).length > 0
                  ? stringArray(ensembleObj?.tiers)
                  : stringArray(fanoutObj?.tiers).length > 0
                    ? stringArray(fanoutObj?.tiers)
                    : stringArray(a.tiers);

    const ensembleMode = text(routeObj?.ensemble_mode) ?? text(ensembleObj?.mode) ?? text(a.ensemble_mode);
    const fanoutScope = text(routeObj?.fanout_scope) ?? text(fanoutObj?.scope) ?? text(a.fanout_scope);
    const autoSelected =
        typeof routeObj?.auto_selected === "boolean"
            ? routeObj.auto_selected
            : typeof a.auto_selected === "boolean"
              ? a.auto_selected
              : null;
    const reason = text(routeObj?.reason) ?? text(a.route_reason) ?? (routeObj || a.execution_mode || t.startsWith("ensemble.") || t.startsWith("fanout.") ? text(a.reason) : null);
    const signals = stringArray(routeObj?.signals).length > 0 ? stringArray(routeObj?.signals) : stringArray(a.signals);
    const summaryLine = text(routeObj?.route_summary_line) ?? text(routeObj?.summary) ?? text(a.route_summary_line) ?? text(a.route_summary);

    const participants =
        positiveInt(ensembleObj?.count) ??
        positiveInt(fanoutObj?.count) ??
        positiveInt(fanoutObj?.workers) ??
        positiveInt(a.worker_count) ??
        positiveInt(a.candidate_count) ??
        (stringArray(ensembleObj?.models).length > 0 ? stringArray(ensembleObj?.models).length : null) ??
        (stringArray(fanoutObj?.models).length > 0 ? stringArray(fanoutObj?.models).length : null);

    const rid = text(event.request_id);
    const key = rid ? scopedRequestKey(streamKey(event), rid) : event.event_id;

    return {
        key,
        eventId: event.event_id,
        monoNs: event.mono_ns,
        wallTime: event.wall_time,
        requestId: rid,
        producer: event.producer.name,
        nodeId: event.producer.node_id,
        synthetic: event.producer.synthetic === true,
        mode,
        band,
        difficultyScore,
        recommendedTiers: tiersRaw,
        ensembleMode,
        fanoutScope,
        autoSelected,
        reason,
        signals,
        summaryLine,
        participantCount: participants,
    };
}

function mergeRecord(prev: ExecutionRouteRecord, next: ExecutionRouteRecord): ExecutionRouteRecord {
    return {
        ...prev,
        eventId: next.eventId,
        monoNs: next.monoNs,
        wallTime: next.wallTime || prev.wallTime,
        synthetic: prev.synthetic || next.synthetic,
        mode: next.mode,
        band: next.band ?? prev.band,
        difficultyScore: next.difficultyScore ?? prev.difficultyScore,
        recommendedTiers: next.recommendedTiers.length > 0 ? next.recommendedTiers : prev.recommendedTiers,
        ensembleMode: next.ensembleMode ?? prev.ensembleMode,
        fanoutScope: next.fanoutScope ?? prev.fanoutScope,
        autoSelected: next.autoSelected ?? prev.autoSelected,
        reason: next.reason ?? prev.reason,
        signals: next.signals.length > 0 ? next.signals : prev.signals,
        summaryLine: next.summaryLine ?? prev.summaryLine,
        participantCount: next.participantCount ?? prev.participantCount,
    };
}

/**
 * Aggregates `execution_route` / ensemble / fanout records per request (or per
 * event when no `request_id` is present), in replay order.
 */
export function deriveExecutionRoutes(events: Iterable<ObservatoryEvent>): ExecutionRouteMetrics {
    const byKey = new Map<string, ExecutionRouteRecord>();
    for (const event of events) {
        if (!isExecutionRouteEvent(event)) {
            continue;
        }
        const parsed = parseExecutionRoute(event);
        if (!parsed) {
            continue;
        }
        const existing = byKey.get(parsed.key);
        byKey.set(parsed.key, existing ? mergeRecord(existing, parsed) : parsed);
    }

    const records = [...byKey.values()];
    const byMode: Record<ExecutionMode, number> = { single: 0, ensemble: 0, fanout: 0, agent: 0 };
    const byBand: Record<DifficultyBand, number> = { quick: 0, standard: 0, hard: 0, multi_scope: 0 };
    let autoCount = 0;
    let manualCount = 0;
    let synthetic = false;

    for (const r of records) {
        byMode[r.mode] += 1;
        if (r.band) {
            byBand[r.band] += 1;
        }
        if (r.autoSelected === true) {
            autoCount += 1;
        } else if (r.autoSelected === false) {
            manualCount += 1;
        }
        synthetic ||= r.synthetic;
    }

    return {
        total: records.length,
        byMode,
        byBand,
        autoCount,
        manualCount,
        synthetic,
        latest: records.at(-1) ?? null,
        records,
    };
}
