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

export interface SseHandlers {
    onMessage(message: SseMessage): void;
    /** Reconnection time requested by the server via a `retry:` field. */
    onRetry?(ms: number): void;
}

export class SseParser {
    private buffer = "";
    private data: string[] = [];
    private eventType = "";
    private lastEventId = "";
    private sawData = false;
    private first = true;
    private pendingCr = false;

    constructor(private readonly handlers: SseHandlers) {}

    /** Id carried over across reconnects, per spec. */
    get currentLastEventId(): string {
        return this.lastEventId;
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
        this.buffer += text;
        let start = 0;
        for (let i = 0; i < this.buffer.length; i += 1) {
            const c = this.buffer.charCodeAt(i);
            if (c !== 10 && c !== 13) {
                continue;
            }
            this.processLine(this.buffer.slice(start, i));
            if (c === 13) {
                if (i + 1 < this.buffer.length) {
                    if (this.buffer.charCodeAt(i + 1) === 10) {
                        i += 1;
                    }
                } else {
                    this.pendingCr = true;
                }
            }
            start = i + 1;
        }
        this.buffer = this.buffer.slice(start);
    }

    /** Discards a partially received event (stream ended mid-event). */
    reset(): void {
        this.buffer = "";
        this.data = [];
        this.eventType = "";
        this.sawData = false;
        this.pendingCr = false;
    }

    private processLine(line: string): void {
        if (line === "") {
            this.dispatch();
            return;
        }
        if (line.startsWith(":")) {
            return; // comment / heartbeat
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
                this.data.push(value);
                this.sawData = true;
                break;
            case "event":
                this.eventType = value;
                break;
            case "id":
                if (!value.includes("\u0000")) {
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
        this.eventType = "";
        this.sawData = false;
        this.handlers.onMessage(message);
    }
}

/** Splits a text stream into lines across chunk boundaries (LF or CRLF). */
export class LineSplitter {
    private buffer = "";

    feed(chunk: string): string[] {
        this.buffer += chunk;
        const parts = this.buffer.split("\n");
        this.buffer = parts.pop() ?? "";
        return parts.map((p) => (p.endsWith("\r") ? p.slice(0, -1) : p));
    }

    /** Returns the trailing unterminated line, if any. */
    flush(): string[] {
        const rest = this.buffer;
        this.buffer = "";
        return rest.trim() === "" ? [] : [rest];
    }
}
