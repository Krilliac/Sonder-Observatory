/**
 * Extension point for additional views (for example Milestone 2 topology or
 * diagnostics panels). A panel receives the events visible at the replay
 * cursor and renders into its own container on every frame that changes.
 *
 * Panels must derive everything from the events they are given and must not
 * present synthetic or inferred structure as measured data.
 */
import type { ObservatoryEvent } from "../protocol/events";

export interface PanelContext {
    /** Events at or before the replay cursor, in replay order. */
    visible: readonly ObservatoryEvent[];
    /** Every event of the current session, in replay order. */
    all: readonly ObservatoryEvent[];
    /** Currently selected event id, if any. */
    selectedId: string | null;
    /** Select an event (moves the replay cursor to it and opens the inspector). */
    select(event: ObservatoryEvent): void;
    /** Whether the session contains synthetic events. */
    synthetic: boolean;
}

export interface ObservatoryPanel {
    /** Stable DOM id suffix, e.g. "topology". */
    id: string;
    title: string;
    render(container: HTMLElement, ctx: PanelContext): void;
}
