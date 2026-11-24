import type { ObservatoryEvent } from "../protocol/events";
import { boundRejectedLine, estimateEventBytes } from "../protocol/size";
import { formatIssues, validateEvent } from "../protocol/validate";
import { describeRecordingTruncation, type RecordingTruncation } from "./limits";

export interface RejectedLine {
    /** 1-based line number in the source text. */
    line: number;
    reason: string;
    raw: string;
}

export interface ParseResult {
    events: ObservatoryEvent[];
    rejected: RejectedLine[];
    /** Non-event JSON records (for example a recording manifest line). */
    records: { line: number; value: Record<string, unknown> }[];
    /** Estimated heap bytes added by `events` (tracked when event/heap budgets are configured). */
    estimatedBytes?: number;
    /** Present when parsing stopped early to stay within the event or heap budget. */
    truncated?: RecordingTruncation;
}

export interface ParseOptions {
    /**
     * Return true for decoded objects that are container records rather than
     * events (for example the .sobs manifest). They are collected in
     * `records` instead of being validated as events.
     */
    isRecord?: (value: Record<string, unknown>) => boolean;
    /** Longest line parsed, in UTF-16 code units; longer lines are rejected unread. */
    maxLineChars?: number;
    /** Maximum events retained across the recording; stops cleanly when reached. */
    maxEvents?: number;
    /** Maximum estimated JS heap bytes retained across the recording; stops cleanly when reached. */
    maxHeapBytes?: number;
    /** Prior event count already retained (used when parsing across slices). */
    initialEvents?: number;
    /** Prior estimated heap bytes already retained (used when parsing across slices). */
    initialBytes?: number;
}

/**
 * Parses newline-delimited JSON (NDJSON / JSONL). Blank lines are skipped.
 * Invalid lines never abort the parse: they are returned in `rejected` (with
 * bounded raw previews) so a corrupt or partial recording stays inspectable
 * (fail closed, not silent). When event-count or heap-byte budgets are set,
 * parsing stops cleanly before exceeding them and sets `truncated`.
 */
export function parseNdjson(text: string, options: ParseOptions = {}): ParseResult {
    const result: ParseResult = { events: [], rejected: [], records: [] };
    const maxLine = options.maxLineChars ?? Number.POSITIVE_INFINITY;
    const maxEvents = options.maxEvents ?? Number.POSITIVE_INFINITY;
    const maxHeapBytes = options.maxHeapBytes ?? Number.POSITIVE_INFINITY;
    const trackBytes = Number.isFinite(maxEvents) || Number.isFinite(maxHeapBytes);
    let loadedEvents = options.initialEvents ?? 0;
    let loadedBytes = options.initialBytes ?? 0;
    let addedBytes = 0;

    let pos = 0;
    let line = 0;
    while (pos < text.length) {
        line += 1;
        let end = text.indexOf("\n", pos);
        const nextPos = end === -1 ? text.length : end + 1;
        if (end === -1) {
            end = text.length;
        }
        if (end > pos && text.charCodeAt(end - 1) === 13) {
            end -= 1;
        }
        const rawLen = end - pos;
        if (rawLen > maxLine) {
            result.rejected.push({
                line,
                reason: `line exceeds the ${maxLine}-character limit; not parsed`,
                raw: "",
            });
            pos = nextPos;
            continue;
        }
        const trimmed = text.slice(pos, end).trim();
        pos = nextPos;
        if (trimmed === "") {
            continue;
        }
        let value: unknown;
        try {
            value = JSON.parse(trimmed);
        } catch (error) {
            result.rejected.push(
                boundRejectedLine({
                    line,
                    reason: `invalid JSON: ${(error as Error).message}`,
                    raw: trimmed,
                }),
            );
            continue;
        }
        if (
            options.isRecord &&
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value) &&
            options.isRecord(value as Record<string, unknown>)
        ) {
            result.records.push({ line, value: value as Record<string, unknown> });
            continue;
        }
        const validation = validateEvent(value);
        if (!validation.ok) {
            result.rejected.push(
                boundRejectedLine({ line, reason: formatIssues(validation.issues), raw: trimmed }),
            );
            continue;
        }
        if (loadedEvents >= maxEvents) {
            result.truncated = describeRecordingTruncation("event-limit", maxEvents, loadedEvents, loadedBytes);
            break;
        }
        if (trackBytes) {
            const eventBytes = estimateEventBytes(validation.event);
            if (loadedBytes + eventBytes > maxHeapBytes) {
                result.truncated = describeRecordingTruncation("heap-budget", maxHeapBytes, loadedEvents, loadedBytes);
                break;
            }
            loadedBytes += eventBytes;
            addedBytes += eventBytes;
        }
        loadedEvents += 1;
        result.events.push(validation.event);
    }
    if (trackBytes) {
        result.estimatedBytes = addedBytes;
    }
    return result;
}

export function toNdjson(values: readonly unknown[]): string {
    return values.map((v) => JSON.stringify(v)).join("\n") + (values.length > 0 ? "\n" : "");
}
