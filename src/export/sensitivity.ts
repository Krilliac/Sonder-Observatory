/**
 * Recording hygiene for exports (docs/SECURITY_PRIVACY.md: "export warns when
 * full text/tool payloads are present"). exportSession() refuses to write a
 * sensitive export unless the caller passes an explicit acknowledgement, so
 * every save path (browser download and the desktop `save_export` command)
 * goes through the same check.
 */
import type { ObservatoryEvent } from "../protocol/events";
import { filterEvents, type ExportRange } from "./filter";

export interface ExportSensitivity {
    /** True when the export must not be written without an acknowledged warning. */
    sensitive: boolean;
    /** A session declared full text capture, or events carry plaintext token text. */
    fullText: boolean;
    /** Exported tool events carry unredacted arguments / results. */
    toolPayloads: boolean;
    /** Declared capture policy of the source session(s); "unspecified" if absent. */
    capturePolicy: string;
    /** Number of exported tool events with an unredacted payload. */
    toolPayloadEvents: number;
}

/** `text_capture` values that mean plaintext is recorded (protocol: "full"; Sonder-Inference: "on"). */
const FULL_TEXT_POLICIES = new Set(["full", "on"]);
const SESSION_DECLARATIONS = new Set(["session.started", "session.created"]);
const TOOL_PAYLOAD_KEYS = ["args", "arguments", "input", "result", "output", "payload", "content"] as const;

/** Null, empty, a "[redacted…]" marker or a content hash count as no payload. */
function isRedacted(value: unknown): boolean {
    if (value === null || value === undefined || value === "") {
        return true;
    }
    return typeof value === "string" && (/^\s*\[redacted/i.test(value) || /^sha256:/i.test(value));
}

/**
 * Capture policy declared by the session(s) in `events` (`session.started`, or
 * Sonder-Inference's `session.created`), comma-joined; "unspecified" if none.
 */
export function declaredCapturePolicy(events: readonly ObservatoryEvent[]): string {
    const policies = new Set<string>();
    for (const e of events) {
        if (SESSION_DECLARATIONS.has(e.event_type) && typeof e.attributes.text_capture === "string") {
            policies.add(e.attributes.text_capture);
        }
    }
    return policies.size > 0 ? [...policies].join(",") : "unspecified";
}

/**
 * Checks whether exporting `range` of `events` would carry full text or tool
 * payloads. The capture policy is session-wide, so it is read from all
 * `events` even when the range excludes the session-start event.
 */
export function assessExportSensitivity(events: readonly ObservatoryEvent[], range: ExportRange = {}): ExportSensitivity {
    const capturePolicy = declaredCapturePolicy(events);
    const selected = filterEvents(events, range);
    let fullText = capturePolicy.split(",").some((p) => FULL_TEXT_POLICIES.has(p.trim().toLowerCase()));
    let toolPayloadEvents = 0;
    for (const e of selected) {
        if (!fullText && typeof e.attributes.token_text === "string" && !isRedacted(e.attributes.token_text)) {
            fullText = true;
        }
        if (e.event_type.startsWith("tool.") && TOOL_PAYLOAD_KEYS.some((k) => !isRedacted(e.attributes[k]))) {
            toolPayloadEvents++;
        }
    }
    const toolPayloads = toolPayloadEvents > 0;
    return { sensitive: fullText || toolPayloads, fullText, toolPayloads, capturePolicy, toolPayloadEvents };
}

export interface SensitiveExportWarning {
    title: string;
    items: string[];
    confirmLabel: string;
    cancelLabel: string;
}

/** Text for the confirmation dialog. Pure, so the wording is testable. */
export function sensitiveExportWarning(a: ExportSensitivity): SensitiveExportWarning {
    const items: string[] = [];
    if (a.fullText) {
        items.push(
            a.capturePolicy === "unspecified"
                ? "Events contain plaintext prompt/output text."
                : `The session was recorded with text capture "${a.capturePolicy}": prompts and outputs may be included in full.`,
        );
    }
    if (a.toolPayloads) {
        items.push(`${a.toolPayloadEvents} tool event${a.toolPayloadEvents === 1 ? "" : "s"} carry unredacted arguments or results.`);
    }
    items.push("Treat the exported file like user data: it may contain secrets or personal information.");
    return { title: "This export may contain sensitive data", items, confirmLabel: "Export anyway", cancelLabel: "Cancel" };
}

/** Thrown by exportSession() for a sensitive export without `acknowledgeSensitive`. Nothing was written. */
export class SensitiveExportError extends Error {
    constructor(readonly assessment: ExportSensitivity) {
        super("Export refused: the session contains sensitive data (full text or tool payloads); confirm the warning first");
        this.name = "SensitiveExportError";
    }
}
