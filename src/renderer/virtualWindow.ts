/**
 * Pure helpers for the virtualized (windowed) event table.
 *
 * `computeWindow` maps a scroll position to the slice of rows to put in the
 * DOM. Browsers cap element heights (about 17.8M px in Firefox, 33.5M px in
 * Chromium), so beyond `maxScrollHeight` the scroll range is compressed and
 * mapped proportionally onto the rows; 1M rows stay reachable.
 *
 * `FilteredRows` keeps the filtered row set as positions into the session's
 * events array. It is recomputed only when the events array or the filter
 * changes (and narrows the previous result when the filter text grows), so
 * scrubbing costs a binary search instead of a full filter pass.
 */
import type { ObservatoryEvent } from "../protocol/events";
import type { EventClass } from "../query/classify";
import { getEventIndex, TRACKS } from "./timelineModel";

export const MAX_SCROLL_HEIGHT = 8_000_000;

export interface WindowInput {
    scrollTop: number;
    viewportHeight: number;
    rowHeight: number;
    rowCount: number;
    overscan?: number;
    maxScrollHeight?: number;
}

export interface RowWindow {
    /** First row index to render (inclusive). */
    start: number;
    /** Last row index to render (exclusive). */
    end: number;
    /** Spacer height before the first rendered row. */
    padTop: number;
    /** Spacer height after the last rendered row. */
    padBottom: number;
    /** Total scrollable content height used for the rows. */
    totalHeight: number;
    /** True when the scroll range is compressed (very large row counts). */
    scaled: boolean;
}

export function computeWindow(input: WindowInput): RowWindow {
    const rowH = Math.max(1, input.rowHeight);
    const rows = Math.max(0, Math.floor(input.rowCount));
    const vh = Math.max(0, input.viewportHeight);
    const overscan = Math.max(0, Math.floor(input.overscan ?? 8));
    const maxH = Math.max(vh + rowH, input.maxScrollHeight ?? MAX_SCROLL_HEIGHT);
    const natural = rows * rowH;
    if (rows === 0) {
        return { start: 0, end: 0, padTop: 0, padBottom: 0, totalHeight: 0, scaled: false };
    }
    const visibleRows = Math.ceil(vh / rowH) + 1;
    if (natural <= maxH) {
        const top = Math.min(Math.max(0, input.scrollTop), Math.max(0, natural - vh));
        const first = Math.floor(top / rowH);
        const start = Math.max(0, first - overscan);
        const end = Math.min(rows, first + visibleRows + overscan);
        return { start, end, padTop: start * rowH, padBottom: (rows - end) * rowH, totalHeight: natural, scaled: false };
    }
    // Compressed: map scrollTop in [0, maxH - vh] onto virtual offsets in [0, natural - vh].
    const scrollRange = maxH - vh;
    const top = Math.min(Math.max(0, input.scrollTop), scrollRange);
    const virtualTop = (top / scrollRange) * (natural - vh);
    const first = Math.min(rows - 1, Math.floor(virtualTop / rowH));
    const start = Math.max(0, first - overscan);
    const end = Math.min(rows, first + visibleRows + overscan);
    // Place row `first` so that it appears at the same viewport offset it would have unscaled.
    const offsetInFirst = virtualTop - first * rowH;
    const padTop = Math.max(0, top - offsetInFirst - (first - start) * rowH);
    const padBottom = Math.max(0, maxH - padTop - (end - start) * rowH);
    return { start, end, padTop, padBottom, totalHeight: maxH, scaled: true };
}

/**
 * scrollTop that brings `row` into view, top-aligned or centred in the
 * viewport (clamped to the scroll range). Inverse of computeWindow.
 */
export function scrollTopForRow(row: number, input: Omit<WindowInput, "scrollTop">, align: "start" | "center" = "start"): number {
    const rowH = Math.max(1, input.rowHeight);
    const rows = Math.max(0, Math.floor(input.rowCount));
    const vh = Math.max(0, input.viewportHeight);
    const maxH = Math.max(vh + rowH, input.maxScrollHeight ?? MAX_SCROLL_HEIGHT);
    const natural = rows * rowH;
    const rowTop = Math.min(Math.max(0, row), Math.max(0, rows - 1)) * rowH;
    const wanted = align === "center" ? rowTop - (vh - rowH) / 2 : rowTop;
    const virtualTop = Math.min(Math.max(0, wanted), Math.max(0, natural - vh));
    if (natural <= maxH) {
        return virtualTop;
    }
    return (virtualTop / (natural - vh)) * (maxH - vh);
}

export interface RowFilter {
    cls: EventClass | "all";
    /** Lower-case substring; empty means no text filter. */
    text: string;
}

function haystack(e: ObservatoryEvent): string {
    return `${e.event_type} ${e.event_id} ${e.request_id ?? ""} ${e.agent_id ?? ""}`.toLowerCase();
}

export class FilteredRows {
    private events: readonly ObservatoryEvent[] | null = null;
    private filter: RowFilter = { cls: "all", text: "" };
    private positions: Uint32Array = new Uint32Array(0);
    private all = true;
    recomputes = 0;

    /** Updates the cached row set for `events` and `filter`; returns row count. */
    update(events: readonly ObservatoryEvent[], filter: RowFilter): number {
        if (this.events === events && this.filter.cls === filter.cls && this.filter.text === filter.text) {
            return this.length;
        }
        const narrowing =
            this.events === events &&
            this.filter.cls === filter.cls &&
            this.filter.text !== "" &&
            filter.text.includes(this.filter.text);
        this.recomputes += 1;
        if (filter.cls === "all" && filter.text === "") {
            this.all = true;
            this.positions = new Uint32Array(0);
        } else {
            const index = getEventIndex(events);
            const want = filter.cls === "all" ? -1 : TRACKS.indexOf(filter.cls);
            const out = new Uint32Array(narrowing && !this.all ? this.positions.length : events.length);
            let n = 0;
            const test = (i: number) =>
                (want < 0 || index.cls[i] === want) && (filter.text === "" || haystack(events[i]!).includes(filter.text));
            if (narrowing && !this.all) {
                for (const i of this.positions) {
                    if (test(i)) {
                        out[n++] = i;
                    }
                }
            } else {
                for (let i = 0; i < events.length; i += 1) {
                    if (test(i)) {
                        out[n++] = i;
                    }
                }
            }
            this.all = false;
            this.positions = out.slice(0, n);
        }
        this.events = events;
        this.filter = { ...filter };
        return this.length;
    }

    get length(): number {
        return this.all ? (this.events?.length ?? 0) : this.positions.length;
    }

    /** Position in the events array of filtered row `row`. */
    positionOf(row: number): number {
        return this.all ? row : (this.positions[row] ?? -1);
    }

    /** Number of filtered rows whose event position is < `visibleCount` (binary search). */
    countBefore(visibleCount: number): number {
        if (this.all) {
            return Math.min(visibleCount, this.length);
        }
        let lo = 0;
        let hi = this.positions.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (this.positions[mid]! < visibleCount) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo;
    }

    /** Filtered row index for an event position, or -1 if filtered out. */
    rowOfPosition(position: number): number {
        if (position < 0) {
            return -1;
        }
        if (this.all) {
            return position < this.length ? position : -1;
        }
        const row = this.countBefore(position);
        return this.positions[row] === position ? row : -1;
    }
}
