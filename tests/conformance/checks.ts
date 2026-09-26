/**
 * Live producer conformance checks (live producer protocol v1,
 * docs/TELEMETRY_PROTOCOL.md). Used by tests/conformance/live-producer.test.ts
 * against running producers, and by tests/ingest/live/conformance.test.ts to
 * prove the checks pass on the fake producer and fail on broken producers.
 *
 * "Valid against the schema" means validateDiscovery / validateEvent, the
 * hand-written mirrors that drift tests keep aligned with protocol/
 * (Observatory has no JSON-Schema library; docs/DECISIONS.md).
 *
 * The bearer token, when given, is only sent as an Authorization header and
 * never appears in a failure message.
 */
import { WELL_KNOWN_DISCOVERY_PATH, parseDiscovery, type ProducerDiscovery } from "../../src/protocol/discovery";
import type { ObservatoryEvent } from "../../src/protocol/events";
import { formatIssues, validateEvent } from "../../src/protocol/validate";

export interface ConformanceOptions {
    /** Origin sent on every request; CORS answers must allow it. */
    origin: string;
    token?: string;
    /** Stop reading a stream after this many events. Default 20. */
    minEvents?: number;
    /** Upper bound for reading one stream, in ms. Default 8000. */
    maxStreamMs?: number;
    /** Stop reading after this long without new events (once any arrived). Default 1500. */
    idleMs?: number;
    fetch?: typeof globalThis.fetch;
}

export interface StreamSample {
    events: ObservatoryEvent[];
    /** SSE comments (without the leading colon), e.g. "resume-gap 3-9", "keepalive". */
    comments: string[];
}

export interface ConformanceReport {
    url: string;
    discovery: ProducerDiscovery | null;
    failures: string[];
    sse: StreamSample | null;
    ndjson: StreamSample | null;
}

/** Headers a browser-based Observatory sends on HTTP streams (contract section 0). */
export const REQUIRED_ALLOW_HEADERS = ["accept", "authorization", "cache-control", "last-event-id"] as const;

interface RawStream {
    status: number;
    headers: Headers;
    text: string;
}

function discoveryUrlOf(url: string): string {
    const parsed = new URL(url);
    if (parsed.pathname.replace(/\/+$/, "").endsWith(WELL_KNOWN_DISCOVERY_PATH)) {
        return parsed.toString();
    }
    return new URL(WELL_KNOWN_DISCOVERY_PATH, parsed).toString();
}

function headerList(value: string | null): string[] {
    return (value ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h !== "");
}

/**
 * Reads a streaming response until `enough(text)` holds, the stream has been
 * idle for `idleMs` after `started(text)`, or `maxMs` passed; then aborts.
 */
