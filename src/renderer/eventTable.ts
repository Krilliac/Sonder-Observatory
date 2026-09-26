/**
 * Virtualized event table. Only the rows inside the scroll viewport (plus a
 * small overscan) are in the DOM, so the table can show every event at the
 * cursor instead of the latest 400. Scrolling repaints just the window; it
 * does not re-render the rest of the app.
 *
 * Row elements are keyed by event position and reused across paints: a row
 * that stays in the window keeps its element and only its changed attributes
 * are touched. Live ingest renders many times per second, and a mouse click
 * only lands when press and release hit the same element; the row pressed is
 * also remembered, so a click whose release lands after the window moved
 * still selects the row the press started on.
 */
import type { ObservatoryEvent } from "../protocol/events";
import type { EventClass } from "../query/classify";
import { h } from "./dom";
import "./eventTable.css";
import { fmtRelNs, summarizeAttributes } from "./format";
import { eventPosition, getEventIndex, TRACKS } from "./timelineModel";
import { computeWindow, FilteredRows, scrollTopForRow, type RowWindow } from "./virtualWindow";

const COLUMNS = ["seq", "t", "event type", "class", "producer", "request", "agent", "attributes"] as const;
const DEFAULT_ROW_HEIGHT = 22;

export interface EventTableState {
    events: readonly ObservatoryEvent[];
    /** Events at or before the replay cursor (prefix length of `events`). */
    visibleCount: number;
    filterClass: EventClass | "all";
    filterText: string;
    selectedId: string | null;
    highlighted: ReadonlySet<string>;
    follow: boolean;
    originNs: number;
}

export interface EventTableCounts {
    shown: number;
    atCursor: number;
}

export class EventTable {
    private readonly rows = new FilteredRows();
    private readonly table: HTMLTableElement;
    private readonly body: HTMLTableSectionElement;
    private readonly head: HTMLTableSectionElement;
    private readonly headRow: HTMLTableRowElement;
    private readonly topSpacer: HTMLTableCellElement;
    private readonly bottomSpacer: HTMLTableCellElement;
    private state: EventTableState | null = null;
    private rowCount = 0;
    private rowHeight = DEFAULT_ROW_HEIGHT;
    private measured = false;
    private lastSelected: string | null = null;
    private scrollQueued = false;
    private lastWindow: RowWindow | null = null;
    /** Painted rows by event position (see paint()). */
    private painted = new Map<number, { tr: HTMLTableRowElement; event: ObservatoryEvent; stamp: string }>();
    /** Row under the last primary-button press, for a click whose release landed elsewhere. */
    private pressed: HTMLTableRowElement | null = null;

    constructor(
        private readonly wrap: HTMLElement,
        private readonly onSelect: (event: ObservatoryEvent) => void,
    ) {
        this.body = h("tbody");
        // Spacers live in thead/tfoot so `tbody tr` is exactly the rendered event rows.
        this.headRow = h("tr", {}, ...COLUMNS.map((c) => h("th", { scope: "col", text: c })));
        this.topSpacer = h("td", { colspan: COLUMNS.length });
        this.bottomSpacer = h("td", { colspan: COLUMNS.length });
        this.head = h("thead", {}, this.headRow, h("tr", { class: "spacer", "aria-hidden": "true" }, this.topSpacer));
        this.table = h(
            "table",
            { class: "events virtual" },
            h("colgroup", {}, ...COLUMNS.map((_, i) => h("col", { class: `col-${i}` }))),
            this.head,
            this.body,
            h("tfoot", {}, h("tr", { class: "spacer", "aria-hidden": "true" }, this.bottomSpacer)),
        );
        wrap.replaceChildren(this.table);
        wrap.addEventListener("scroll", () => this.queueWindow());
        this.body.addEventListener("pointerdown", (ev) => {
            this.pressed = ev.button === 0 ? (ev.target as Element).closest<HTMLTableRowElement>("tr.row") : null;
        });
        this.body.addEventListener("click", (ev) => {
            const pressed = this.pressed;
            this.pressed = null;
            // A click fires on the common ancestor when press and release hit
            // different rows (the window moved in between): use the pressed row.
            const tr = (ev.target as Element).closest<HTMLTableRowElement>("tr.row") ?? (pressed?.isConnected ? pressed : null);
            const pos = tr ? Number(tr.dataset.pos) : NaN;
            const event = Number.isInteger(pos) ? this.state?.events[pos] : undefined;
            if (event) {
                this.onSelect(event);
            }
        });
    }

