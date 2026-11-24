/**
 * Percentile and request-latency statistics derived from measured durations.
 */

export interface LatencyStats {
    count: number;
    p50Ms: number | null;
    p95Ms: number | null;
    maxMs: number | null;
}

/** Nearest-rank percentile of a list of numbers. */
export function percentile(values: readonly number[], p: number): number | null {
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}

export function latencyStats(durationsNs: readonly number[]): LatencyStats {
    const ms = durationsNs.map((d) => d / 1e6);
    // A loop, not Math.max(...ms): spreading throws RangeError past ~125k values.
    let maxMs: number | null = null;
    for (const v of ms) {
        if (maxMs === null || v > maxMs) {
            maxMs = v;
        }
    }
    return {
        count: ms.length,
        p50Ms: percentile(ms, 50),
        p95Ms: percentile(ms, 95),
        maxMs,
    };
}

export function latencyByProducer(
    finished: readonly { producer: string; startNs: number; endNs: number | null }[],
): Record<string, LatencyStats> {
    const durationsByProducer = new Map<string, number[]>();
    for (const s of finished) {
        const list = durationsByProducer.get(s.producer) ?? [];
        list.push(s.endNs! - s.startNs);
        durationsByProducer.set(s.producer, list);
    }
    const requestLatencyByProducer: Record<string, LatencyStats> = {};
    for (const [producer, durations] of durationsByProducer) {
        requestLatencyByProducer[producer] = latencyStats(durations);
    }
    return requestLatencyByProducer;
}
