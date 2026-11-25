import type { ObservatoryEvent } from "../../protocol/events";
import { createIdentityKeys } from "../../query/identity";
import type { Detector, Finding } from "../types";
import { groupBy, makeFinding, str } from "../util";

const REDACTED = /^\s*(?:\[redacted(?:[:\s][^\]]*)?\]|<redacted(?:[:\s][^>]*)?>|redacted|\*+)\s*$/i;

function toolNameOf(e: ObservatoryEvent): string {
    return str(e, "tool", "tool_name") ?? "?";
}

function unredactedStr(e: ObservatoryEvent, ...keys: string[]): string | null {
    const value = str(e, ...keys);
    if (!value || value.trim().length === 0 || REDACTED.test(value)) {
        return null;
    }
    return value;
}

/**
 * Identity of a tool call's input. Only producer-supplied hashes or
 * unredacted argument strings count; redacted/absent inputs are unknown and
 * never treated as identical (no speculative loop claims).
 */
export function callSignature(e: ObservatoryEvent): string | null {
    const tool = toolNameOf(e);
    const hash = unredactedStr(e, "args_hash", "input_hash", "content_hash");
    if (hash) {
        return `${tool}|${hash}`;
    }
    const args = e.attributes.args;
    if (typeof args === "string" && args.trim().length > 0 && !REDACTED.test(args)) {
        return `${tool}|args:${args}`;
    }
    return null;
}

function outputSignature(e: ObservatoryEvent): string | null {
    const hash = unredactedStr(e, "output_hash", "result_hash");
    return hash ? `${toolNameOf(e)}|${hash}` : null;
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
 * - Per stream/session/actor (agent > request > session), `noProgress.repeatCount`
 *   or more consecutive `tool.called` events with the same tool and input
 *   signature (args_hash / input_hash / content_hash, or unredacted args) form
 *   a loop. Matching completions (by tool_call_id) are cited as evidence too.
 * - Likewise for consecutive `tool.completed` events with the same
 *   output_hash / result_hash.
 */
export const detectNoProgress: Detector = (events, config) => {
    const rawMin = config.noProgress.repeatCount;
    const findings: Finding[] = [];
    const idKeys = createIdentityKeys();

    for (const e of events) {
        if (e.event_type === "guard.no_progress") {
            findings.push(
                makeFinding("no-progress-loop", "warning", [e], `Producer guard reported no progress${e.agent_id ? ` for ${e.agent_id}` : ""}.`, {}, "producer-reported"),
            );
        }
    }

    if (!Number.isFinite(rawMin) || rawMin < 1) {
        return findings;
    }
    const min = Math.ceil(rawMin);

    const outcomes = new Map<string, ObservatoryEvent[]>();
    const calls: ObservatoryEvent[] = [];
    const completions: ObservatoryEvent[] = [];
    for (const e of events) {
        const t = e.event_type;
        if (t === "tool.called") {
            calls.push(e);
        } else if (t === "tool.completed" || t === "tool.failed") {
            if (t === "tool.completed") {
                completions.push(e);
            }
            const id = str(e, "tool_call_id");
            if (id) {
                const outcomeKey = `${idKeys.stream(e)}\0${e.session_id}\0${id}`;
                let list = outcomes.get(outcomeKey);
                if (!list) {
                    list = [];
                    outcomes.set(outcomeKey, list);
                }
                list.push(e);
            }
        }
    }

    for (const [, list] of groupBy(calls, (e) => `${idKeys.stream(e)}\0${e.session_id}\0${actorKey(e)}`)) {
        const actor = actorKey(list[0]!);
        for (const run of runs(list, callSignature, min)) {
            const evidence = [...run.events];
            const attached = new Set<string>();
            for (const c of run.events) {
                const id = str(c, "tool_call_id");
                if (id) {
                    const outcomeKey = `${idKeys.stream(c)}\0${c.session_id}\0${id}`;
                    if (!attached.has(outcomeKey)) {
                        attached.add(outcomeKey);
                        const matched = outcomes.get(outcomeKey);
                        if (matched) {
                            evidence.push(...matched);
                        }
                    }
                }
            }
            const tool = toolNameOf(run.events[0]!);
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

    for (const [, list] of groupBy(completions, (e) => `${idKeys.stream(e)}\0${e.session_id}\0${actorKey(e)}`)) {
        const actor = actorKey(list[0]!);
        for (const run of runs(list, outputSignature, min)) {
            const tool = toolNameOf(run.events[0]!);
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
