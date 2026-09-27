/**
 * Small time series for the metric strip sparklines. Every point comes from
 * measured or producer-reported events up to the replay cursor; a series
 * with no evidence is empty (the strip then shows no sparkline), never zeros
 * standing in for missing data.
 */
import type { ObservatoryEvent } from "../protocol/events";
import type { Metrics } from "./metrics";
import { percentile } from "./metrics";

export const SPARK_BUCKETS = 24;
/** Finished requests per rolling latency percentile. */
export const LATENCY_WINDOW = 8;

export interface KvSnapshot {
    /** Used fraction 0..1 (blocks in use / total, or kv.pressure occupancy). */
    fraction: number;
    usedBlocks: number | null;
    totalBlocks: number | null;
    source: "blocks" | "occupancy";
    producers: number;
}

export interface ActiveModel {
    model: string;
    source: "route.selected" | "session.created" | "model.load";
    producer: string;
    nodeId: string;
    /** Distinct model names seen. */
    distinct: number;
}

export interface StripSeries {
    /** Decode tokens per second per time bucket (decode windows spread over buckets). */
    tokensPerSec: number[];
    latencyP50: number[];
    latencyP95: number[];
    /** KV used fraction per bucket (last value in each bucket, carried forward). */
    kv: number[];
    kvLatest: KvSnapshot | null;
    /** agent.*, route.* and tool.* events per bucket. */
    agentActivity: number[];
    activeModel: ActiveModel | null;
}

function int(v: unknown): number | null {
    return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function num(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const cache = new WeakMap<Metrics, StripSeries>();

/** Series over the events visible at the cursor; `metrics` must be derived from the same events. */
export function stripSeries(events: readonly ObservatoryEvent[], metrics: Metrics, buckets = SPARK_BUCKETS): StripSeries {
    const cached = cache.get(metrics);
    if (cached) {
        return cached;
    }
    const first = events[0]?.mono_ns ?? 0;
    const last = events[events.length - 1]?.mono_ns ?? 0;
    const span = Math.max(1, last - first);
    const width = span / buckets;
    const bucketOf = (ns: number) => Math.min(buckets - 1, Math.max(0, Math.floor((ns - first) / width)));

    // Tokens per second: each request's decode window spread over the buckets it overlaps.
    const tokens = new Array<number>(buckets).fill(0);
    let anyDecode = false;
    for (const r of metrics.requests) {
        const d = r.decode;
        if (!d || d.ns <= 0) {
            continue;
        }
        anyDecode = true;
        for (let b = bucketOf(d.startNs); b <= bucketOf(d.endNs); b++) {
            const b0 = first + b * width;
            const overlap = Math.max(0, Math.min(d.endNs, b0 + width) - Math.max(d.startNs, b0));
            tokens[b]! += (d.tokens * overlap) / d.ns;
        }
    }
    const tokensPerSec = anyDecode ? tokens.map((t) => t / (width / 1e9)) : [];

    // Rolling latency percentiles over finished requests, in end order.
    const finished = metrics.requests.filter((r) => r.endNs !== null).sort((a, b) => a.endNs! - b.endNs!);
    const latencyP50: number[] = [];
    const latencyP95: number[] = [];
    for (let i = 0; i < finished.length; i++) {
        const window = finished.slice(Math.max(0, i + 1 - LATENCY_WINDOW), i + 1).map((r) => (r.endNs! - r.startNs) / 1e6);
        latencyP50.push(percentile(window, 50)!);
        latencyP95.push(percentile(window, 95)!);
    }

    // KV: logical blocks per producer stream (kv.allocated - kv.freed over scheduler totals), else kv.pressure occupancy.
    const used = new Map<string, number>();
    const total = new Map<string, number>();
    const occupancy = new Map<string, number>();
    const kvBuckets = new Array<number | null>(buckets).fill(null);
    let kvLatest: KvSnapshot | null = null;
    const agent = new Array<number>(buckets).fill(0);
    let anyAgent = false;
    let activeModel: ActiveModel | null = null;
    const models = new Set<string>();

    for (const e of events) {
        const t = e.event_type;
        const key = `${e.producer.name}\u0000${e.producer.node_id}\u0000${e.producer.instance_id ?? e.session_id}`;
        let kvChanged = false;
        if (t === "scheduler.configured") {
            const n = int(e.attributes.kv_num_blocks);
            if (n !== null && n > 0) {
                total.set(key, n);
                kvChanged = true;
            }
        } else if (t === "kv.allocated" || t === "kv.freed") {
            const blocks = int(e.attributes.blocks) ?? 0;
            used.set(key, Math.max(0, (used.get(key) ?? 0) + (t === "kv.allocated" ? blocks : -blocks)));
            kvChanged = true;
        } else if (t === "kv.pressure") {
            const o = num(e.attributes.occupancy) ?? num(e.attributes.utilization);
            const n = int(e.attributes.total_blocks);
            if (n !== null && n > 0) {
                total.set(key, n);
            }
            if (o !== null) {
                occupancy.set(key, o);
            }
            kvChanged = true;
        }
        if (kvChanged) {
            const keys = new Set([...used.keys(), ...occupancy.keys()]);
            let u = 0;
            let tot = 0;
            let blocksKnown = true;
            let occ = 0;
            for (const k of keys) {
                const cap = total.get(k);
                if (used.has(k) && cap !== undefined) {
                    u += used.get(k)!;
                    tot += cap;
                } else {
                    blocksKnown = false;
                }
                occ = Math.max(occ, occupancy.get(k) ?? 0);
            }
            if (keys.size > 0) {
                kvLatest =
                    blocksKnown && tot > 0
                        ? { fraction: u / tot, usedBlocks: u, totalBlocks: tot, source: "blocks", producers: keys.size }
                        : occupancy.size > 0
                          ? { fraction: occ, usedBlocks: null, totalBlocks: null, source: "occupancy", producers: keys.size }
                          : kvLatest;
                if (kvLatest) {
                    kvBuckets[bucketOf(e.mono_ns)] = kvLatest.fraction;
                }
            }
        }
        if (t.startsWith("agent.") || t.startsWith("route.") || t.startsWith("tool.")) {
            agent[bucketOf(e.mono_ns)]! += 1;
            anyAgent = true;
        }
        const model =
            t === "route.selected"
                ? { m: e.attributes.model, s: "route.selected" as const }
                : t === "session.created"
                  ? { m: e.attributes.model, s: "session.created" as const }
                  : t.startsWith("model.load.")
                    ? { m: e.attributes.model, s: "model.load" as const }
                    : null;
        if (model && typeof model.m === "string" && model.m !== "") {
            models.add(model.m);
            activeModel = { model: model.m, source: model.s, producer: e.producer.name, nodeId: e.producer.node_id, distinct: 0 };
        }
    }
    if (activeModel) {
        activeModel.distinct = models.size;
    }
    // Carry the last KV value forward through buckets without KV events.
    const kv: number[] = [];
    let carry: number | null = null;
    for (const v of kvBuckets) {
        carry = v ?? carry;
        // Buckets before the first KV report are left out, not drawn as zero.
        if (carry !== null) {
            kv.push(carry);
        }
    }
    const series: StripSeries = {
        tokensPerSec,
        latencyP50,
        latencyP95,
        kv: kvLatest ? kv : [],
        kvLatest,
        agentActivity: anyAgent ? agent : [],
        activeModel,
    };
    cache.set(metrics, series);
    return series;
}
