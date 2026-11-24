/**
 * Control event wiring, WAI-ARIA tab keyboard navigation, global shortcut
 * dispatch, and lazy confirmed export helpers for ObservatoryApp.
 */
import { describeRange, isFullRange, type ExportRange } from "../export/filter";
import { EXPORT_FORMATS } from "../export/save";
import type { ObservatoryEvent } from "../protocol/events";
import type { EventClass } from "../query/classify";
import type { ReplayCursor } from "../replay/controller";
import { VIEWS, type ViewId } from "./appLayout";
import { byId } from "./dom";
import type { ExportChoice } from "./exportDialog";
import { shortcutAction, type ShortcutAction } from "./shortcuts";

export interface AppControlHandlers {
    toggleSidebar(): void;
    openFile(file: File): void;
    loadFixture(): void;
    saveRecording(): void;
    openExport(): void;
    openShortcuts(): void;
    cancelLoad(): void;
    togglePlay(): void;
    setSpeed(speed: number): void;
    jumpToError(dir: 1 | -1): void;
    setFollowFromCheck(checked: boolean): void;
    scrubTo(value: number): void;
    setFilterText(text: string): void;
    setFilterClass(cls: EventClass | "all"): void;
    onTableKey(ev: KeyboardEvent): void;
    onTimelineKey(ev: KeyboardEvent): void;
    setView(view: ViewId): void;
    getView(): ViewId;
    isShortcutsEnabled(): boolean;
    stepEvent(delta: 1 | -1): void;
    followLatest(): void;
    toggleTheme(): void;
}

export function runShortcutAction(
    action: ShortcutAction,
    handlers: Pick<AppControlHandlers, "openShortcuts" | "togglePlay" | "stepEvent" | "jumpToError" | "setView" | "followLatest" | "toggleTheme">,
): void {
    switch (action) {
        case "help":
            handlers.openShortcuts();
            break;
        case "play-pause":
            handlers.togglePlay();
            break;
        case "next-event":
            handlers.stepEvent(1);
            break;
        case "previous-event":
            handlers.stepEvent(-1);
            break;
        case "next-error":
            handlers.jumpToError(1);
            break;
        case "previous-error":
            handlers.jumpToError(-1);
            break;
        case "focus-filter":
            handlers.setView("events");
            byId<HTMLInputElement>("filter-text").focus();
            break;
        case "follow-latest":
            handlers.followLatest();
            break;
        case "toggle-theme":
            handlers.toggleTheme();
            break;
    }
}

