/** Export of the selected event range back to a `.sobs` recording (NDJSON). */
import type { ObservatoryEvent } from "../protocol/events";
import { toNdjson } from "../recording/ndjson";
import { buildManifest } from "../recording/sobs";
import { filterEvents, type ExportRange } from "./filter";
import { declaredCapturePolicy } from "./sensitivity";

export interface SobsExportOptions {
    /**
     * Capture policy to record in the manifest. Defaults to the policy declared
     * by the source session(s) in `events`, so a filtered range that drops the
     * session-start event still says e.g. `full` rather than `unspecified`.
     */
    capturePolicy?: string;
}

/**
 * Serialises the events in `range` as a `.sobs` recording: a fresh manifest
 * line followed by every selected event, unmodified, in replay order.
 * Loading the result with loadRecording() yields exactly those events.
 */
export function renderSobs(
    events: readonly ObservatoryEvent[],
    range: ExportRange = {},
    createdAt: Date = new Date(),
    options: SobsExportOptions = {},
): string {
    const selected = filterEvents(events, range);
    const manifest = buildManifest(selected, createdAt);
    manifest.capture_policy = options.capturePolicy ?? declaredCapturePolicy(events);
    return toNdjson([manifest, ...selected]);
}
