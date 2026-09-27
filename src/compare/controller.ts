/**
 * DOM-free state of the comparison view: what each side (A = baseline,
 * B = candidate) shows, the alignment mode, and cached analyses.
 *
 * A side is empty, a loaded recording (.sobs / NDJSON / JSONL, read with
 * loadRecording), or the viewer's current session (a fixture, an opened file
 * or a live connection; the host passes its events on every render). A live
 * current session keeps growing, so its re-analysis is throttled to one per
 * `liveThrottleMs`; the host asks `pendingRefreshMs()` when to render again.
 */
import type { ObservatoryEvent } from "../protocol/events";
import { loadRecording } from "../recording/sobs";
import { compareAnalyses, type Comparison } from "./compare";
import { analyzeSession, type AlignMode, type SessionAnalysis } from "./summary";

export type SideId = "a" | "b";

export type SideSource =
    | { kind: "empty" }
    | { kind: "current" }
    | { kind: "recording"; label: string; events: readonly ObservatoryEvent[]; rejected: number };

export interface SideView {
    id: SideId;
    title: string;
    kind: SideSource["kind"];
    label: string;
    events: number | null;
    rejected: number;
    synthetic: boolean;
    error: string | null;
}

export interface LoadResult {
    ok: boolean;
    events: number;
    rejected: number;
    error: string | null;
}

export interface CompareControllerOptions {
    /** Minimum time between re-analyses of a growing current session (default 1000 ms). */
    liveThrottleMs?: number;
    now?: () => number;
    mode?: AlignMode;
}

export const SIDE_TITLES: Record<SideId, string> = { a: "A · Baseline", b: "B · Candidate" };

/**
 * Content signal of the analysed current session. The host's SessionStore
 * replaces its events array on every append, so array identity says nothing:
 * the first event identifies the session (a reset or a different source
 * starts with another event object), and length + last event detect growth.
 */
interface CurrentCache {
    first: ObservatoryEvent;
    last: ObservatoryEvent;
    length: number;
    at: number;
    analysis: SessionAnalysis;
}

export class CompareController {
    private sources: Record<SideId, SideSource> = { a: { kind: "empty" }, b: { kind: "current" } };
    private errors: Record<SideId, string | null> = { a: null, b: null };
    private recordingAnalyses = new WeakMap<object, SessionAnalysis>();
    private analysisIds = new WeakMap<SessionAnalysis, number>();
    private nextAnalysisId = 1;
    private current: readonly ObservatoryEvent[] = [];
    private currentLabel = "current session";
    private currentCache: CurrentCache | null = null;
    private pendingSince: number | null = null;
    private cachedComparison: { a: SessionAnalysis; b: SessionAnalysis; mode: AlignMode; value: Comparison } | null = null;
    private version = 0;
    private alignMode: AlignMode;
    private readonly throttleMs: number;
    private readonly now: () => number;

    constructor(options: CompareControllerOptions = {}) {
        this.throttleMs = options.liveThrottleMs ?? 1000;
        this.now = options.now ?? (() => Date.now());
        this.alignMode = options.mode ?? "request";
    }

    get mode(): AlignMode {
        return this.alignMode;
    }

    /** Called by the host on every render with the viewer's current session. */
    setCurrent(events: readonly ObservatoryEvent[], label = "current session"): void {
        this.current = events;
        if (label !== this.currentLabel) {
            this.currentLabel = label;
            this.version += 1;
        }
    }

    loadRecordingText(side: SideId, text: string, label: string): LoadResult {
        const loaded = loadRecording(text);
        const rejected = loaded.rejected.length;
        if (loaded.events.length === 0) {
            const reason = loaded.rejected[0]?.reason;
            const error = `No events could be read from ${label}${reason ? `: ${reason}` : ""}.`;
            this.errors[side] = error;
            this.version += 1;
            return { ok: false, events: 0, rejected, error };
        }
        this.setRecording(side, loaded.events, label, rejected);
        return { ok: true, events: loaded.events.length, rejected, error: null };
    }

