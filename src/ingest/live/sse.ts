/**
 * Incremental text/event-stream parser (WHATWG HTML "server-sent events"
 * interpretation rules), usable on chunks from fetch() so the client can set
 * a Last-Event-ID header and control flow, which EventSource cannot.
 */
export interface SseMessage {
    /** Event type; "message" when the stream did not name one. */
    event: string;
    data: string;
    /** Last event id in effect when this message was dispatched ("" if none). */
    lastEventId: string;
}

/**
 * Largest line (and, for SSE, event: all its data lines together) the live
 * parsers buffer, in UTF-16 code units (512 Ki chars). A producer controls
 * line length, so an oversized or unterminated line must not grow the
 * viewer's memory without bound.
 */
export const MAX_LINE_CHARS = 512 * 1024;

/**
 * Largest `id:` or `event:` field value retained by SseParser (4 Ki chars).
 * Keeps Last-Event-ID bounded so reconnect headers cannot grow to 512 KiB
 * and trigger HTTP 431 Request Header Fields Too Large.
 */
export const MAX_SSE_FIELD_CHARS = 4096;

export interface SseHandlers {
    onMessage(message: SseMessage): void;
    /** Reconnection time requested by the server via a `retry:` field. */
    onRetry?(ms: number): void;
    /** Comment line (`:` prefix stripped, plus one optional leading space). */
    onComment?(comment: string): void;
    /** A line or event exceeded the size limit and was discarded. */
    onOversize?(reason: string): void;
}

export class SseParser {
    /** Pieces of the unterminated line (kept apart so no chunk is rescanned). */
    private parts: string[] = [];
    private partChars = 0;
    /** Discarding an oversized line up to its terminator. */
    private skippingLine = false;
    /** Discarding the current event up to its blank line. */
    private skippingEvent = false;
    /** True when the current line inside a discarded event had any non-empty content. */
    private discardedLineNonEmpty = false;
    private dataChars = 0;
    private data: string[] = [];
    private eventType = "";
    private lastEventId = "";
    private sawData = false;
    private first = true;
    private pendingCr = false;
    private readonly maxLineChars: number;

    constructor(
        private readonly handlers: SseHandlers,
        maxLineChars: number = MAX_LINE_CHARS,
    ) {
        this.maxLineChars = Number.isFinite(maxLineChars) ? Math.max(1, Math.floor(maxLineChars)) : MAX_LINE_CHARS;
    }

    /** Id carried over across reconnects, per spec. */
    get currentLastEventId(): string {
        return this.lastEventId;
    }

    /** Characters held for an unterminated line. */
    get bufferedChars(): number {
        return this.partChars;
    }

    feed(chunk: string): void {
        if (this.first && chunk.length > 0) {
            this.first = false;
            if (chunk.charCodeAt(0) === 0xfeff) {
                chunk = chunk.slice(1);
            }
        }
        let text = chunk;
        // A CR at the end of the previous chunk may pair with a LF here.
        if (this.pendingCr) {
            this.pendingCr = false;
            if (text.startsWith("\n")) {
                text = text.slice(1);
            }
        }
        let start = 0;
        for (let i = 0; i < text.length; i += 1) {
            const c = text.charCodeAt(i);
            if (c !== 10 && c !== 13) {
                continue;
            }
            this.hold(text.slice(start, i));
            if (this.skippingLine) {
                this.skippingLine = false;
            } else if (this.skippingEvent) {
                if (!this.discardedLineNonEmpty) {
                    this.skippingEvent = false;
                    this.eventType = "";
                }
                this.discardedLineNonEmpty = false;
            } else {
                const line = this.parts.length === 1 ? this.parts[0]! : this.parts.join("");
                this.parts = [];
                this.partChars = 0;
                this.processLine(line);
            }
            if (c === 13) {
                if (i + 1 < text.length) {
                    if (text.charCodeAt(i + 1) === 10) {
                        i += 1;
                    }
                } else {
                    this.pendingCr = true;
                }
            }
            start = i + 1;
        }
        this.hold(text.slice(start));
    }

    /** Discards a partially received event (stream ended mid-event). */
    reset(): void {
        this.parts = [];
        this.partChars = 0;
        this.skippingLine = false;
        this.skippingEvent = false;
        this.discardedLineNonEmpty = false;
        this.dataChars = 0;
        this.data = [];
        this.eventType = "";
        this.sawData = false;
        this.pendingCr = false;
    }

    /** Buffers part of the current line, or drops the line once it is too long. */
    private hold(text: string): void {
        if (this.skippingLine || text.length === 0) {
            return;
        }
        if (this.skippingEvent) {
            this.discardedLineNonEmpty = true;
            return;
        }
        if (this.partChars + text.length > this.maxLineChars) {
            this.parts = [];
            this.partChars = 0;
            this.skippingLine = true;
            this.oversize(`an SSE line exceeds the ${this.maxLineChars}-character limit`);
            return;
        }
        this.parts.push(text);
        this.partChars += text.length;
    }

