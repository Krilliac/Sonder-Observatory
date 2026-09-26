import type { ObservatoryEvent } from "../src/protocol/events";

let counter = 0;

/** Builds a schema-valid event for tests; override any field. */
export function makeEvent(overrides: Partial<ObservatoryEvent> = {}): ObservatoryEvent {
    counter += 1;
    return {
        schema: "sonder.observatory.event/1",
        event_id: `evt_test_${counter}`,
        sequence: counter,
        event_type: "test.event",
        wall_time: "2026-09-26T08:00:00.000Z",
        mono_ns: counter * 1_000_000,
        session_id: "ses_test",
        producer: { name: "test-producer", version: "0.0.0", node_id: "n1" },
        attributes: {},
        ...overrides,
    };
}

/** Event at a given millisecond offset with contiguous sequence numbers. */
export function at(ms: number, eventType: string, extra: Partial<ObservatoryEvent> = {}): ObservatoryEvent {
    return makeEvent({ mono_ns: ms * 1_000_000, sequence: ms, event_id: `evt_${eventType}_${ms}`, event_type: eventType, ...extra });
}
