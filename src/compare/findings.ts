/**
 * Diagnostics findings diff between two sessions.
 *
 * Finding ids embed event ids, which differ between recordings, so findings
 * are matched by a cross-session signature instead: the finding kind plus
 * the facts that name *what* is affected (scope, budget, tool, actor...),
 * never times or event ids. Findings with the same signature are paired in
 * start-time order, same-severity pairs first. Unpaired B findings are new; unpaired A findings are
 * resolved; pairs persist (with any severity change).
 *
 * Subject facts per detector: budget-pressure `budget`/`scope`, compaction
 * `scope`, duplicate-worker `task`, no-progress-loop `actor`+`tool`,
 * cache-thrash `scope`, resource-pressure `scope`, model-churn `models`
 * (list), retry-storm `targets` (list), latency-outlier `request_id`.
 * error-burst has no subject (its `breakdown` embeds counts). Subject values
 * that are unit ids (request ids, which differ between recordings) can be
 * mapped onto A's ids with a `SubjectMap` built from the request alignment.
 */
import { SEVERITY_RANK, type Finding } from "../diagnostics";

/** Fact keys that identify the subject of a finding across sessions. */
export const SIGNATURE_FACT_KEYS = ["scope", "budget", "task", "actor", "tool", "models", "targets", "request_id", "kind", "device_id"] as const;

/** Facts whose value is a ", "-joined set; normalised (mapped, deduped, sorted) before signing. */
const LIST_FACT_KEYS: ReadonlySet<string> = new Set(["models", "targets"]);

/** Most list items kept in a signature (bounds its size for very large bursts). */
export const MAX_SIGNATURE_LIST_ITEMS = 32;

/** Maps a B-side subject id (e.g. a request id) to its A-side equivalent. */
export type SubjectMap = (id: string) => string;

const identity: SubjectMap = (id) => id;

export function findingSignature(f: Finding, subject: SubjectMap = identity): string {
    const parts: string[] = [f.kind];
    for (const key of SIGNATURE_FACT_KEYS) {
        const v = f.facts[key];
        if (typeof v !== "string" || v === "") {
            continue;
        }
        if (LIST_FACT_KEYS.has(key)) {
            const items = [...new Set(v.split(",").map((s) => subject(s.trim())).filter((s) => s !== ""))].sort();
            parts.push(`${key}=${items.slice(0, MAX_SIGNATURE_LIST_ITEMS).join(",")}`);
        } else {
            parts.push(`${key}=${key === "request_id" ? subject(v) : v}`);
        }
    }
    return parts.join("|");
}

export interface PersistingFinding {
    signature: string;
    a: Finding;
    b: Finding;
    severityChange: "escalated" | "eased" | null;
}

export interface FindingsDiff {
    /** In B only. */
    added: Finding[];
    /** In A only. */
    resolved: Finding[];
    persisting: PersistingFinding[];
}

function bySignature(findings: readonly Finding[], subject: SubjectMap): Map<string, Finding[]> {
    const map = new Map<string, Finding[]>();
    for (const f of [...findings].sort((x, y) => x.startNs - y.startNs || (x.id < y.id ? -1 : 1))) {
        const sig = findingSignature(f, subject);
        const list = map.get(sig) ?? [];
        list.push(f);
        map.set(sig, list);
    }
    return map;
}

/** `bSubject` maps B's subject ids onto A's (identity by default). */
export function diffFindings(a: readonly Finding[], b: readonly Finding[], bSubject: SubjectMap = identity): FindingsDiff {
    const aMap = bySignature(a, identity);
    const bMap = bySignature(b, bSubject);
    const out: FindingsDiff = { added: [], resolved: [], persisting: [] };
    for (const sig of new Set([...aMap.keys(), ...bMap.keys()])) {
        const as = aMap.get(sig) ?? [];
        const bs = bMap.get(sig) ?? [];
        const usedB = new Set<number>();
        const pairs: [Finding, Finding][] = [];
        const unpairedA: Finding[] = [];
        // Pass 1: same signature and same severity, in start order.
        for (const fa of as) {
            const j = bs.findIndex((fb, k) => !usedB.has(k) && fb.severity === fa.severity);
            if (j >= 0) {
                usedB.add(j);
                pairs.push([fa, bs[j]!]);
            } else {
                unpairedA.push(fa);
            }
        }
        // Pass 2: remaining findings of the signature pair in start order (severity changed).
        for (const fa of unpairedA) {
            const j = bs.findIndex((_fb, k) => !usedB.has(k));
            if (j >= 0) {
                usedB.add(j);
                pairs.push([fa, bs[j]!]);
            } else {
                out.resolved.push(fa);
            }
        }
        bs.forEach((fb, k) => {
            if (!usedB.has(k)) {
                out.added.push(fb);
            }
        });
        for (const [fa, fb] of pairs) {
            const d = SEVERITY_RANK[fb.severity] - SEVERITY_RANK[fa.severity];
            out.persisting.push({ signature: sig, a: fa, b: fb, severityChange: d > 0 ? "escalated" : d < 0 ? "eased" : null });
        }
    }
    const order = (x: Finding, y: Finding) => SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity] || x.startNs - y.startNs;
    out.added.sort(order);
    out.resolved.sort(order);
    out.persisting.sort((x, y) => order(x.b, y.b));
    return out;
}
