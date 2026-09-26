/**
 * Attribute readers used by the comparison view.
 *
 * These follow the rules of src/query/attributes.ts (and build on its
 * readers): accept every documented spelling, never invent a value, and
 * return null when no spelling is present. Candidates for promotion into
 * src/query/attributes.ts once another consumer needs them; see
 * docs/integration/compare.md for the conventions they assume.
 */
import type { ObservatoryEvent } from "../protocol/events";
import { backendTokenCount } from "../query/attributes";

function finite(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegative(value: unknown): number | null {
    const n = finite(value);
    return n !== null && n >= 0 ? n : null;
}

function nonEmpty(value: unknown): string | null {
    if (typeof value === "string" && value !== "") {
        return value;
    }
    return typeof value === "number" && Number.isInteger(value) ? String(value) : null;
}

export const REQUEST_OUTCOMES = ["request.completed", "request.failed", "request.cancelled"] as const;

export function isRequestOutcome(event: ObservatoryEvent): boolean {
    return (REQUEST_OUTCOMES as readonly string[]).includes(event.event_type);
}

/**
 * Conversation turn of an event: an envelope-level `turn_id` extension field,
 * or the `turn_id` / `turn` / `turn_index` attribute. Null when not reported.
 */
export function turnId(event: ObservatoryEvent): string | null {
    return (
        nonEmpty(event.turn_id) ??
        nonEmpty(event.attributes.turn_id) ??
        nonEmpty(event.attributes.turn) ??
        nonEmpty(event.attributes.turn_index)
    );
}

/** Prompt tokens: `prompt_tokens` (Observatory fixture, Inference) or `prompt_eval_count` (Ollama timings). */
export function promptTokens(event: ObservatoryEvent): number | null {
    return nonNegative(event.attributes.prompt_tokens) ?? nonNegative(event.attributes.prompt_eval_count);
}

/**
 * Completion tokens reported on a request outcome: the backend count when
 * `token_counts_from_backend` is set (attributes.ts), otherwise
 * `completion_tokens` or `generated_tokens` as reported by the producer.
 */
export function reportedCompletionTokens(event: ObservatoryEvent): number | null {
    return (
        backendTokenCount(event) ??
        nonNegative(event.attributes.completion_tokens) ??
        nonNegative(event.attributes.generated_tokens)
    );
}

/** Producer-reported decode rate on `inference.decode.completed`: `decode_tokens_per_sec` or `backend_tokens_per_sec`. */
export function reportedDecodeRate(event: ObservatoryEvent): number | null {
    if (event.event_type !== "inference.decode.completed") {
        return null;
    }
    const n = finite(event.attributes.decode_tokens_per_sec) ?? finite(event.attributes.backend_tokens_per_sec);
    return n !== null && n > 0 ? n : null;
}

/** Cost in USD reported by the producer: `cost_usd` or `total_cost_usd`. */
export function costUsd(event: ObservatoryEvent): number | null {
    return nonNegative(event.attributes.cost_usd) ?? nonNegative(event.attributes.total_cost_usd);
}

/** Cost budget in USD declared by the producer: `cost_budget_usd` or `budget_usd`. */
export function costBudgetUsd(event: ObservatoryEvent): number | null {
    const n = finite(event.attributes.cost_budget_usd) ?? finite(event.attributes.budget_usd);
    return n !== null && n > 0 ? n : null;
}

/**
 * Used fraction on a `guard.budget_pressure` event (`used_fraction` or
 * `fraction`, as read by the budget-pressure detector).
 */
export function budgetPressureFraction(event: ObservatoryEvent): number | null {
    if (event.event_type !== "guard.budget_pressure") {
        return null;
    }
    return nonNegative(event.attributes.used_fraction) ?? nonNegative(event.attributes.fraction);
}

export type CacheLookup = "hit" | "miss";

/**
 * KV cache lookup outcome, with the convention the cache-thrash detector
 * uses: `kv.reused` is a hit and `kv.allocated` a miss (one event = one lookup).
 */
export function cacheLookup(event: ObservatoryEvent): CacheLookup | null {
    return event.event_type === "kv.reused" ? "hit" : event.event_type === "kv.allocated" ? "miss" : null;
}

/** True for a scheduled retry (`retry.scheduled`, as read by retry-storm and topology). */
export function isRetry(event: ObservatoryEvent): boolean {
    return event.event_type === "retry.scheduled";
}
