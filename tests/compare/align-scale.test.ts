import { describe, expect, it } from "vitest";
import { alignUnits } from "../../src/compare/align";
import type { UnitGroup, UnitStats } from "../../src/compare/summary";

function unit(key: string): UnitStats {
    return { key, label: key } as UnitStats;
}

function group(keys: string[]): UnitGroup {
    return { mode: "requests", keySource: "reported", units: keys.map(unit), unattributedEvents: 0 } as UnitGroup;
}

describe("alignUnits at scale", () => {
    it("aligns large sessions with many shared keys without a nested linear search", () => {
        const n = 40_000;
        const a = group(Array.from({ length: n }, (_, i) => `r${i}`));
        // B shares every A key (in reverse, the worst case for a findIndex scan) and adds one of its own.
        const b = group([...Array.from({ length: n }, (_, i) => `r${n - 1 - i}`), "extra"]);
        const started = performance.now();
        const out = alignUnits(a, b);
        const elapsed = performance.now() - started;
        expect(out.matchedBy).toBe("id");
        expect(out.pairs).toHaveLength(n + 1);
        // "extra" follows B's last shared unit, r0, which is first in A.
        expect(out.pairs[1]!.label).toBe("extra");
        expect(elapsed).toBeLessThan(1500);
    });
});