    /** Uses already parsed events as a recording side. */
    setRecording(side: SideId, events: readonly ObservatoryEvent[], label: string, rejected = 0): void {
        this.sources[side] = { kind: "recording", label, events, rejected };
        this.errors[side] = null;
        this.version += 1;
    }

    useCurrent(side: SideId): void {
        this.sources[side] = { kind: "current" };
        this.errors[side] = null;
        this.version += 1;
    }

    clear(side: SideId): void {
        this.sources[side] = { kind: "empty" };
        this.errors[side] = null;
        this.version += 1;
    }

    swap(): void {
        this.sources = { a: this.sources.b, b: this.sources.a };
        this.errors = { a: this.errors.b, b: this.errors.a };
        this.version += 1;
    }

    setMode(mode: AlignMode): void {
        if (mode !== this.alignMode) {
            this.alignMode = mode;
            this.version += 1;
        }
    }

    side(id: SideId): SideView {
        const src = this.sources[id];
        const base = { id, title: SIDE_TITLES[id], kind: src.kind, error: this.errors[id] };
        if (src.kind === "empty") {
            return { ...base, label: "No session selected", events: null, rejected: 0, synthetic: false };
        }
        const analysis = this.analysis(id);
        if (src.kind === "current") {
            return { ...base, label: this.currentLabel, events: this.current.length, rejected: 0, synthetic: analysis?.synthetic ?? false };
        }
        return { ...base, label: src.label, events: src.events.length, rejected: src.rejected, synthetic: analysis?.synthetic ?? false };
    }

    /** Analysis shown for a side (possibly a throttled, slightly stale one for a growing live session). */
    analysis(id: SideId): SessionAnalysis | null {
        const src = this.sources[id];
        if (src.kind === "empty") {
            return null;
        }
        if (src.kind === "recording") {
            let a = this.recordingAnalyses.get(src.events);
            if (!a) {
                a = this.register(analyzeSession(src.events));
                this.recordingAnalyses.set(src.events, a);
            }
            return a;
        }
        if (this.current.length === 0) {
            return null;
        }
        const events = this.current;
        const first = events[0]!;
        const last = events[events.length - 1]!;
        const cache = this.currentCache;
        const sameSession = cache !== null && cache.first === first;
        if (sameSession && cache.length === events.length && cache.last === last) {
            this.pendingSince = null;
            return cache.analysis;
        }
        const now = this.now();
        if (sameSession && now - cache.at < this.throttleMs) {
            this.pendingSince ??= cache.at;
            return cache.analysis;
        }
        this.pendingSince = null;
        this.currentCache = { first, last, length: events.length, at: now, analysis: this.register(analyzeSession(events)) };
        return this.currentCache.analysis;
    }

    /** Milliseconds until a throttled current-session re-analysis is due, or null if none is pending. */
    pendingRefreshMs(): number | null {
        if (this.pendingSince === null) {
            return null;
        }
        return Math.max(0, this.pendingSince + this.throttleMs - this.now());
    }

    /** The comparison, or null until both sides have events. */
    comparison(): Comparison | null {
        const a = this.analysis("a");
        const b = this.analysis("b");
        if (!a || !b) {
            this.cachedComparison = null;
            return null;
        }
        const c = this.cachedComparison;
        if (c && c.a === a && c.b === b && c.mode === this.alignMode) {
            return c.value;
        }
        const value = compareAnalyses(a, b, this.alignMode);
        this.cachedComparison = { a, b, mode: this.alignMode, value };
        return value;
    }

    /** Changes whenever anything the view shows changes. */
    stamp(): string {
        const id = (s: SideId) => {
            const a = this.analysis(s);
            return a ? this.analysisIds.get(a) : 0;
        };
        return `${this.version}|${this.alignMode}|${id("a")}|${id("b")}|${this.current.length}`;
    }

    private register(analysis: SessionAnalysis): SessionAnalysis {
        this.analysisIds.set(analysis, this.nextAnalysisId++);
        return analysis;
    }
}
