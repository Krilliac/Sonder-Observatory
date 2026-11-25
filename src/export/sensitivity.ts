/**
 * Recording hygiene for exports (docs/SECURITY_PRIVACY.md: "export warns when
 * full text/tool payloads are present"). exportSession() refuses to write a
 * sensitive export unless the caller passes an explicit acknowledgement, so
 * every save path (browser download and the desktop `save_export` command)
 * goes through the same check.
 */
import { MAX_ATTRIBUTE_DEPTH, MAX_ATTRIBUTE_NODES, type ObservatoryEvent } from "../protocol/events";
import { filterEvents, type ExportRange } from "./filter";
import { stripUnsafeControls } from "./svg";

export interface ExportSensitivity {
    /** True when the export must not be written without an acknowledged warning. */
    sensitive: boolean;
    /** A session declared full text capture, or events carry plaintext token text. */
    fullText: boolean;
    /** Exported tool events carry unredacted arguments / results. */
    toolPayloads: boolean;
    /** Exported events carry credential/secret keys or secret-shaped token values. */
    secrets: boolean;
    /** Declared capture policy of the source session(s); "unspecified" if absent. */
    capturePolicy: string;
    /** Number of exported tool events with an unredacted payload. */
    toolPayloadEvents: number;
    /** Number of exported events with detected secret keys or values. */
    secretEvents: number;
}

/** `text_capture` values that mean plaintext is recorded (protocol: "full"; Sonder-Inference: "on"). */
const FULL_TEXT_POLICIES = new Set(["full", "on", "true"]);
const SESSION_DECLARATIONS = new Set(["session.started", "session.created"]);
const TOOL_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
    "args",
    "arguments",
    "input",
    "result",
    "output",
    "payload",
    "content",
    "params",
    "parameters",
    "stdout",
    "stderr",
    "command",
    "body",
    "tool_input",
    "tool_output",
    "tool_result",
    "raw_args",
    "raw_input",
    "raw_output",
]);
/**
 * Attributes that carry prompt or output text on any event (checked at top level
 * and inside nested objects). `token_text` is this repo's fixture shape;
 * Sonder-Inference sends captured chunk text as `text` on inference.token.generated.
 */
const TEXT_KEYS: ReadonlySet<string> = new Set([
    "token_text",
    "prompt",
    "system_prompt",
    "user_prompt",
    "prompt_text",
    "response",
    "response_text",
    "completion",
    "completion_text",
    "messages",
    "input_text",
    "output_text",
    "reasoning_content",
    "thinking",
    "assistant_message",
    "user_message",
]);
const TEXT_FIELD_EVENTS: ReadonlySet<string> = new Set([
    "inference.token.generated",
    "inference.chunk.generated",
    "agent.message",
]);
const SECRET_KEYS: ReadonlySet<string> = new Set([
    "authorization",
    "proxy_authorization",
    "api_key",
    "apikey",
    "x_api_key",
    "x_auth_token",
    "access_token",
    "refresh_token",
    "id_token",
    "auth_token",
    "bearer_token",
    "session_token",
    "oauth_token",
    "jwt",
    "secret",
    "client_secret",
    "api_secret",
    "token_secret",
    "webhook_secret",
    "password",
    "passwd",
    "pwd",
    "private_key",
    "signing_key",
    "encryption_key",
    "master_key",
    "ssh_key",
    "credential",
    "credentials",
    "cookie",
    "set_cookie",
    "auth_header",
    "capability",
    "capability_token",
]);

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
    /\bBearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{8,}/i,
    /\bBasic\s+[A-Za-z0-9+/]{12,}={0,2}\b/,
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
    /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}\b/,
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    /\bAIza[0-9A-Za-z_-]{30,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/,
    /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@[^\s/]+/i,
];

const SCAN_MAX_DEPTH = Math.max(MAX_ATTRIBUTE_DEPTH, 16);
const SCAN_MAX_NODES = Math.max(MAX_ATTRIBUTE_NODES, 1024);

