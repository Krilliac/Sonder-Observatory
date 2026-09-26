import type { ObservatoryEvent } from "../../protocol/events";
import type { Detector, Finding } from "../types";
import { NS_PER_MS, findBursts, groupBy, makeFinding, pct } from "../util";

interface Window {
    index: number;
    hits: ObservatoryEvent[];
    misses: ObservatoryEvent[];
}

function cacheScope(e: ObservatoryEvent): string {
    return e.model_instance_id ? `model:${e.model_instance_id}` : e.device_id ? `device:${e.device_id}` : "all";
}

/**
 * Cache thrash.
 *
 * Hit-rate collapse: per scope (model_instance_id > device_id), kv lookups
 * are bucketed into fixed `cacheThrash.windowMs` windows. `kv.reused` counts
 * as a hit and `kv.allocated` as a miss (one event = one lookup). A window
 * with at least `minLookups` whose hit rate is <= dropRatio x the mean of the
 * previous (up to 3) qualifying windows, where that baseline is at least
 * `baselineHitRate`, is a collapse. Evidence: baseline and collapsed windows.
 *
 * Eviction churn: `evictionCount` or more `kv.evicted` within `windowMs`.
 */
export const detectCacheThrash: Detector = (events, config) => {
    const cfg = config.cacheThrash;
    const findings: Finding[] = [];
    const lookups = events.filter((e) => e.event_type === "kv.reused" || e.event_type === "kv.allocated");

    for (const [scope, list] of groupBy(lookups, cacheScope)) {
        const t0 = list[0]!.mono_ns;
        const windowNs = cfg.windowMs * NS_PER_MS;
        const windows = new Map<number, Window>();
        for (const e of list) {
            const index = Math.floor((e.mono_ns - t0) / windowNs);
            const w = windows.get(index) ?? { index, hits: [], misses: [] };
            (e.event_type === "kv.reused" ? w.hits : w.misses).push(e);
            windows.set(index, w);
        }
        const qualifying = [...windows.values()]
            .filter((w) => w.hits.length + w.misses.length >= cfg.minLookups)
            .sort((a, b) => a.index - b.index);
        for (let i = 1; i < qualifying.length; i++) {
            const prior = qualifying.slice(Math.max(0, i - 3), i);
            const rate = (w: Window) => w.hits.length / (w.hits.length + w.misses.length);
            const baseline = prior.reduce((s, w) => s + rate(w), 0) / prior.length;
            const cur = qualifying[i]!;
            const current = rate(cur);
            if (baseline >= cfg.baselineHitRate && current <= baseline * cfg.dropRatio) {
                const evidence = [...prior, cur].flatMap((w) => [...w.hits, ...w.misses]);
                findings.push(
                    makeFinding(
                        "cache-thrash",
                        current === 0 ? "critical" : "warning",
                        evidence,
                        `KV hit rate in ${scope} fell to ${pct(current)} (${cur.hits.length}/${cur.hits.length + cur.misses.length} lookups) from a baseline of ${pct(baseline)} over the previous ${prior.length} window(s) of ${cfg.windowMs} ms.`,
                        { scope, hit_rate: current, baseline_hit_rate: baseline, lookups: cur.hits.length + cur.misses.length },
                        "derived",
                        `hitrate:${cur.hits[0]?.event_id ?? cur.misses[0]!.event_id}`,
                    ),
                );
            }
        }
    }

    const evictions = events.filter((e) => e.event_type === "kv.evicted");
    for (const burst of findBursts(evictions, cfg.evictionCount, cfg.windowMs)) {
        findings.push(
            makeFinding(
                "cache-thrash",
                burst.length >= cfg.evictionCount * 2 ? "critical" : "warning",
                burst,
                `${burst.length} KV evictions within ${Math.round((burst[burst.length - 1]!.mono_ns - burst[0]!.mono_ns) / NS_PER_MS)} ms (threshold ${cfg.evictionCount} per ${cfg.windowMs} ms).`,
                { evictions: burst.length },
                "derived",
                `evictions:${burst[0]!.event_id}`,
            ),
        );
    }
    return findings;
};
