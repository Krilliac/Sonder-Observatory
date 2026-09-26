import type { ObservatoryEvent } from "../protocol/events";
import { producerInstance } from "../query/attributes";

/**
 * Stream identity: sequence numbers are monotonic per producer stream. When
 * the event reveals the producer instance that assigned the sequence (see
 * `producerInstance`), the stream is that instance, across sessions:
 * Sonder-Inference numbers engine- and session-scoped events from one counter.
 * Otherwise the stream is session + producer name + node.
 */
export function streamKey(event: ObservatoryEvent): string {
    const instance = producerInstance(event);
    if (instance !== null) {
        return `${event.producer.name}\u0000${event.producer.node_id}\u0000#${instance}`;
    }
    return `${event.session_id}\u0000${event.producer.name}\u0000${event.producer.node_id}`;
}

/**
 * Total replay order: monotonic clock, then per-stream sequence, then
 * event_id as a deterministic tie-breaker.
 *
 * Milestone 1 assumes producers in one session share a monotonic time base
 * (true for a single local producer). Cross-node clock alignment is deferred
 * to the distributed milestone; see docs/ROADMAP.md.
 */
export function compareEvents(a: ObservatoryEvent, b: ObservatoryEvent): number {
    if (a.mono_ns !== b.mono_ns) {
        return a.mono_ns - b.mono_ns;
    }
    if (a.sequence !== b.sequence) {
        return a.sequence - b.sequence;
    }
    return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
}

export interface SequenceGap {
    stream: string;
    /** First missing sequence number. */
    from: number;
    /** Last missing sequence number. */
    to: number;
}

export interface OrderedEvents {
    events: ObservatoryEvent[];
    /** Events whose event_id was already seen (for example after a reconnect). */
    duplicates: number;
    gaps: SequenceGap[];
}

/**
 * Deduplicates by event_id (first occurrence wins), sorts into replay order
 * and reports per-stream sequence gaps, which indicate possible dropped or
 * missing telemetry. Does not mutate the input.
 */
export function orderEvents(input: readonly ObservatoryEvent[]): OrderedEvents {
    const seen = new Set<string>();
    const events: ObservatoryEvent[] = [];
    let duplicates = 0;
    for (const event of input) {
        if (seen.has(event.event_id)) {
            duplicates += 1;
            continue;
        }
        seen.add(event.event_id);
        events.push(event);
    }
    events.sort(compareEvents);
    return { events, duplicates, gaps: findSequenceGaps(events) };
}

export function findSequenceGaps(events: readonly ObservatoryEvent[]): SequenceGap[] {
    const byStream = new Map<string, number[]>();
    for (const e of events) {
        const key = streamKey(e);
        const list = byStream.get(key) ?? [];
        list.push(e.sequence);
        byStream.set(key, list);
    }
    const gaps: SequenceGap[] = [];
    for (const [stream, sequences] of byStream) {
        const sorted = [...new Set(sequences)].sort((x, y) => x - y);
        for (let i = 1; i < sorted.length; i += 1) {
            const prev = sorted[i - 1]!;
            const cur = sorted[i]!;
            if (cur > prev + 1) {
                gaps.push({ stream, from: prev + 1, to: cur - 1 });
            }
        }
    }
    return gaps;
}
