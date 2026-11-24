/**
 * Token counts, decode windows, and generation rates (active overall and trailing window).
 * Backend counts win over per-token events for a request; chunk events are never tokens.
 */

export const RECENT_WINDOW_MS = 5000;

/** Where a token total comes from; "mixed" when backend counts and token events both contribute. */
export type TokenProvenance = "backend-reported" | "derived" | "mixed" | "unavailable";

/**
 * How a request's decode (generation) window was measured, best first:
 * - `backend-eval`: `inference.decode.completed.backend_eval_ms` (covers hidden thinking tokens too);
 * - `reported-total-minus-ttft`: outcome `total_ms - ttft_ms` (first visible output to end);
 * - `first-output-to-end`: first output event to the outcome event;
 * - `first-to-last-token`: first to last per-token event of a request still open.
 */
export type DecodeSource = "backend-eval" | "reported-total-minus-ttft" | "first-output-to-end" | "first-to-last-token";

export interface DecodeWindow {
    startNs: number;
    endNs: number;
    /** Window length (ns); for reported sources this is the reported duration. */
    ns: number;
    /**
     * Tokens generated inside the window: the whole count for `backend-eval`
     * (eval_count / eval_duration), otherwise the tokens after the first one
     * (the first token opens the window), as Sonder-Inference's bench does.
     */
    tokens: number;
    source: DecodeSource;
}

export interface TokenTime {
    ns: number;
    n: number;
}

/**
 * Per-token events (never chunks) in replay order, as the token metrics read
 * them. deriveMetrics keeps plain lists; the incremental index
 * (metricsIndex.ts) answers the same questions from prefix sums.
 */
export interface TokenSeries {
    /** Number of per-token events. */
    readonly count: number;
    /** Sum of their token counts. */
    readonly sum: number;
    /** Time and token count of the first event, and time of the last (null / 0 when empty). */
    readonly firstNs: number | null;
    readonly firstN: number;
    readonly lastNs: number | null;
    /** Sum of the token counts of the events with ns > `ns`. */
    sumAfter(ns: number): number;
}

export class ListTokenSeries implements TokenSeries {
    constructor(private readonly list: readonly TokenTime[]) {}
    get count(): number {
        return this.list.length;
    }
    get sum(): number {
        return this.list.reduce((sum, x) => sum + x.n, 0);
    }
    get firstNs(): number | null {
        return this.list[0]?.ns ?? null;
    }
    get firstN(): number {
        return this.list[0]?.n ?? 0;
    }
    get lastNs(): number | null {
        return this.list.at(-1)?.ns ?? null;
    }
    sumAfter(ns: number): number {
        return this.list.filter((x) => x.ns > ns).reduce((sum, x) => sum + x.n, 0);
    }
}

/** Per-span facts only the token metrics need. */
export interface SpanWork {
    /** Per-token events (never chunks) of the span. */
    tokens: TokenSeries;
    evalMs: number | null;
    evalEndNs: number | null;
    totalMs: number | null;
    ttftMs: number | null;
}

export interface TokenMetrics {
    /** fromBackend + fromEvents. Chunk events are never counted. */
    total: number;
    provenance: TokenProvenance;
    /** Backend-reported completion tokens of requests that report them. */
    fromBackend: number;
    /** Tokens from per-token events of requests without a backend count (and of no request). */
    fromEvents: number;
    /** Output events that carry no token count (chunks). */
    chunks: number;
    /** Requests with output chunks but no token count yet (open, or the backend did not report). */
    uncountedRequests: number;
    /**
     * Tokens per second of active generation: decode-window tokens over the
     * summed decode windows of the requests (idle time is excluded).
     */
    overallRate: number | null;
    /** Summed decode windows (ms) behind overallRate. */
    activeDecodeMs: number | null;
    /**
     * Tokens per second over the trailing window ending at the last event:
     * per-token events in it, plus backend counts spread evenly over their decode window.
     */
    recentRate: number | null;
    /**
     * Length (ms) of that trailing window: RECENT_WINDOW_MS, or less when
     * the session has not yet lasted that long.
     */
    windowMs: number;
    /**
     * Sum of backend-reported completion tokens over requests that report
     * them (`token_counts_from_backend`); null when no request does.
     */
    backendReported: number | null;
}

export interface TokenSpanTarget {
    endNs: number | null;
    firstTokenNs: number | null;
    tokens: number;
    chunks: number;
    backendTokens: number | null;
    tokenCount: number | null;
    decode: DecodeWindow | null;
}