export function bindAppControls(handlers: AppControlHandlers): void {
    byId<HTMLButtonElement>("sidebar-toggle").addEventListener("click", () => handlers.toggleSidebar());
    byId<HTMLInputElement>("file-input").addEventListener("change", (ev) => {
        const input = ev.target as HTMLInputElement;
        const file = input.files?.[0];
        if (file) {
            handlers.openFile(file);
        }
        input.value = "";
    });
    byId<HTMLButtonElement>("fixture-btn").addEventListener("click", () => handlers.loadFixture());
    byId<HTMLButtonElement>("save-btn").addEventListener("click", () => handlers.saveRecording());
    byId<HTMLButtonElement>("export-btn").addEventListener("click", () => handlers.openExport());
    byId<HTMLButtonElement>("shortcuts-btn").addEventListener("click", () => handlers.openShortcuts());
    byId<HTMLButtonElement>("load-cancel").addEventListener("click", () => handlers.cancelLoad());
    byId<HTMLButtonElement>("play-btn").addEventListener("click", () => handlers.togglePlay());
    byId<HTMLSelectElement>("speed-select").addEventListener("change", (ev) => {
        handlers.setSpeed(Number((ev.target as HTMLSelectElement).value));
    });
    byId<HTMLButtonElement>("next-error-btn").addEventListener("click", () => handlers.jumpToError(1));
    byId<HTMLButtonElement>("prev-error-btn").addEventListener("click", () => handlers.jumpToError(-1));
    byId<HTMLInputElement>("follow-check").addEventListener("change", (ev) => {
        handlers.setFollowFromCheck((ev.target as HTMLInputElement).checked);
    });
    byId<HTMLInputElement>("scrubber").addEventListener("input", (ev) => {
        handlers.scrubTo(Number((ev.target as HTMLInputElement).value));
    });
    byId<HTMLInputElement>("filter-text").addEventListener("input", (ev) => {
        handlers.setFilterText((ev.target as HTMLInputElement).value.trim().toLowerCase());
    });
    byId<HTMLSelectElement>("filter-class").addEventListener("change", (ev) => {
        handlers.setFilterClass((ev.target as HTMLSelectElement).value as EventClass | "all");
    });
    byId<HTMLDivElement>("table-wrap").addEventListener("keydown", (ev) => handlers.onTableKey(ev));
    byId<HTMLDivElement>("timeline").addEventListener("keydown", (ev) => handlers.onTimelineKey(ev));
    VIEWS.forEach((v, i) => {
        const tab = byId<HTMLButtonElement>(`tab-${v.id}`);
        tab.addEventListener("click", () => handlers.setView(v.id));
        // WAI-ARIA tabs pattern (automatic activation): Left/Right wrap, Home/End jump.
        tab.addEventListener("keydown", (ev) => {
            const n = VIEWS.length;
            const target =
                ev.key === "ArrowRight" ? (i + 1) % n : ev.key === "ArrowLeft" ? (i - 1 + n) % n : ev.key === "Home" ? 0 : ev.key === "End" ? n - 1 : -1;
            if (target < 0) {
                return;
            }
            ev.preventDefault();
            handlers.setView(VIEWS[target]!.id);
            byId(`tab-${handlers.getView()}`).focus();
        });
    });
    document.addEventListener("keydown", (ev) => {
        if (!handlers.isShortcutsEnabled() || document.querySelector("dialog[open]") || ev.defaultPrevented) {
            return;
        }
        const action = shortcutAction(ev);
        if (action) {
            ev.preventDefault();
            runShortcutAction(action, handlers);
        }
    });
}

/** The range "Current view" exports: the event-table filters up to the replay cursor. */
export function buildViewRange(cursor: ReplayCursor, filterClass: EventClass | "all", filterText: string): ExportRange {
    const last = cursor.visibleEvents().at(-1);
    return { cls: filterClass, text: filterText, toNs: last ? last.mono_ns : null };
}

export function formatViewRangeText(cursor: ReplayCursor, filterClass: EventClass | "all", filterText: string): string {
    const shown = cursor.visibleCount();
    const all = cursor.events.length;
    const pos = shown < all ? `events up to the replay cursor (${shown} of ${all})` : "all events (the cursor is at the end)";
    const filtered = filterClass !== "all" || filterText !== "";
    const filters = filtered ? `, filtered by ${describeRange({ cls: filterClass, text: filterText }, cursor.originNs)}` : "";
    return `As in the Events table: ${pos}${filters}.`;
}

/** Runs an export through exportWithConfirmation (never exportSession directly). */
export async function executeConfirmedExport(
    choice: ExportChoice,
    events: readonly ObservatoryEvent[],
    viewRange: () => ExportRange,
): Promise<string | null> {
    if (events.length === 0) {
        return null;
    }
    const range: ExportRange = choice.scope === "view" ? viewRange() : {};
    const label = EXPORT_FORMATS[choice.format].label;
    try {
        const { confirmSensitiveExport, exportWithConfirmation } = await import("../export");
        const saved = await exportWithConfirmation(choice.format, { events, range: isFullRange(range) ? {} : range }, confirmSensitiveExport);
        return saved ? `Exported ${label}: ${saved.name}` : `${label} export cancelled; nothing was written.`;
    } catch (error) {
        return `${label} export failed: ${(error as Error)?.message ?? String(error)}`;
    }
}
