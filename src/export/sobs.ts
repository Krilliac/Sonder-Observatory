/** Export of the selected event range back to a `.sobs` recording (NDJSON). */
import type { ObservatoryEvent } from "../protocol/events";
import { serializeRecording } from "../recording/sobs";
import { filterEvents, type ExportRange } from "./filter";

/**
 * Serialises the events in `range` as a `.sobs` recording: a fresh manifest
 * line followed by every selected event, unmodified, in replay order.
 * Loading the result with loadRecording() yields exactly those events.
 */
export function renderSobs(events: readonly ObservatoryEvent[], range: ExportRange = {}, createdAt: Date = new Date()): string {
    return serializeRecording(filterEvents(events, range), createdAt);
}
