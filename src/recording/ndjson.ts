import type { ObservatoryEvent } from "../protocol/events";
import { formatIssues, validateEvent } from "../protocol/validate";

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
}

export interface ParseOptions {
    /**
     * Return true for decoded objects that are container records rather than
     * events (for example the .sobs manifest). They are collected in
     * `records` instead of being validated as events.
     */
    isRecord?: (value: Record<string, unknown>) => boolean;
}

/**
 * Parses newline-delimited JSON (NDJSON / JSONL). Blank lines are skipped.
 * Invalid lines never abort the parse: they are returned in `rejected` so a
 * corrupt or partial recording stays inspectable (fail closed, not silent).
 */
export function parseNdjson(text: string, options: ParseOptions = {}): ParseResult {
    const result: ParseResult = { events: [], rejected: [], records: [] };
    const lines = text.split(/\r?\n/);
    lines.forEach((raw, index) => {
        const line = index + 1;
        const trimmed = raw.trim();
        if (trimmed === "") {
            return;
        }
        let value: unknown;
        try {
            value = JSON.parse(trimmed);
        } catch (error) {
            result.rejected.push({
                line,
                reason: `invalid JSON: ${(error as Error).message}`,
                raw: trimmed,
            });
            return;
        }
        if (
            options.isRecord &&
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value) &&
            options.isRecord(value as Record<string, unknown>)
        ) {
            result.records.push({ line, value: value as Record<string, unknown> });
            return;
        }
        const validation = validateEvent(value);
        if (validation.ok) {
            result.events.push(validation.event);
        } else {
            result.rejected.push({ line, reason: formatIssues(validation.issues), raw: trimmed });
        }
    });
    return result;
}

export function toNdjson(values: readonly unknown[]): string {
    return values.map((v) => JSON.stringify(v)).join("\n") + (values.length > 0 ? "\n" : "");
}
