import type { ObservatoryEvent } from "../../protocol/events";
import type { Detector, Finding } from "../types";
import { groupBy, makeFinding, str } from "../util";

const REDACTED = /^\s*(\[?redacted\]?|\*+|<redacted>)\s*$/i;

/**
 * Identity of a tool call's input. Only producer-supplied hashes or
 * unredacted argument strings count; redacted/absent inputs are unknown and
 * never treated as identical (no speculative loop claims).
 */
export function callSignature(e: ObservatoryEvent): string | null {
    const tool = str(e, "tool", "tool_name") ?? "?";
    const hash = str(e, "args_hash", "input_hash", "content_hash");
    if (hash) {
        return `${tool}|${hash}`;
    }
    const args = e.attributes.args;
    if (typeof args === "string" && args.length > 0 && !REDACTED.test(args)) {
        return `${tool}|args:${args}`;
    }
    return null;
}

function outputSignature(e: ObservatoryEvent): string | null {
    const hash = str(e, "output_hash", "result_hash");
    return hash ? `${str(e, "tool", "tool_name") ?? "?"}|${hash}` : null;
}

function actorKey(e: ObservatoryEvent): string {
    return e.agent_id ? `agent:${e.agent_id}` : e.request_id ? `request:${e.request_id}` : `session:${e.session_id}`;
}

/** Consecutive runs of equal non-null signatures; null breaks a run. */
function runs(list: readonly ObservatoryEvent[], sig: (e: ObservatoryEvent) => string | null, min: number): { sig: string; events: ObservatoryEvent[] }[] {
    const out: { sig: string; events: ObservatoryEvent[] }[] = [];
    let cur: ObservatoryEvent[] = [];
    let curSig: string | null = null;
    const flush = () => {
        if (curSig !== null && cur.length >= min) {
            out.push({ sig: curSig, events: cur });
        }
    };
    for (const e of list) {
        const s = sig(e);
        if (s !== null && s === curSig) {
            cur.push(e);
        } else {
            flush();
            cur = s === null ? [] : [e];
            curSig = s;
        }
    }
    flush();
    return out;
}

/**
 * No-progress loops.
 *
 * - `guard.no_progress` events are restated as producer-reported findings.
 * - Per actor (agent > request > session), `noProgress.repeatCount` or more
 *   consecutive `tool.called` events with the same tool and input signature
 *   (args_hash / input_hash / content_hash, or unredacted args) form a loop.
 *   Matching completions (by tool_call_id) are cited as evidence too.
 * - Likewise for consecutive `tool.completed` events with the same
 *   output_hash / result_hash.
 */
export const detectNoProgress: Detector = (events, config) => {
    const min = config.noProgress.repeatCount;
    const findings: Finding[] = [];

    for (const e of events) {
        if (e.event_type === "guard.no_progress") {
            findings.push(
                makeFinding("no-progress-loop", "warning", [e], `Producer guard reported no progress${e.agent_id ? ` for ${e.agent_id}` : ""}.`, {}, "producer-reported"),
            );
        }
    }

    const outcomes = new Map<string, ObservatoryEvent[]>();
    for (const e of events) {
        if (e.event_type === "tool.completed" || e.event_type === "tool.failed") {
            const id = str(e, "tool_call_id");
            if (id) {
                outcomes.set(id, [...(outcomes.get(id) ?? []), e]);
            }
        }
    }

    const calls = events.filter((e) => e.event_type === "tool.called");
    for (const [actor, list] of groupBy(calls, actorKey)) {
        for (const run of runs(list, callSignature, min)) {
            const evidence = [...run.events];
            for (const c of run.events) {
                const id = str(c, "tool_call_id");
                if (id) {
                    evidence.push(...(outcomes.get(id) ?? []));
                }
            }
            const tool = run.sig.split("|")[0]!;
            findings.push(
                makeFinding(
                    "no-progress-loop",
                    run.events.length >= min * 2 ? "critical" : "warning",
                    evidence,
                    `${actor} called ${tool} ${run.events.length} times consecutively with identical input.`,
                    { actor, tool, repeats: run.events.length },
                    "derived",
                    `calls:${run.events[0]!.event_id}`,
                ),
            );
        }
    }

    const completions = events.filter((e) => e.event_type === "tool.completed");
    for (const [actor, list] of groupBy(completions, actorKey)) {
        for (const run of runs(list, outputSignature, min)) {
            const tool = run.sig.split("|")[0]!;
            findings.push(
                makeFinding(
                    "no-progress-loop",
                    run.events.length >= min * 2 ? "critical" : "warning",
                    run.events,
                    `${actor} received identical ${tool} output ${run.events.length} times consecutively.`,
                    { actor, tool, repeats: run.events.length },
                    "derived",
                    `outputs:${run.events[0]!.event_id}`,
                ),
            );
        }
    }
    return findings;
};
