import type { ObservatoryEvent } from "../../protocol/events";
import type { Detector, Finding } from "../types";
import { findBursts, groupBy, makeFinding, ms, num } from "../util";
import { scopeKey } from "./shared";

/**
 * Compaction events.
 *
 * - Each `context.compaction.completed` is paired with the latest unmatched
 *   `context.compaction.started` in the same scope and reported as an info
 *   finding with duration and token reduction when the producer reports it.
 * - A started compaction with no completion in the stream, or a
 *   `context.compaction.failed`, is a warning.
 * - `compaction.churnCount` completions within `compaction.windowMs` in one
 *   scope is a churn warning.
 */
export const detectCompaction: Detector = (events, config) => {
    const findings: Finding[] = [];
    const relevant = events.filter((e) => e.event_type.startsWith("context.compaction."));
    for (const [scope, list] of groupBy(relevant, scopeKey)) {
        const open: ObservatoryEvent[] = [];
        const completed: ObservatoryEvent[] = [];
        for (const e of list) {
            if (e.event_type === "context.compaction.started") {
                open.push(e);
            } else if (e.event_type === "context.compaction.completed") {
                const start = open.pop();
                completed.push(e);
                const before = num(e, "tokens_before", "before_tokens") ?? (start ? num(start, "tokens_before", "before_tokens") : null);
                const after = num(e, "tokens_after", "after_tokens");
                const facts: Record<string, number | string> = { scope };
                let detail = "";
                if (start) {
                    facts.duration_ms = ms(e.mono_ns - start.mono_ns);
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
                const start = open.pop();
                findings.push(
                    makeFinding("compaction", "warning", start ? [start, e] : [e], `Context compaction failed in ${scope}.`, { scope }),
                );
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
        for (const burst of findBursts(completed, config.compaction.churnCount, config.compaction.windowMs)) {
            findings.push(
                makeFinding(
                    "compaction",
                    "warning",
                    burst,
                    `${burst.length} compactions completed in ${scope} within ${ms(burst[burst.length - 1]!.mono_ns - burst[0]!.mono_ns)} ms (threshold ${config.compaction.churnCount} per ${config.compaction.windowMs} ms).`,
                    { scope, compactions: burst.length },
                    "derived",
                    `churn:${burst[0]!.event_id}`,
                ),
            );
        }
    }
    return findings;
};