    update(state: EventTableState): EventTableCounts {
        const wasAtBottom = this.wrap.scrollTop + this.wrap.clientHeight >= this.wrap.scrollHeight - 4;
        this.state = state;
        this.rows.update(state.events, { cls: state.filterClass, text: state.filterText });
        this.rowCount = this.rows.countBefore(state.visibleCount);
        const selectionChanged = state.selectedId !== this.lastSelected;
        this.lastSelected = state.selectedId;
        this.paint();
        if (state.follow || (wasAtBottom && !selectionChanged)) {
            this.wrap.scrollTop = this.wrap.scrollHeight;
            this.paint();
        } else if (selectionChanged && state.selectedId) {
            this.revealSelected();
        }
        return { shown: this.rowCount, atCursor: state.visibleCount };
    }

    /**
     * Scrolls the selection (or, when following, the latest row) into view.
     * Called when the table becomes visible again: while hidden it cannot
     * measure its viewport.
     */
    revealSelection(): void {
        if (!this.state) {
            return;
        }
        this.paint();
        if (this.state.follow) {
            this.wrap.scrollTop = this.wrap.scrollHeight;
            this.paint();
        } else {
            this.revealSelected();
        }
    }

    /**
     * Event `delta` rows away from the selection among every filtered row,
     * including rows after the replay cursor (J/K and timeline stepping move
     * the cursor to it). With no selection it starts at the cursor.
     */
    step(selectedId: string | null, delta: number): ObservatoryEvent | undefined {
        const s = this.state;
        const total = this.rows.length;
        if (!s || total === 0) {
            return undefined;
        }
        const pos = selectedId ? eventPosition(getEventIndex(s.events), selectedId) : -1;
        const row = pos >= 0 ? this.rows.rowOfPosition(pos) : -1;
        // No (visible) selection: start with the row at the replay cursor.
        const next = row < 0 ? Math.max(this.rowCount - 1, 0) : row + delta;
        if (next < 0 || next >= total) {
            return undefined;
        }
        return s.events[this.rows.positionOf(next)];
    }

    /** Event `delta` rows away from the selection (keyboard navigation). */
    neighbor(selectedId: string | null, delta: number): ObservatoryEvent | undefined {
        const s = this.state;
        if (!s || this.rowCount === 0) {
            return undefined;
        }
        const row = this.rowOfId(selectedId);
        const next = row < 0 ? this.rowCount - 1 : Math.min(Math.max(row + delta, 0), this.rowCount - 1);
        return s.events[this.rows.positionOf(next)];
    }

    private rowOfId(id: string | null): number {
        const s = this.state;
        if (!s || !id) {
            return -1;
        }
        // The selection is normally on screen: check the painted window first.
        const w = this.lastWindow;
        if (w) {
            for (let r = w.start; r < w.end; r += 1) {
                if (s.events[this.rows.positionOf(r)]?.event_id === id) {
                    return r;
                }
            }
        }
        const pos = eventPosition(getEventIndex(s.events), id);
        const row = this.rows.rowOfPosition(pos);
        return row < this.rowCount ? row : -1;
    }

    private revealSelected(): void {
        const row = this.rowOfId(this.state?.selectedId ?? null);
        const w = this.lastWindow;
        if (row < 0 || !w) {
            return;
        }
        const vh = this.viewportHeight();
        const top = this.wrap.scrollTop;
        const inView = computeWindow({ scrollTop: top, viewportHeight: vh, rowHeight: this.rowHeight, rowCount: this.rowCount, overscan: 0 });
        if (row > inView.start && row < inView.end - 2) {
            return;
        }
        this.wrap.scrollTop = scrollTopForRow(row, { viewportHeight: vh, rowHeight: this.rowHeight, rowCount: this.rowCount }, "center");
        this.paint();
    }

    private viewportHeight(): number {
        return Math.max(0, this.wrap.clientHeight - this.headRow.offsetHeight);
    }

    private queueWindow(): void {
        if (this.scrollQueued) {
            return;
        }
        this.scrollQueued = true;
        requestAnimationFrame(() => {
            this.scrollQueued = false;
            this.paint();
        });
    }