/** Best decode window of a span whose token count is known (see DecodeSource). */
export function decodeWindow(span: Pick<TokenSpanTarget, "tokenCount" | "endNs" | "firstTokenNs">, w: SpanWork): DecodeWindow | null {
    const count = span.tokenCount;
    if (count === null || count <= 0) {
        return null;
    }
    if (w.evalMs !== null) {
        const endNs = w.evalEndNs ?? span.endNs!;
        const ns = w.evalMs * 1e6;
        return { startNs: endNs - ns, endNs, ns, tokens: count, source: "backend-eval" };
    }
    if (count < 2) {
        return null;
    }
    if (span.endNs !== null && w.totalMs !== null && w.ttftMs !== null && w.ttftMs >= 0 && w.totalMs > w.ttftMs) {
        const ns = (w.totalMs - w.ttftMs) * 1e6;
        return { startNs: span.endNs - ns, endNs: span.endNs, ns, tokens: count - 1, source: "reported-total-minus-ttft" };
    }
    if (span.firstTokenNs === null) {
        return null;
    }
    const open = span.endNs === null;
    const endNs = open ? w.tokens.lastNs : span.endNs;
    if (endNs === null || endNs <= span.firstTokenNs) {
        return null;
    }
    return {
        startNs: span.firstTokenNs,
        endNs,
        ns: endNs - span.firstTokenNs,
        tokens: count - 1,
        source: open ? "first-to-last-token" : "first-output-to-end",
    };
}

function overlapNs(a0: number, a1: number, b0: number, b1: number): number {
    return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/**
 * Token totals and rates. Backend counts win over token events for a request;
 * chunk events are never tokens; rates use decode windows, never session wall time.
 */
export function computeTokenMetrics<S extends TokenSpanTarget>(
    requests: readonly S[],
    workOf: (span: S) => SpanWork,
    looseTokens: TokenSeries,
    chunks: number,
    firstNs: number | null,
    lastNs: number | null,
): TokenMetrics {
    let fromBackend = 0;
    let backendSpans = 0;
    let fromEvents = 0;
    let eventCounted = 0;
    let uncountedRequests = 0;
    let decodeTokens = 0;
    let decodeNs = 0;
    /** Measured per-token events that count toward the totals (for the trailing window). */
    const counted: TokenSeries[] = [looseTokens];
    const spread: DecodeWindow[] = [];
    for (const span of requests) {
        const w = workOf(span);
        if (span.backendTokens !== null) {
            span.tokenCount = span.backendTokens;
            fromBackend += span.backendTokens;
            backendSpans += 1;
        } else if (span.chunks > 0 && span.tokens === 0) {
            span.tokenCount = null;
            uncountedRequests += 1;
        } else {
            span.tokenCount = span.tokens;
            fromEvents += span.tokens;
            eventCounted += w.tokens.count;
            counted.push(w.tokens);
        }
        span.decode = decodeWindow(span, w);
        if (span.decode) {
            decodeTokens += span.decode.tokens;
            decodeNs += span.decode.ns;
            if (span.backendTokens !== null) {
                spread.push(span.decode);
            }
        }
    }
    // Token counts are integers, so these sums do not depend on summation order.
    fromEvents += looseTokens.sum;
    eventCounted += looseTokens.count;
    if (looseTokens.count >= 2) {
        // Token events with no request: their first-to-last span, as one stream.
        // The first event opens the span, so its tokens are not in it (N events
        // bound N-1 intervals), as decodeWindow does for a request.
        const ns = looseTokens.lastNs! - looseTokens.firstNs!;
        if (ns > 0) {
            decodeTokens += looseTokens.sum - looseTokens.firstN;
            decodeNs += ns;
        }
    }
    const provenance: TokenProvenance =
        backendSpans > 0 && eventCounted > 0 ? "mixed" : backendSpans > 0 ? "backend-reported" : eventCounted > 0 ? "derived" : "unavailable";
    let recentRate: number | null = null;
    // The trailing window never reaches back before the first event: a session
    // shorter than RECENT_WINDOW_MS is rated over the time actually observed.
    let windowMs = RECENT_WINDOW_MS;
    if (firstNs !== null && lastNs !== null) {
        windowMs = Math.min(RECENT_WINDOW_MS, (lastNs - firstNs) / 1e6);
    }
    if (provenance !== "unavailable" && lastNs !== null && windowMs > 0) {
        const windowStart = lastNs - windowMs * 1e6;
        let recent = 0;
        for (const series of counted) {
            recent += series.sumAfter(windowStart);
        }
        for (const d of spread) {
            if (d.ns > 0) {
                recent += (d.tokens * overlapNs(d.startNs, d.endNs, windowStart, lastNs)) / d.ns;
            }
        }
        recentRate = recent / (windowMs / 1000);
    }
    return {
        total: fromBackend + fromEvents,
        provenance,
        fromBackend,
        fromEvents,
        chunks,
        uncountedRequests,
        overallRate: decodeNs > 0 ? decodeTokens / (decodeNs / 1e9) : null,
        activeDecodeMs: decodeNs > 0 ? decodeNs / 1e6 : null,
        recentRate,
        windowMs,
        backendReported: backendSpans > 0 ? fromBackend : null,
    };
}
