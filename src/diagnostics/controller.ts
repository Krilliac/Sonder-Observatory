/**
 * DOM-free state for the findings list. The renderer supplies a
 * DiagnosticsSelectionHost (see INTEGRATION_NOTES.md) so selecting a finding
 * highlights its evidence in the lead's timeline/table and opens the first
 * evidence event in the inspector.
 */
import type { Finding, FindingKind, Severity } from "./types";
import { SEVERITY_RANK } from "./types";

export interface DiagnosticsSelectionHost {
    /** Highlight these event ids in timeline/table; an empty list clears highlighting. */
    highlightEvents(eventIds: readonly string[]): void;
    /** Select one event in the inspector and move the replay cursor to it. */
    selectEvent(eventId: string): void;
}

export interface FindingsFilter {
    minSeverity: Severity;
    /** Empty = all kinds. */
    kinds: readonly FindingKind[];
}

export class FindingsController {
    private findings: Finding[] = [];
    private selectedId: string | null = null;
    filter: FindingsFilter = { minSeverity: "info", kinds: [] };

    constructor(private readonly host: DiagnosticsSelectionHost) {}

    /** Replaces the findings; keeps the selection if the same finding id still exists. */
    setFindings(findings: readonly Finding[]): void {
        this.findings = [...findings];
        if (this.selectedId && !this.findings.some((f) => f.id === this.selectedId)) {
            this.clear();
        }
    }

    visible(): Finding[] {
        const min = SEVERITY_RANK[this.filter.minSeverity];
        const kinds = this.filter.kinds;
        return this.findings.filter((f) => SEVERITY_RANK[f.severity] >= min && (kinds.length === 0 || kinds.includes(f.kind)));
    }

    selected(): Finding | undefined {
        return this.findings.find((f) => f.id === this.selectedId);
    }

    /** Selecting highlights all evidence and inspects the first evidence event. */
    select(findingId: string): void {
        const f = this.findings.find((x) => x.id === findingId);
        if (!f) {
            return;
        }
        this.selectedId = f.id;
        this.host.highlightEvents(f.evidenceEventIds);
        this.host.selectEvent(f.evidenceEventIds[0]!);
    }

    /** Inspect a specific evidence event of the selected finding. */
    inspectEvidence(eventId: string): void {
        const f = this.selected();
        if (f && f.evidenceEventIds.includes(eventId)) {
            this.host.selectEvent(eventId);
        }
    }

    clear(): void {
        this.selectedId = null;
        this.host.highlightEvents([]);
    }

    /** Keyboard navigation over the visible list (+1 / -1). */
    move(delta: 1 | -1): void {
        const list = this.visible();
        if (list.length === 0) {
            return;
        }
        const idx = list.findIndex((f) => f.id === this.selectedId);
        const next = idx < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.min(Math.max(idx + delta, 0), list.length - 1);
        this.select(list[next]!.id);
    }

    counts(): Record<Severity, number> {
        const c: Record<Severity, number> = { info: 0, warning: 0, critical: 0 };
        for (const f of this.findings) {
            c[f.severity] += 1;
        }
        return c;
    }
}
