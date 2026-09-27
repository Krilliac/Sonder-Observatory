/**
 * Aligns the units (runs, requests or turns) of two sessions.
 *
 * - By id: when both sessions report keys for the mode and at least one key
 *   is shared, units with equal keys are paired; the rest are one-sided
 *   (only in A = removed, only in B = added).
 * - By position: otherwise (different run/request ids between recordings,
 *   or turn order inferred from request start order), the n-th unit of A is
 *   paired with the n-th unit of B.
 */
import type { AlignMode, UnitGroup, UnitStats } from "./summary";

export type MatchedBy = "id" | "position";

export interface AlignedPair {
    /** Display key: the shared key, or "A-key ↔ B-key" when paired by position. */
    label: string;
    a: UnitStats | null;
    b: UnitStats | null;
    status: "matched" | "only-a" | "only-b";
}

export interface Alignment {
    mode: AlignMode;
    matchedBy: MatchedBy;
    pairs: AlignedPair[];
    /** True when either side's keys were inferred (turn order from request order). */
    inferred: boolean;
}

function pairOf(a: UnitStats | null, b: UnitStats | null): AlignedPair {
    const label = a && b ? (a.key === b.key ? a.label : `${a.label} ↔ ${b.label}`) : (a ?? b)!.label;
    return { label, a, b, status: a && b ? "matched" : a ? "only-a" : "only-b" };
}

export function alignUnits(a: UnitGroup, b: UnitGroup): Alignment {
    const mode = a.mode;
    const inferred = a.keySource === "inferred" || b.keySource === "inferred";
    const bKeys = new Map(b.units.map((u) => [u.key, u]));
    const shared = a.units.some((u) => bKeys.has(u.key));
    if (!inferred && shared) {
        const aKeys = new Set(a.units.map((u) => u.key));
        const pairs: { order: number; pair: AlignedPair }[] = a.units.map((u, i) => ({ order: i, pair: pairOf(u, bKeys.get(u.key) ?? null) }));
        // B-only units go right after the last A unit that precedes them in B's order.
        let anchor = -1;
        b.units.forEach((u, j) => {
            if (aKeys.has(u.key)) {
                anchor = a.units.findIndex((x) => x.key === u.key);
            } else {
                pairs.push({ order: anchor + 0.5 + j / (b.units.length + 1) / 2, pair: pairOf(null, u) });
            }
        });
        pairs.sort((x, y) => x.order - y.order);
        return { mode, matchedBy: "id", pairs: pairs.map((p) => p.pair), inferred };
    }
    const n = Math.max(a.units.length, b.units.length);
    const pairs: AlignedPair[] = [];
    for (let i = 0; i < n; i += 1) {
        pairs.push(pairOf(a.units[i] ?? null, b.units[i] ?? null));
    }
    return { mode, matchedBy: "position", pairs, inferred };
}
