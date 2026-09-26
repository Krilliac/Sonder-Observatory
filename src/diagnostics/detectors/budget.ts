import type { ObservatoryEvent } from "../../protocol/events";
import type { Detector, Finding } from "../types";
import { groupBy, makeFinding, num, pct, str } from "../util";
import { episodes, scopeKey, severityFor } from "./shared";

const USED_KEYS = ["used_tokens", "context_tokens", "tokens_used"];
const LIMIT_KEYS = ["limit_tokens", "context_limit", "max_tokens", "context_window"];

interface UsageSample {
    event: ObservatoryEvent;
    fraction: number;
    used: number;
    limit: number;
}

function usage(e: ObservatoryEvent): UsageSample | null {
    const used = num(e, ...USED_KEYS);
    const limit = num(e, ...LIMIT_KEYS);
    if (used === null || limit === null || limit <= 0) {
        return null;
    }
    return { event: e, fraction: used / limit, used, limit };
}

/**
 * Token/context budget pressure.
 *
 * - `guard.budget_pressure` events are restated as producer-reported findings.
 * - Events carrying both a used-token and limit-token attribute form a usage
 *   series per scope (context_id > request_id > agent_id > session); each
 *   contiguous run at or above `budget.warnFraction` is one finding.
 */
export const detectBudgetPressure: Detector = (events, config) => {
    const { warnFraction, criticalFraction } = config.budget;
    const findings: Finding[] = [];

    for (const e of events) {
        if (e.event_type !== "guard.budget_pressure") {
            continue;
        }
        const fraction = num(e, "used_fraction", "fraction");
        const budget = str(e, "budget") ?? "unspecified";
        const severity = fraction === null ? "warning" : (severityFor(fraction, warnFraction, criticalFraction) ?? "info");
        const facts: Record<string, number | string> = { budget };
        if (fraction !== null) {
            facts.used_fraction = fraction;
        }
        findings.push(
            makeFinding(
                "budget-pressure",
                severity,
                [e],
                `Producer guard reported ${budget} budget pressure${fraction === null ? "" : ` at ${pct(fraction)} used`}.`,
                facts,
                "producer-reported",
            ),
        );
    }

    const samples: UsageSample[] = [];
    for (const e of events) {
        if (e.event_type.startsWith("guard.")) {
            continue;
        }
        const s = usage(e);
        if (s) {
            samples.push(s);
        }
    }
    for (const [scope, series] of groupBy(samples, (s) => scopeKey(s.event))) {
        for (const ep of episodes(series, (s) => s.fraction >= warnFraction)) {
            const peak = ep.reduce((a, b) => (b.fraction > a.fraction ? b : a));
            const severity = severityFor(peak.fraction, warnFraction, criticalFraction) ?? "warning";
            findings.push(
                makeFinding(
                    "budget-pressure",
                    severity,
                    ep.map((s) => s.event),
                    `Context usage stayed at or above ${pct(warnFraction)} for ${ep.length} sample(s) in ${scope}; peak ${peak.used}/${peak.limit} tokens (${pct(peak.fraction)}).`,
                    {
                        scope,
                        samples: ep.length,
                        peak_used_tokens: peak.used,
                        limit_tokens: peak.limit,
                        peak_fraction: peak.fraction,
                    },
                ),
            );
        }
    }
    return findings;
};