    private paint(): void {
        const s = this.state;
        if (!s) {
            return;
        }
        const w = computeWindow({
            scrollTop: this.wrap.scrollTop,
            viewportHeight: this.viewportHeight() || 400,
            rowHeight: this.rowHeight,
            rowCount: this.rowCount,
        });
        this.lastWindow = w;
        const index = getEventIndex(s.events);
        this.topSpacer.style.height = `${w.padTop}px`;
        this.bottomSpacer.style.height = `${w.padBottom}px`;
        const next = new Map<number, { tr: HTMLTableRowElement; event: ObservatoryEvent; stamp: string }>();
        const rows: HTMLTableRowElement[] = [];
        for (let r = w.start; r < w.end; r += 1) {
            const pos = this.rows.positionOf(r);
            const e = s.events[pos];
            if (!e) {
                continue;
            }
            const cls = TRACKS[index.cls[pos]!] ?? "other";
            const selected = e.event_id === s.selectedId;
            const className = `row cls-${cls}${s.highlighted.has(e.event_id) ? " evidence" : ""}${selected ? " selected" : ""}`;
            const stamp = `${className}\u0000${r}\u0000${e.mono_ns - s.originNs}`;
            const prev = this.painted.get(pos);
            let tr: HTMLTableRowElement;
            if (prev && prev.event === e) {
                tr = prev.tr;
                if (prev.stamp !== stamp) {
                    tr.className = className;
                    tr.setAttribute("aria-selected", selected ? "true" : "false");
                    tr.setAttribute("aria-rowindex", String(r + 2));
                    (tr.cells[1] as HTMLTableCellElement).textContent = fmtRelNs(e.mono_ns - s.originNs);
                }
            } else {
                tr = this.renderRow(e, pos, r, cls, className, selected, s.originNs);
            }
            next.set(pos, { tr, event: e, stamp });
            rows.push(tr);
        }
        this.painted = next;
        // Reorder only when the sequence of row elements changed; kept rows are not detached.
        const current = this.body.children;
        let same = current.length === rows.length;
        for (let i = 0; same && i < rows.length; i += 1) {
            same = current[i] === rows[i];
        }
        if (!same) {
            // Drop rows that left the window first, so rows that stay are never moved.
            const keep = new Set<Element>(rows);
            for (const child of [...current]) {
                if (!keep.has(child)) {
                    child.remove();
                }
            }
            let cursor: Element | null = this.body.firstElementChild;
            for (const tr of rows) {
                if (cursor === tr) {
                    cursor = cursor.nextElementSibling;
                } else {
                    this.body.insertBefore(tr, cursor);
                }
            }
        }
        this.table.setAttribute("aria-rowcount", String(this.rowCount + 1));
        if (!this.measured && w.end > w.start) {
            const first = this.body.querySelector<HTMLTableRowElement>("tr.row");
            const measuredH = first?.getBoundingClientRect().height ?? 0;
            if (measuredH > 0) {
                this.measured = true;
                if (Math.abs(measuredH - this.rowHeight) > 0.5) {
                    this.rowHeight = measuredH;
                    this.paint();
                }
            }
        }
    }

    private renderRow(e: ObservatoryEvent, pos: number, r: number, cls: string, className: string, selected: boolean, originNs: number): HTMLTableRowElement {
        return h(
            "tr",
            {
                class: className,
                "aria-selected": selected ? "true" : "false",
                "aria-rowindex": r + 2,
                "data-pos": pos,
                "data-testid": "event-row",
                "data-producer": e.producer.name,
                "data-event-type": e.event_type,
            },
            h("td", { class: "mono", text: e.sequence }),
            h("td", { class: "mono", text: fmtRelNs(e.mono_ns - originNs) }),
            h("td", {}, h("span", { class: `dot cls-${cls}`, "aria-hidden": "true" }), ` ${e.event_type}`),
            h("td", { text: cls }),
            h("td", { class: "producer-cell", text: e.producer.name }),
            h("td", { class: "mono", text: e.request_id ?? "" }),
            h("td", { class: "mono", text: e.agent_id ?? "" }),
            h("td", { class: "muted", text: summarizeAttributes(e.attributes) }),
        );
    }
}
