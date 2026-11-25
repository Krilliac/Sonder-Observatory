/**
 * Reconnect delay schedule: exponential growth with bounded jitter.
 *
 * delay(n) = min(maxMs, initialMs * factor^n), then scaled into
 * [delay * (1 - jitter), delay] so many viewers reconnecting to one producer
 * after a restart do not all retry in lockstep.
 */
export interface BackoffOptions {
    /** First retry delay in ms. Default 250. */
    initialMs?: number;
    /** Upper bound for any delay in ms. Default 10000. */
    maxMs?: number;
    /** Growth factor per attempt. Default 2. */
    factor?: number;
    /** Fraction of the delay that is randomized, 0..1. Default 0.3. */
    jitter?: number;
    /** Random source in [0, 1); injectable for deterministic tests. */
    random?: () => number;
}

export class Backoff {
    private readonly initialMs: number;
    private readonly maxMs: number;
    private readonly factor: number;
    private readonly jitter: number;
    private readonly random: () => number;
    /** Number of delays handed out since the last reset. */
    attempt = 0;

    constructor(options: BackoffOptions = {}) {
        const rawInitial = options.initialMs ?? 250;
        this.initialMs = Number.isFinite(rawInitial) ? Math.max(0, rawInitial) : 250;
        const rawMax = options.maxMs ?? 10_000;
        this.maxMs = Number.isFinite(rawMax) ? Math.max(this.initialMs, rawMax) : Math.max(this.initialMs, 10_000);
        const rawFactor = options.factor ?? 2;
        this.factor = Number.isFinite(rawFactor) ? Math.max(1, rawFactor) : 2;
        const rawJitter = options.jitter ?? 0.3;
        this.jitter = Number.isFinite(rawJitter) ? Math.min(1, Math.max(0, rawJitter)) : 0.3;
        this.random = options.random ?? Math.random;
    }

    /** Returns the next delay in ms and advances the attempt counter. */
    next(): number {
        const scaled = this.initialMs === 0 ? 0 : this.initialMs * this.factor ** this.attempt;
        const base = Math.min(this.maxMs, Number.isFinite(scaled) ? scaled : this.maxMs);
        this.attempt += 1;
        const spread = base * this.jitter;
        const rawRand = this.random();
        const rand = Number.isFinite(rawRand) ? Math.min(1, Math.max(0, rawRand)) : 0;
        return Math.round(base - spread + rand * spread);
    }

    reset(): void {
        this.attempt = 0;
    }
}
