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
        this.initialMs = Math.max(0, options.initialMs ?? 250);
        this.maxMs = Math.max(this.initialMs, options.maxMs ?? 10_000);
        this.factor = Math.max(1, options.factor ?? 2);
        this.jitter = Math.min(1, Math.max(0, options.jitter ?? 0.3));
        this.random = options.random ?? Math.random;
    }

    /** Returns the next delay in ms and advances the attempt counter. */
    next(): number {
        const base = Math.min(this.maxMs, this.initialMs * this.factor ** this.attempt);
        this.attempt += 1;
        const spread = base * this.jitter;
        return Math.round(base - spread + this.random() * spread);
    }

    reset(): void {
        this.attempt = 0;
    }
}