    /** Drops the event in progress; the stream resynchronises at its blank line. */
    private oversize(reason: string): void {
        this.data = [];
        this.dataChars = 0;
        this.sawData = false;
        this.skippingEvent = true;
        this.discardedLineNonEmpty = false;
        this.handlers.onOversize?.(reason);
    }

    private processLine(line: string): void {
        if (line === "") {
            if (this.skippingEvent) {
                this.skippingEvent = false;
                this.eventType = "";
                return;
            }
            this.dispatch();
            return;
        }
        if (this.skippingEvent) {
            return;
        }
        if (line.startsWith(":")) {
            let comment = line.slice(1);
            if (comment.startsWith(" ")) {
                comment = comment.slice(1);
            }
            this.handlers.onComment?.(comment);
            return; // comment / heartbeat / control notice
        }
        const colon = line.indexOf(":");
        let field: string;
        let value: string;
        if (colon === -1) {
            field = line;
            value = "";
        } else {
            field = line.slice(0, colon);
            value = line.slice(colon + 1);
            if (value.startsWith(" ")) {
                value = value.slice(1);
            }
        }
        switch (field) {
            case "data":
                this.dataChars += value.length + 1;
                if (this.dataChars > this.maxLineChars) {
                    this.oversize(`SSE event data exceeds the ${this.maxLineChars}-character limit`);
                    break;
                }
                this.data.push(value);
                this.sawData = true;
                break;
            case "event":
                if (value.length <= MAX_SSE_FIELD_CHARS) {
                    this.eventType = value;
                } else {
                    this.oversize(`SSE event name exceeds the ${MAX_SSE_FIELD_CHARS}-character limit`);
                }
                break;
            case "id":
                if (!value.includes("\u0000") && value.length <= MAX_SSE_FIELD_CHARS) {
                    this.lastEventId = value;
                }
                break;
            case "retry":
                if (/^\d+$/.test(value)) {
                    this.handlers.onRetry?.(Number(value));
                }
                break;
            default:
                break; // unknown fields are ignored
        }
    }

    private dispatch(): void {
        if (!this.sawData) {
            this.eventType = "";
            return;
        }
        const message: SseMessage = {
            event: this.eventType || "message",
            data: this.data.join("\n"),
            lastEventId: this.lastEventId,
        };
        this.data = [];
        this.dataChars = 0;
        this.eventType = "";
        this.sawData = false;
        this.handlers.onMessage(message);
    }
}

export interface LineSplitterOptions {
    /** Longest line kept, in UTF-16 code units. Default MAX_LINE_CHARS. */
    maxLineChars?: number;
    /** A line exceeded the limit and was discarded. */
    onOversize?(reason: string): void;
}

/**
 * Splits a text stream into lines across chunk boundaries (LF or CRLF).
 * Each chunk is scanned once, and a line longer than the limit is dropped
 * (and reported) rather than buffered.
 */
export class LineSplitter {
    private parts: string[] = [];
    private partChars = 0;
    /** Discarding an oversized line up to its terminator. */
    private skipping = false;
    private first = true;
    private readonly maxLineChars: number;
    private readonly onOversize: ((reason: string) => void) | undefined;

    constructor(options: LineSplitterOptions = {}) {
        const rawMax = options.maxLineChars ?? MAX_LINE_CHARS;
        this.maxLineChars = Number.isFinite(rawMax) ? Math.max(1, Math.floor(rawMax)) : MAX_LINE_CHARS;
        this.onOversize = options.onOversize;
    }

    /** Characters held for an unterminated line. */
    get bufferedChars(): number {
        return this.partChars;
    }

    feed(chunk: string): string[] {
        if (this.first && chunk.length > 0) {
            this.first = false;
            if (chunk.charCodeAt(0) === 0xfeff) {
                chunk = chunk.slice(1);
            }
        }
        const lines: string[] = [];
        let start = 0;
        for (;;) {
            const nl = chunk.indexOf("\n", start);
            if (nl === -1) {
                this.hold(chunk.slice(start));
                return lines;
            }
            this.hold(chunk.slice(start, nl));
            start = nl + 1;
            if (this.skipping) {
                this.skipping = false;
                continue;
            }
            const line = this.parts.length === 1 ? this.parts[0]! : this.parts.join("");
            this.parts = [];
            this.partChars = 0;
            lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
        }
    }

    /** Returns the trailing unterminated line, if any. */
    flush(): string[] {
        let rest = this.parts.join("");
        const skipped = this.skipping;
        this.parts = [];
        this.partChars = 0;
        this.skipping = false;
        if (rest.endsWith("\r")) {
            rest = rest.slice(0, -1);
        }
        return skipped || rest.trim() === "" ? [] : [rest];
    }

    private hold(text: string): void {
        if (this.skipping || text.length === 0) {
            return;
        }
        if (this.partChars + text.length > this.maxLineChars) {
            this.parts = [];
            this.partChars = 0;
            this.skipping = true;
            this.onOversize?.(`an NDJSON line exceeds the ${this.maxLineChars}-character limit`);
            return;
        }
        this.parts.push(text);
        this.partChars += text.length;
    }
}