const STRICT_REDACTED_MARKER = /^\s*(?:\[redacted(?::\s*[a-z0-9_.-]{1,32})?\]|<redacted(?::\s*[a-z0-9_.-]{1,32})?>|\*{3,})\s*$/i;
const STRICT_SHA256_HASH = /^\s*sha256:[0-9a-f]{8,64}\s*$/i;

/** Inference TELEMETRY.md defines this one field as a chat message count. */
function isInferenceChatMessageCount(e: ObservatoryEvent): boolean {
    const value = e.attributes.messages;
    return e.producer.name === "sonder-inference" && e.event_type === "request.queued" &&
        e.attributes.kind === "chat" && typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Null, empty, an exact "[redacted…]" marker or a strict sha256 hex digest count as no payload. */
function isRedacted(value: unknown): boolean {
    if (value === null || value === undefined || value === "") {
        return true;
    }
    return typeof value === "string" && (STRICT_REDACTED_MARKER.test(value) || STRICT_SHA256_HASH.test(value));
}

function normalizeKey(key: string): string {
    return key.trim().toLowerCase().replace(/-/g, "_");
}

function containsSecretValue(value: string): boolean {
    if (value.length < 12 || isRedacted(value)) {
        return false;
    }
    return SECRET_VALUE_PATTERNS.some((re) => re.test(value));
}

function isNonCountToolCalls(value: unknown): boolean {
    if (isRedacted(value)) {
        return false;
    }
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
        return false;
    }
    if (Array.isArray(value) && value.length === 0) {
        return false;
    }
    return true;
}

function inspectEventSensitivity(e: ObservatoryEvent): { text: boolean; toolPayload: boolean; secret: boolean } {
    const isToolEvent = e.event_type.startsWith("tool.");
    const isTextFieldEvent = TEXT_FIELD_EVENTS.has(e.event_type);
    const seen = new WeakSet<object>();
    let nodes = 0;
    let text = false;
    let toolPayload = false;
    let secret = false;

    const visit = (value: unknown, depth: number): void => {
        if ((text && toolPayload && secret) || depth > SCAN_MAX_DEPTH || nodes >= SCAN_MAX_NODES) {
            return;
        }
        if (typeof value === "string") {
            if (!secret && containsSecretValue(value)) {
                secret = true;
            }
            return;
        }
        if (value === null || typeof value !== "object") {
            return;
        }
        if (seen.has(value)) {
            return;
        }
        seen.add(value);
        nodes += 1;

        if (Array.isArray(value)) {
            for (let i = 0; i < value.length && nodes < SCAN_MAX_NODES; i += 1) {
                visit(value[i], depth + 1);
                if (text && toolPayload && secret) {
                    return;
                }
            }
            return;
        }

        for (const [rawKey, v] of Object.entries(value as Record<string, unknown>)) {
            const k = normalizeKey(rawKey);
            if (!secret && SECRET_KEYS.has(k) && !isRedacted(v)) {
                secret = true;
            }
            if (!text) {
                const exemptMessages = depth === 0 && k === "messages" && isInferenceChatMessageCount(e);
                if (!exemptMessages && (TEXT_KEYS.has(k) || (depth === 0 && isTextFieldEvent && k === "text")) && !isRedacted(v)) {
                    text = true;
                }
            }
            if (!toolPayload) {
                if ((isToolEvent && TOOL_PAYLOAD_KEYS.has(k) && !isRedacted(v)) || (k === "tool_calls" && isNonCountToolCalls(v))) {
                    toolPayload = true;
                }
            }
            visit(v, depth + 1);
            if (text && toolPayload && secret) {
                return;
            }
        }
    };

    visit(e.attributes, 0);
    return { text, toolPayload, secret };
}

/**
 * Capture policy declared by the session(s) in `events` (`session.started`, or
 * Sonder-Inference's `session.created`), comma-joined; "unspecified" if none.
 */
