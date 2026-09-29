/**
 * Text of the Overview "Prompt cache" and "Speculative decoding" cards and of
 * the per-request rows the inspector shows. Pure so the wording is
 * unit-tested. The values are backend-reported counts (Ollama
 * `prompt_eval_cached_count`, llama-server cached and draft tokens); a card
 * exists only when at least one request reported them, so streams without
 * these fields render exactly as before.
 */
import type { Metrics, PromptCacheTotals, RequestSpan, SpeculationTotals } from "../query/metrics";
import { fmtPct } from "./format";

export interface ReuseCardModel {
    title: string;
    value: string;
    sub: string;
    evidence: string;
    /** Per-model breakdown lines (`[model, text]`), in first-request order. */
    rows: [string, string][];
}

function plural(n: number, one: string, many = `${one}s`): string {
    return `${n} ${n === 1 ? one : many}`;
}

function fmtMean(n: number | null): string {
    return n === null ? "—" : Number(n.toFixed(2)).toString();
}

function cacheText(t: PromptCacheTotals): string {
    return `${fmtPct(t.hitRatio)} cached · ${t.cachedTokens} / ${t.promptTokens} prompt tokens · ${plural(t.requests, "req")}`;
}

function specText(t: SpeculationTotals): string {
    return `${fmtPct(t.acceptanceRate)} accepted · ${t.acceptedTokens} / ${t.draftTokens} draft tokens · ${plural(t.requests, "req")}`;
}

/** The prompt-cache card, or null when no request reported prompt-cache use. */
export function promptCacheCardModel(m: Metrics): ReuseCardModel | null {
    const c = m.promptCache;
    if (c.requests === 0) {
        return null;
    }
    const sessions = Object.keys(c.bySession).length;
    return {
        title: "Prompt cache",
        value: `${fmtPct(c.hitRatio)} cached`,
        sub: `${c.cachedTokens} of ${plural(c.promptTokens, "prompt token")} served from cache · ${c.evaluatedTokens} evaluated · ${plural(c.requests, "request")}${sessions > 1 ? ` in ${sessions} sessions` : ""}`,
        evidence: `backend-reported · prompt_eval_cached_count / backend_cached_tokens of ${plural(c.requests, "request")}`,
        rows: Object.entries(c.byModel).map(([model, t]) => [model, cacheText(t)]),
    };
}

/** The speculative-decoding card, or null when no request reported draft tokens. */
export function speculationCardModel(m: Metrics): ReuseCardModel | null {
    const s = m.speculation;
    if (s.requests === 0) {
        return null;
    }
    return {
        title: "Speculative decoding",
        value: `${fmtPct(s.acceptanceRate)} accepted`,
        sub: `${s.acceptedTokens} of ${plural(s.draftTokens, "draft token")} accepted · mean ${fmtMean(s.acceptedPerRequest)} accepted per request · ${plural(s.requests, "request")}`,
        evidence: `backend-reported · draft / accepted draft tokens of ${plural(s.requests, "request")}`,
        rows: Object.entries(s.byModel).map(([model, t]) => [model, specText(t)]),
    };
}

/** Inspector rows for one request's backend reuse reports; empty when it has none. */
export function requestReuseRows(span: RequestSpan): [string, string][] {
    const rows: [string, string][] = [];
    const c = span.promptCache;
    if (c) {
        rows.push(["prompt cache", `${c.cachedTokens} / ${c.promptTokens} prompt tokens cached (${fmtPct(c.hitRatio)}) · ${c.evaluatedTokens} evaluated · ${c.source}`]);
    }
    const s = span.speculation;
    if (s) {
        rows.push(["speculation", `${s.acceptedTokens} / ${s.draftTokens} draft tokens accepted (${fmtPct(s.acceptanceRate)}) · ${s.source}`]);
    }
    if (rows.length > 0) {
        rows.unshift(["model", span.model ?? "not reported"]);
    }
    return rows;
}
