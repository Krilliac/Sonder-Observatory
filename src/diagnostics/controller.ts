/** DOM-free findings/evidence selection and bounded page state. */
import type { Finding, FindingKind, Severity } from "./types";
import { SEVERITY_RANK } from "./types";

export const FINDINGS_PAGE_SIZE = 50;
export const EVIDENCE_PAGE_SIZE = 50;

export interface DiagnosticsSelectionHost {
    highlightEvents(eventIds: readonly string[]): void;
    selectEvent(eventId: string): void;
}

export interface FindingsFilter {
    minSeverity: Severity;
    /** Empty = all kinds. */
    kinds: readonly FindingKind[];
}

export interface FindingsPage<T> {
    items: readonly T[];
    index: number;
    pages: number;
    total: number;
    /** Zero-based inclusive start and exclusive end. */
    start: number;
    end: number;
}

function page<T>(items: readonly T[], index: number, size: number): FindingsPage<T> {
    const pages = Math.ceil(items.length / size);
    const bounded = Math.max(0, Math.min(index, pages - 1));
    const start = bounded * size;
    const end = Math.min(start + size, items.length);
    return { items: items.slice(start, end), index: bounded, pages, total: items.length, start, end };
}

function validPage(index: number): void {
    if (!Number.isSafeInteger(index) || index < 0) {
        throw new RangeError("page index must be a non-negative safe integer");
    }
}

export class FindingsController {
    private findings: Finding[] = [];
    private byId = new Map<string, Finding>();
    private selectedId: string | null = null;
    private findingPageIndex = 0;
    private evidencePageIndex = 0;
    private version = 0;
    private filtered: Finding[] | null = null;
    private filterKey = "";
    private severityCounts: Record<Severity, number> = { info: 0, warning: 0, critical: 0 };
    filter: FindingsFilter = { minSeverity: "info", kinds: [] };

    constructor(private readonly host: DiagnosticsSelectionHost) {}

    /** Includes page/filter changes so the host can invalidate its DOM cache. */
    get revision(): number {
        this.filteredFindings();
        return this.version;
    }

    setFindings(findings: readonly Finding[]): void {
        this.findings = [...findings];
        this.byId.clear();
        this.severityCounts = { info: 0, warning: 0, critical: 0 };
        for (const finding of this.findings) {
            if (!this.byId.has(finding.id)) {
                this.byId.set(finding.id, finding);
            }
            this.severityCounts[finding.severity] += 1;
        }
        this.filtered = null;
        this.version += 1;
        if (this.selectedId && !this.byId.has(this.selectedId)) {
            this.clear();
        }
        const list = this.filteredFindings();
        const selectedIndex = list.findIndex((finding) => finding.id === this.selectedId);
        this.findingPageIndex = selectedIndex >= 0
            ? Math.floor(selectedIndex / FINDINGS_PAGE_SIZE)
            : page(list, this.findingPageIndex, FINDINGS_PAGE_SIZE).index;
        this.evidencePageIndex = page(this.selected()?.evidenceEventIds ?? [], this.evidencePageIndex, EVIDENCE_PAGE_SIZE).index;
    }

    private filteredFindings(): Finding[] {
        const key = `${this.filter.minSeverity}|${this.filter.kinds.join("|")}`;
        if (key !== this.filterKey) {
            this.filterKey = key;
            this.findingPageIndex = 0;
            this.filtered = null;
            this.version += 1;
        }
        if (!this.filtered) {
            const min = SEVERITY_RANK[this.filter.minSeverity];
            const kinds = this.filter.kinds;
            this.filtered = this.findings.filter((finding) => SEVERITY_RANK[finding.severity] >= min && (kinds.length === 0 || kinds.includes(finding.kind)));
        }
        return this.filtered;
    }

    /** Full filtered list remains available; pages only bound DOM construction. */
    visible(): Finding[] {
        return [...this.filteredFindings()];
    }

    findingsPage(): FindingsPage<Finding> {
        return page(this.filteredFindings(), this.findingPageIndex, FINDINGS_PAGE_SIZE);
    }

    evidencePage(): FindingsPage<string> {
        return page(this.selected()?.evidenceEventIds ?? [], this.evidencePageIndex, EVIDENCE_PAGE_SIZE);
    }

    setFindingsPage(index: number): void {
        validPage(index);
        this.findingPageIndex = page(this.filteredFindings(), index, FINDINGS_PAGE_SIZE).index;
        this.version += 1;
    }

    setEvidencePage(index: number): void {
        validPage(index);
        this.evidencePageIndex = page(this.selected()?.evidenceEventIds ?? [], index, EVIDENCE_PAGE_SIZE).index;
        this.version += 1;
    }

    selected(): Finding | undefined {
        return this.selectedId ? this.byId.get(this.selectedId) : undefined;
    }

    /** Highlights all evidence, including ids outside the mounted page. */
    select(findingId: string): void {
        const finding = this.byId.get(findingId);
        if (!finding) {
            return;
        }
        if (this.selectedId !== finding.id) {
            this.evidencePageIndex = 0;
        }
        this.selectedId = finding.id;
        const index = this.filteredFindings().findIndex((item) => item.id === finding.id);
        if (index >= 0) {
            this.findingPageIndex = Math.floor(index / FINDINGS_PAGE_SIZE);
        }
        this.version += 1;
        this.host.highlightEvents(finding.evidenceEventIds);
        this.host.selectEvent(finding.evidenceEventIds[0]!);
    }

    inspectEvidence(eventId: string): void {
        const finding = this.selected();
        if (finding && finding.evidenceEventIds.includes(eventId)) {
            this.host.selectEvent(eventId);
        }
    }

    clear(): void {
        this.selectedId = null;
        this.evidencePageIndex = 0;
        this.version += 1;
        this.host.highlightEvents([]);
    }

    /** Navigation spans the full filtered list and reveals the selected page. */
    move(delta: 1 | -1): void {
        const list = this.filteredFindings();
        if (list.length === 0) {
            return;
        }
        const index = list.findIndex((finding) => finding.id === this.selectedId);
        const next = index < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.min(Math.max(index + delta, 0), list.length - 1);
        this.select(list[next]!.id);
    }

    counts(): Record<Severity, number> {
        return { ...this.severityCounts };
    }
}
