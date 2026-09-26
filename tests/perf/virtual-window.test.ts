import { describe, expect, it } from "vitest";
import { classifyEvent } from "../../src/query/classify";
import { computeWindow, FilteredRows, scrollTopForRow } from "../../src/renderer/virtualWindow";
import { largeEvents } from "./helpers";

describe("computeWindow", () => {
    it("renders only the viewport plus overscan", () => {
        const w = computeWindow({ scrollTop: 22 * 500, viewportHeight: 440, rowHeight: 22, rowCount: 100_000, overscan: 5 });
        expect(w.start).toBe(495);
        expect(w.end).toBe(500 + 21 + 5);
        expect(w.padTop).toBe(495 * 22);
        expect(w.padTop + (w.end - w.start) * 22 + w.padBottom).toBe(100_000 * 22);
        expect(w.scaled).toBe(false);
    });

    it("clamps at both ends and handles empty tables", () => {
        expect(computeWindow({ scrollTop: -50, viewportHeight: 200, rowHeight: 20, rowCount: 3 })).toMatchObject({ start: 0, end: 3 });
        const end = computeWindow({ scrollTop: 1e12, viewportHeight: 200, rowHeight: 20, rowCount: 1000, overscan: 0 });
        expect(end.end).toBe(1000);
        expect(computeWindow({ scrollTop: 0, viewportHeight: 200, rowHeight: 20, rowCount: 0 })).toMatchObject({ start: 0, end: 0, totalHeight: 0 });
    });

    it("compresses the scroll range for 1M rows and keeps every row reachable", () => {
        const base = { viewportHeight: 500, rowHeight: 22, rowCount: 1_000_000, overscan: 0, maxScrollHeight: 8_000_000 };
        const top = computeWindow({ ...base, scrollTop: 0 });
        expect(top.scaled).toBe(true);
        expect(top.totalHeight).toBe(8_000_000);
        expect(top.start).toBe(0);
        const bottom = computeWindow({ ...base, scrollTop: 8_000_000 });
        expect(bottom.end).toBe(1_000_000);
        for (const row of [0, 1, 12_345, 500_000, 999_999]) {
            const st = scrollTopForRow(row, base);
            const w = computeWindow({ ...base, scrollTop: st });
            expect(row).toBeGreaterThanOrEqual(w.start);
            expect(row).toBeLessThan(w.end);
            expect(w.padTop + (w.end - w.start) * 22 + w.padBottom).toBeCloseTo(8_000_000, 0);
        }
    });

    it("centres a row and keeps the last rows reachable when centring", () => {
        for (const rowCount of [26_006, 1_000_000]) {
            const base = { viewportHeight: 504, rowHeight: 22, rowCount, overscan: 0 };
            for (const row of [0, 10, Math.floor(rowCount / 2), rowCount - 2, rowCount - 1]) {
                const w = computeWindow({ ...base, scrollTop: scrollTopForRow(row, base, "center") });
                expect(row).toBeGreaterThanOrEqual(w.start);
                expect(row).toBeLessThan(w.end);
            }
        }
    });
});

describe("FilteredRows", () => {
    const events = largeEvents(10_000);
    const naive = (cls: string, text: string) =>
        events
            .map((e, i) => [e, i] as const)
            .filter(([e]) => (cls === "all" || classifyEvent(e) === cls) && `${e.event_type} ${e.event_id} ${e.request_id ?? ""} ${e.agent_id ?? ""}`.toLowerCase().includes(text))
            .map(([, i]) => i);

    it("matches the old per-render filter", () => {
        const rows = new FilteredRows();
        for (const [cls, text] of [["all", ""], ["error", ""], ["all", "tool"], ["inference", "req_"], ["resource", "nope"]] as const) {
            rows.update(events, { cls, text });
            const want = naive(cls, text);
            expect(rows.length).toBe(want.length);
            for (let r = 0; r < want.length; r += 37) {
                expect(rows.positionOf(r)).toBe(want[r]);
            }
        }
    });

    it("narrows the previous result when the filter text grows", () => {
        const rows = new FilteredRows();
        rows.update(events, { cls: "all", text: "t" });
        rows.update(events, { cls: "all", text: "to" });
        rows.update(events, { cls: "all", text: "tool" });
        expect(rows.length).toBe(naive("all", "tool").length);
    });

    it("counts rows at the cursor with binary search and maps positions back", () => {
        const rows = new FilteredRows();
        rows.update(events, { cls: "error", text: "" });
        const want = naive("error", "");
        const cut = 6_000;
        expect(rows.countBefore(cut)).toBe(want.filter((i) => i < cut).length);
        expect(rows.rowOfPosition(want[3]!)).toBe(3);
        expect(rows.rowOfPosition(want[3]! + 1 === want[4] ? -1 : want[3]! + 1)).toBe(-1);
        const all = new FilteredRows();
        all.update(events, { cls: "all", text: "" });
        expect(all.countBefore(cut)).toBe(cut);
        const again = all.recomputes;
        all.update(events, { cls: "all", text: "" });
        expect(all.recomputes).toBe(again);
    });
});
