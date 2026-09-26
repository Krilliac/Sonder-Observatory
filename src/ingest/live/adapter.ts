/**
 * Adapter hook between the wire and the protocol validator.
 *
 * An adapter receives each decoded JSON value before envelope validation and
 * returns the value(s) to validate: the same value, a rewritten one, several
 * events, or null/undefined to skip it (for example a producer control
 * record). This is where a producer-specific shape mapping plugs in, such as
 * the Sonder-Inference adapter the integrator is writing (see
 * docs/telemetry-schema.md and docs/integration/live-ingest.md).
 */
export type EventAdapter = (value: unknown) => unknown | readonly unknown[] | null | undefined;

export const identityAdapter: EventAdapter = (value) => value;

/** Runs adapters left to right; each output value feeds the next adapter. */
export function composeAdapters(...adapters: EventAdapter[]): EventAdapter {
    return (value) => {
        let current: unknown[] = [value];
        for (const adapter of adapters) {
            const next: unknown[] = [];
            for (const item of current) {
                next.push(...normalizeAdapted(adapter(item)));
            }
            current = next;
        }
        return current;
    };
}

export function normalizeAdapted(result: unknown | readonly unknown[] | null | undefined): unknown[] {
    if (result === null || result === undefined) {
        return [];
    }
    return Array.isArray(result) ? [...(result as readonly unknown[])] : [result];
}