export function declaredCapturePolicy(events: readonly ObservatoryEvent[]): string {
    const policies = new Set<string>();
    for (const e of events) {
        if (!SESSION_DECLARATIONS.has(e.event_type)) {
            continue;
        }
        const tc = e.attributes.text_capture;
        if (typeof tc === "string" && tc.trim() !== "") {
            policies.add(tc);
        } else if (tc === true) {
            policies.add("full");
        } else if (typeof e.attributes.capture_policy === "string" && e.attributes.capture_policy.trim() !== "") {
            policies.add(e.attributes.capture_policy);
        }
    }
    return policies.size > 0 ? [...policies].join(",") : "unspecified";
}

/**
 * Checks whether exporting `range` of `events` would carry full text, tool
 * payloads, or embedded secrets. The capture policy is session-wide, so it is
 * read from all `events` even when the range excludes the session-start event.
 */
export function assessExportSensitivity(events: readonly ObservatoryEvent[], range: ExportRange = {}): ExportSensitivity {
    const capturePolicy = declaredCapturePolicy(events);
    const selected = filterEvents(events, range);
    let fullText = capturePolicy.split(",").some((p) => FULL_TEXT_POLICIES.has(p.trim().toLowerCase()));
    let toolPayloadEvents = 0;
    let secretEvents = 0;
    for (const e of selected) {
        const hit = inspectEventSensitivity(e);
        if (!fullText && hit.text) {
            fullText = true;
        }
        if (hit.toolPayload) {
            toolPayloadEvents += 1;
        }
        if (hit.secret) {
            secretEvents += 1;
        }
    }
    const toolPayloads = toolPayloadEvents > 0;
    const secrets = secretEvents > 0;
    return {
        sensitive: fullText || toolPayloads || secrets,
        fullText,
        toolPayloads,
        secrets,
        capturePolicy,
        toolPayloadEvents,
        secretEvents,
    };
}

export interface SensitiveExportWarning {
    title: string;
    items: string[];
    confirmLabel: string;
    cancelLabel: string;
}

function displayPolicy(policy: string): string {
    const clean = stripUnsafeControls(policy).replace(/[\t\r\n]+/g, " ").trim();
    return clean.length > 128 ? `${clean.slice(0, 127)}…` : clean;
}

/** Text for the confirmation dialog. Pure, so the wording is testable. */
export function sensitiveExportWarning(a: ExportSensitivity): SensitiveExportWarning {
    const items: string[] = [];
    const safePolicy = displayPolicy(a.capturePolicy);
    if (a.fullText) {
        items.push(
            a.capturePolicy === "unspecified"
                ? "Events contain plaintext prompt/output text."
                : a.capturePolicy.split(",").some((policy) => FULL_TEXT_POLICIES.has(policy.trim().toLowerCase()))
                  ? `The session was recorded with text capture "${safePolicy}": prompts and outputs may be included in full.`
                  : `The session declares text capture "${safePolicy}", but events contain plaintext prompt/output text.`,
        );
    }
    if (a.toolPayloads) {
        items.push(`${a.toolPayloadEvents} tool event${a.toolPayloadEvents === 1 ? "" : "s"} carry unredacted arguments or results.`);
    }
    if (a.secrets) {
        items.push(`${a.secretEvents} event${a.secretEvents === 1 ? "" : "s"} appear to contain credentials, tokens, or secret keys.`);
    }
    items.push("Treat the exported file like user data: it may contain secrets or personal information.");
    return { title: "This export may contain sensitive data", items, confirmLabel: "Export anyway", cancelLabel: "Cancel" };
}

/** Thrown by exportSession() for a sensitive export without `acknowledgeSensitive`. Nothing was written. */
export class SensitiveExportError extends Error {
    constructor(readonly assessment: ExportSensitivity) {
        super("Export refused: the session contains sensitive data (full text, tool payloads, or secrets); confirm the warning first");
        this.name = "SensitiveExportError";
    }
}