async function readStream(
    fetchImpl: typeof globalThis.fetch,
    url: string,
    headers: Record<string, string>,
    enough: (text: string) => boolean,
    started: (text: string) => boolean,
    maxMs: number,
    idleMs: number,
): Promise<RawStream> {
    const controller = new AbortController();
    const deadline = Date.now() + maxMs;
    const response = await fetchImpl(url, { headers, signal: controller.signal, cache: "no-store" });
    let text = "";
    if (!response.body) {
        return { status: response.status, headers: response.headers, text };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let lastData = Date.now();
    try {
        for (;;) {
            if (enough(text)) {
                break;
            }
            const now = Date.now();
            const idleLeft = started(text) ? lastData + idleMs - now : Number.POSITIVE_INFINITY;
            const wait = Math.min(deadline - now, idleLeft);
            if (wait <= 0) {
                break;
            }
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeout = new Promise<"timeout">((r) => {
                timer = setTimeout(() => r("timeout"), wait);
            });
            const result = await Promise.race([reader.read(), timeout]);
            clearTimeout(timer);
            if (result === "timeout") {
                continue;
            }
            if (result.done) {
                break;
            }
            text += decoder.decode(result.value, { stream: true });
            lastData = Date.now();
        }
    } finally {
        controller.abort();
        reader.cancel().catch(() => undefined);
    }
    return { status: response.status, headers: response.headers, text };
}

interface SseBlock {
    fields: [string, string][];
    comments: string[];
}

/** Splits complete SSE blocks (terminated by a blank line). */
export function parseSseBlocks(text: string): SseBlock[] {
    const normalized = text.replace(/\r\n?/g, "\n");
    const end = normalized.lastIndexOf("\n\n");
    if (end < 0) {
        return [];
    }
    return normalized
        .slice(0, end)
        .split("\n\n")
        .map((block) => {
            const fields: [string, string][] = [];
            const comments: string[] = [];
            for (const line of block.split("\n")) {
                if (line === "") {
                    continue;
                }
                if (line.startsWith(":")) {
                    comments.push(line.slice(1).trim());
                    continue;
                }
                const colon = line.indexOf(":");
                const name = colon < 0 ? line : line.slice(0, colon);
                let value = colon < 0 ? "" : line.slice(colon + 1);
                if (value.startsWith(" ")) {
                    value = value.slice(1);
                }
                fields.push([name, value]);
            }
            return { fields, comments };
        });
}

function countSseEvents(text: string): number {
    return parseSseBlocks(text).filter((b) => b.fields.some(([n]) => n === "data")).length;
}

function countLines(text: string): number {
    return text.split("\n").filter((l, i, all) => l.trim() !== "" && i < all.length - 1).length;
}

/** Checks id format, instance and contiguity over events in arrival order. */
function checkSequence(
    label: string,
    items: { event: ObservatoryEvent; gapBefore: boolean }[],
    instance: string,
    failures: string[],
): void {
    let previous: number | null = null;
    for (const { event, gapBefore } of items) {
        const expectedId = `${instance}-${event.sequence}`;
        if (event.event_id !== expectedId) {
            failures.push(`${label}: event_id ${event.event_id} is not <instance_id>-<sequence> (${expectedId})`);
        }
        const declared = event.producer.instance_id;
        if (declared !== undefined && declared !== instance) {
            failures.push(`${label}: producer.instance_id ${String(declared)} does not match discovery (${instance})`);
        }
        if (previous !== null && event.sequence !== previous + 1 && !gapBefore) {
            failures.push(
                `${label}: sequence ${event.sequence} follows ${previous} without a resume-gap or dropped notice`,
            );
        }
        previous = event.sequence;
    }
}

function checkCorsResponse(label: string, headers: Headers, origin: string, failures: string[]): void {
    const allow = headers.get("access-control-allow-origin");
    if (allow !== origin && allow !== "*") {
        failures.push(`${label}: Access-Control-Allow-Origin is ${JSON.stringify(allow)}, expected ${origin}`);
    }
}

async function checkPreflight(
    fetchImpl: typeof globalThis.fetch,
    label: string,
    url: string,
    origin: string,
    failures: string[],
): Promise<void> {
    let response: Response;
    try {
        response = await fetchImpl(url, {
            method: "OPTIONS",
            headers: {
                Origin: origin,
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": REQUIRED_ALLOW_HEADERS.join(", "),
            },
        });
    } catch (error) {
        failures.push(`${label} preflight: request failed (${(error as Error).message})`);
        return;
    }
    if (response.status !== 204 && response.status !== 200) {
        failures.push(`${label} preflight: HTTP ${response.status}, expected 204`);
        return;
    }
    checkCorsResponse(`${label} preflight`, response.headers, origin, failures);
    const methods = headerList(response.headers.get("access-control-allow-methods"));
    if (!methods.includes("get") && !methods.includes("*")) {
        failures.push(`${label} preflight: Access-Control-Allow-Methods does not allow GET`);
    }
    const allowed = headerList(response.headers.get("access-control-allow-headers"));
    for (const header of REQUIRED_ALLOW_HEADERS) {
        // A wildcard never covers Authorization (Fetch standard).
        if (!allowed.includes(header) && !(allowed.includes("*") && header !== "authorization")) {
            failures.push(`${label} preflight: Access-Control-Allow-Headers does not allow ${header}`);
        }
    }
}

function sseSample(
    text: string,
    instance: string,
    failures: string[],
    label: string,
): { sample: StreamSample; items: { event: ObservatoryEvent; gapBefore: boolean }[] } {
    const blocks = parseSseBlocks(text);
    const firstLine = text.replace(/\r\n?/g, "\n").split("\n").find((l) => l !== "");
    if (!firstLine?.startsWith("retry:")) {
        failures.push(`${label}: the first line is ${JSON.stringify(firstLine ?? "")}, expected "retry: <ms>"`);
    }
    const events: ObservatoryEvent[] = [];
    const comments: string[] = [];
    const items: { event: ObservatoryEvent; gapBefore: boolean }[] = [];
    let gapPending = false;
    for (const block of blocks) {
        for (const comment of block.comments) {
            comments.push(comment);
            if (comment.startsWith("resume-gap") || comment.startsWith("dropped")) {
                gapPending = true;
            }
        }
        const data = block.fields.filter(([n]) => n === "data").map(([, v]) => v);
        if (data.length === 0) {
            continue;
        }
        const eventName = block.fields.find(([n]) => n === "event");
        if (eventName) {
            failures.push(`${label}: custom event name "event: ${eventName[1]}" (producers send no event: field)`);
        }
        if (data.length > 1) {
            failures.push(`${label}: an event spans ${data.length} data: lines (expected one envelope on one line)`);
        }
        let value: unknown;
        try {
            value = JSON.parse(data.join("\n"));
        } catch {
            failures.push(`${label}: data is not JSON: ${data.join("\\n").slice(0, 120)}`);
            continue;
        }
        const result = validateEvent(value);
        if (!result.ok) {
            failures.push(`${label}: invalid envelope: ${formatIssues(result.issues)}`);
            continue;
        }
        const id = block.fields.find(([n]) => n === "id")?.[1];
        if (id !== result.event.event_id) {
            failures.push(`${label}: id ${JSON.stringify(id ?? null)} differs from event_id ${result.event.event_id}`);
        }
        events.push(result.event);
        items.push({ event: result.event, gapBefore: gapPending });
        gapPending = false;
    }
    checkSequence(label, items, instance, failures);
    return { sample: { events, comments }, items };
}

/**
 * Runs every conformance check against one producer (base or discovery
 * URL) and returns the failures (empty when it conforms).
 */
export async function checkProducer(url: string, options: ConformanceOptions): Promise<ConformanceReport> {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const minEvents = options.minEvents ?? 20;
    const maxMs = options.maxStreamMs ?? 8000;
    const idleMs = options.idleMs ?? 1500;
    const failures: string[] = [];
    const report: ConformanceReport = { url, discovery: null, failures, sse: null, ndjson: null };
    const auth: Record<string, string> = options.token !== undefined ? { Authorization: `Bearer ${options.token}` } : {};
    const base = { Origin: options.origin, "Cache-Control": "no-store", ...auth };
    const discoveryUrl = discoveryUrlOf(url);

    // 1. Discovery: preflight, CORS, schema.
    await checkPreflight(fetchImpl, "discovery", discoveryUrl, options.origin, failures);
    let response: Response;
    try {
        response = await fetchImpl(discoveryUrl, { headers: { ...base, Accept: "application/json" } });
    } catch (error) {
        failures.push(`discovery: request failed (${(error as Error).message})`);
        return report;
    }
    if (response.status !== 200) {
        failures.push(
            `discovery: HTTP ${response.status}${response.status === 401 ? " (set SONDER_CONFORMANCE_TOKEN)" : ""}`,
        );
        return report;
    }
    if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
        failures.push(`discovery: Content-Type ${response.headers.get("content-type")}, expected application/json`);
    }
    checkCorsResponse("discovery", response.headers, options.origin, failures);
    const parsed = parseDiscovery(await response.json().catch(() => null));
    if (!parsed.ok) {
        failures.push(`discovery: ${formatIssues(parsed.issues)}`);
        return report;
    }
    const discovery = parsed.discovery;
    report.discovery = discovery;
    const instance = discovery.producer.instance_id;
    if (discovery.auth.required && options.token === undefined) {
        failures.push("discovery: the producer requires auth; set SONDER_CONFORMANCE_TOKEN");
        return report;
    }
    if (discovery.auth.required) {
        const anonymous = await fetchImpl(discoveryUrl, { headers: { Origin: options.origin, Accept: "application/json" } });
        if (anonymous.status !== 401) {
            failures.push(`auth: discovery without a token returned HTTP ${anonymous.status}, expected 401`);
        }
        await anonymous.body?.cancel();
    }

    const streamUrl = (transport: string): string | null => {
        const stream = discovery.streams.find((s) => s.transport === transport);
        return stream ? new URL(stream.url, discoveryUrl).toString() : null;
    };

    // 2. SSE: framing, envelopes, ids, contiguity.
    const sseUrl = streamUrl("sse");
    if (sseUrl === null) {
        failures.push("discovery: no sse stream listed");
    } else {
        await checkPreflight(fetchImpl, "sse", sseUrl, options.origin, failures);
        const raw = await readStream(
            fetchImpl,
            sseUrl,
            { ...base, Accept: "text/event-stream" },
            (t) => countSseEvents(t) >= minEvents,
            (t) => countSseEvents(t) > 0,
            maxMs,
            idleMs,
        );
        if (raw.status !== 200) {
            failures.push(`sse: HTTP ${raw.status}`);
        } else {
            if (!(raw.headers.get("content-type") ?? "").toLowerCase().startsWith("text/event-stream")) {
                failures.push(`sse: Content-Type ${raw.headers.get("content-type")}, expected text/event-stream`);
            }
            checkCorsResponse("sse", raw.headers, options.origin, failures);
            const { sample } = sseSample(raw.text, instance, failures, "sse");
            report.sse = sample;
            if (sample.events.length === 0) {
                failures.push("sse: no events arrived (the retained window should replay)");
            } else {
                // 3. Resume via Last-Event-ID from the first event received.
                const from = sample.events[0]!;
                const resumed = await readStream(
                    fetchImpl,
                    sseUrl,
                    { ...base, Accept: "text/event-stream", "Last-Event-ID": from.event_id },
                    (t) => countSseEvents(t) >= 1,
                    () => true,
                    sample.events.length > 1 ? maxMs : Math.min(maxMs, idleMs),
                    idleMs,
                );
                const resumeFailures: string[] = [];
                const { items } = sseSample(resumed.text, instance, resumeFailures, "sse resume");
                failures.push(...resumeFailures);
                const firstItem = items[0];
                if (sample.events.length > 1 && !firstItem) {
                    failures.push(`sse resume: nothing arrived after Last-Event-ID ${from.event_id}`);
                } else if (firstItem && firstItem.event.sequence !== from.sequence + 1 && !firstItem.gapBefore) {
                    failures.push(
                        `sse resume: after Last-Event-ID ${from.event_id} the stream started at sequence ` +
                            `${firstItem.event.sequence}, expected ${from.sequence + 1}`,
                    );
                }
            }
        }
    }

    // 4. NDJSON: framing, envelopes, ids, contiguity.
    const ndjsonUrl = streamUrl("ndjson");
    if (ndjsonUrl === null) {
        failures.push("discovery: no ndjson stream listed");
    } else {
        const raw = await readStream(
            fetchImpl,
            ndjsonUrl,
            { ...base, Accept: "application/x-ndjson" },
            (t) => countLines(t) >= minEvents,
            (t) => countLines(t) > 0,
            maxMs,
            idleMs,
        );
        if (raw.status !== 200) {
            failures.push(`ndjson: HTTP ${raw.status}`);
        } else {
            if (!(raw.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-ndjson")) {
                failures.push(`ndjson: Content-Type ${raw.headers.get("content-type")}, expected application/x-ndjson`);
            }
            checkCorsResponse("ndjson", raw.headers, options.origin, failures);
            const lines = raw.text.split("\n");
            lines.pop(); // incomplete tail
            const items: { event: ObservatoryEvent; gapBefore: boolean }[] = [];
            for (const line of lines) {
                if (line.trim() === "") {
                    continue; // heartbeat
                }
                let value: unknown;
                try {
                    value = JSON.parse(line);
                } catch {
                    failures.push(`ndjson: line is not JSON: ${line.slice(0, 120)}`);
                    continue;
                }
                const result = validateEvent(value);
                if (!result.ok) {
                    failures.push(`ndjson: invalid envelope: ${formatIssues(result.issues)}`);
                    continue;
                }
                items.push({ event: result.event, gapBefore: false });
            }
            if (items.length === 0) {
                failures.push("ndjson: no events arrived (the retained window should replay)");
            }
            checkSequence("ndjson", items, instance, failures);
            report.ndjson = { events: items.map((i) => i.event), comments: [] };
        }
    }
    return report;
}
