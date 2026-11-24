/**
 * Size and memory limits for opening recordings (browser file input and
 * desktop grants). Every loaded event is expanded into JS objects and
 * indexes in memory, so recording loads are bounded by event count and
 * estimated heap bytes as well as raw file size.
 */
import { formatByteBudget } from "../protocol/size";

/** Largest raw recording file the viewer opens: 2 GiB. */
export const MAX_RECORDING_BYTES = 2 * 1024 * 1024 * 1024;

/** Longest recording line kept (512 Ki UTF-16 code units); a longer one is rejected unread. */
export const MAX_RECORDING_LINE_CHARS = 512 * 1024;

/** Most events retained when loading a recording file into memory. */
export const MAX_RECORDING_EVENTS = 500_000;

/** Estimated JS heap budget (bytes) retained for a loaded recording. */
export const MAX_RECORDING_HEAP_BYTES = 512 * 1024 * 1024;

export type RecordingTruncationReason = "event-limit" | "heap-budget";

export interface RecordingTruncation {
    reason: RecordingTruncationReason;
    /** Configured event-count or estimated-heap-byte ceiling that was reached. */
    limit: number;
    loadedEvents: number;
    estimatedBytes: number;
    message: string;
}

export function describeRecordingTruncation(
    reason: RecordingTruncationReason,
    limit: number,
    loadedEvents: number,
    estimatedBytes: number,
): RecordingTruncation {
    const message =
        reason === "event-limit"
            ? `Partial recording loaded (${loadedEvents.toLocaleString("en-US")} events kept): stopped at the ${limit.toLocaleString("en-US")}-event recording limit before exhausting memory.`
            : `Partial recording loaded (${loadedEvents.toLocaleString("en-US")} events, ~${formatByteBudget(estimatedBytes)} estimated): stopped at the ${formatByteBudget(limit)} recording memory budget before exhausting heap.`;
    return { reason, limit, loadedEvents, estimatedBytes, message };
}

export function recordingTooLarge(limit: number): Error {
    return new Error(`the recording is larger than the ${limit}-byte limit (${(limit / 1024 ** 3).toFixed(1)} GiB) this viewer opens`);
}
