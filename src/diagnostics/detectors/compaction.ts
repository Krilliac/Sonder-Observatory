import type { ObservatoryEvent } from "../../protocol/events";
import { createIdentityKeys } from "../../query/identity";
import type { Detector, Finding } from "../types";
import { groupBy, makeFinding, num, str } from "../util";
import { findBurstsLinear, nonNegDurationMs, safeSpanMs, scopeKey } from "./shared";

function popMatchingStart(open: ObservatoryEvent[], event: ObservatoryEvent): ObservatoryEvent | undefined {
    const cid = str(event, "compaction_id");
    if (cid) {
        for (let i = open.length - 1; i >= 0; i -= 1) {
            if (str(open[i]!, "compaction_id") === cid) {
                return open.splice(i, 1)[0];
            }
        }
    }
    return open.pop();
}

/**
 * Compaction events.
 *
 * - Each `context.compaction.completed` is paired with the matching (by
 *   `compaction_id`, else latest unmatched) `context.compaction.started` in
 *   the same producer stream and scope, reported as an info finding with
 *   non-negative duration and token reduction when reported.
 * - A started compaction with no completion/cancellation in the stream, or a
 *   `context.compaction.failed`, is a warning.
 * - `compaction.churnCount` completions within `compaction.windowMs` in one
 *   scope is a churn warning.
 */
export const detectCompaction: Detector = (events, config) => {
    const findings: Finding[] = [];
    const relevant = events.filter((e) => e.event_type.startsWith("context.compaction."));
    if (relevant.length === 0) {
        return findings;
    }
    const idKeys = createIdentityKeys();
    for (const [, list] of groupBy(relevant, (e) => `${idKeys.stream(e)}\0${scopeKey(e)}`)) {
        const scope = scopeKey(list[0]!);
        const open: ObservatoryEvent[] = [];
        const completed: ObservatoryEvent[] = [];
        for (const e of list) {
            if (e.event_type === "context.compaction.started") {
                open.push(e);
            } else if (e.event_type === "context.compaction.completed") {
                const start = popMatchingStart(open, e);
                completed.push(e);
                const rawBefore = num(e, "tokens_before", "before_tokens") ?? (start ? num(start, "tokens_before", "before_tokens") : null);
                const rawAfter = num(e, "tokens_after", "after_tokens");
                const before = rawBefore !== null && rawBefore >= 0 ? rawBefore : null;
                const after = rawAfter !== null && rawAfter >= 0 ? rawAfter : null;
                const facts: Record<string, number | string> = { scope };
                let detail = "";
                const measuredMs = start ? nonNegDurationMs(start.mono_ns, e.mono_ns) : null;
                const reportedMs = num(e, "duration_ms");
                const durationMs = measuredMs ?? (reportedMs !== null && reportedMs >= 0 ? Math.round(reportedMs) : null);
                if (durationMs !== null) {
                    facts.duration_ms = durationMs;
                    detail += ` in ${facts.duration_ms} ms`;
                }
                if (before !== null && after !== null) {
                    facts.tokens_before = before;
                    facts.tokens_after = after;
                    detail += `; ${before} -> ${after} tokens`;
                }
                findings.push(
                    makeFinding("compaction", "info", start ? [start, e] : [e], `Context compaction completed in ${scope}${detail}.`, facts),
                );
            } else if (e.event_type === "context.compaction.failed") {
                const start = popMatchingStart(open, e);
                findings.push(
                    makeFinding("compaction", "warning", start ? [start, e] : [e], `Context compaction failed in ${scope}.`, { scope }),
                );
            } else if (e.event_type === "context.compaction.cancelled" || e.event_type === "context.compaction.aborted") {
                popMatchingStart(open, e);
            }
        }
        for (const start of open) {
            findings.push(
                makeFinding(
                    "compaction",
                    "warning",
                    [start],
                    `Context compaction started in ${scope} with no completion observed in this stream.`,
                    { scope },
                ),
            );
        }
        for (const burst of findBurstsLinear(completed, config.compaction.churnCount, config.compaction.windowMs)) {
            const span = safeSpanMs(burst[0]!.mono_ns, burst[burst.length - 1]!.mono_ns);
            findings.push(
                makeFinding(
                    "compaction",
                    "warning",
                    burst,
                    `${burst.length} compactions completed in ${scope} within ${span} ms (threshold ${config.compaction.churnCount} per ${config.compaction.windowMs} ms).`,
                    { scope, compactions: burst.length },
                    "derived",
                    `churn:${burst[0]!.event_id}`,
                ),
            );
        }
    }
    return findings;
};
