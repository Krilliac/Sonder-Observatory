import type { ObservatoryEvent } from "../../protocol/events";
import type { Detector, Finding } from "../types";
import { groupBy, makeFinding, num, pct, str } from "../util";
import { episodes, severityFor } from "./shared";

interface MemSample {
    event: ObservatoryEvent;
    fraction: number;
    used: number | null;
    total: number | null;
}

function memSample(e: ObservatoryEvent): MemSample | null {
    const used = num(e, "used_bytes");
    const total = num(e, "total_bytes");
    if (used !== null && total !== null && total > 0) {
        return { event: e, fraction: used / total, used, total };
    }
    const fraction = num(e, "used_fraction");
    return fraction === null ? null : { event: e, fraction, used: null, total: null };
}

function gib(bytes: number): string {
    return `${(bytes / 2 ** 30).toFixed(2)} GiB`;
}

/**
 * Resource pressure.
 *
 * - `device.memory.sample` series per device and memory kind (vram/ram/...):
 *   each contiguous run with used/total >= `resource.warnFraction` is one
 *   finding; severity from the peak.
 * - `kv.pressure` events are restated as producer-reported findings; severity
 *   from `occupancy` when present, otherwise warning.
 */
export const detectResourcePressure: Detector = (events, config) => {
    const { warnFraction, criticalFraction } = config.resource;
    const findings: Finding[] = [];

    const samples: MemSample[] = [];
    for (const e of events) {
        if (e.event_type === "device.memory.sample") {
            const s = memSample(e);
            if (s) {
                samples.push(s);
            }
        }
    }
    const key = (s: MemSample) => `${s.event.device_id ?? "unknown-device"}/${str(s.event, "kind") ?? "memory"}`;
    for (const [scope, series] of groupBy(samples, key)) {
        for (const ep of episodes(series, (s) => s.fraction >= warnFraction)) {
            const peak = ep.reduce((a, b) => (b.fraction > a.fraction ? b : a));
            const bytes = peak.used !== null && peak.total !== null ? ` (${gib(peak.used)} of ${gib(peak.total)})` : "";
            findings.push(
                makeFinding(
                    "resource-pressure",
                    severityFor(peak.fraction, warnFraction, criticalFraction) ?? "warning",
                    ep.map((s) => s.event),
                    `${scope} memory at or above ${pct(warnFraction)} for ${ep.length} sample(s); peak ${pct(peak.fraction)}${bytes}.`,
                    { scope, samples: ep.length, peak_fraction: peak.fraction },
                ),
            );
        }
    }

    for (const e of events) {
        if (e.event_type !== "kv.pressure") {
            continue;
        }
        const occupancy = num(e, "occupancy", "used_fraction");
        findings.push(
            makeFinding(
                "resource-pressure",
                occupancy === null ? "warning" : (severityFor(occupancy, warnFraction, criticalFraction) ?? "info"),
                [e],
                `Producer reported KV cache pressure${occupancy === null ? "" : ` at ${pct(occupancy)} occupancy`}${e.device_id ? ` on ${e.device_id}` : ""}.`,
                occupancy === null ? {} : { occupancy },
                "producer-reported",
            ),
        );
    }
    return findings;
};
