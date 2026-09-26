/**
 * Fixed-capacity FIFO ring buffer with drop accounting.
 *
 * The live client pushes decoded events here as they arrive and drains them
 * in batches into the session store. When the consumer falls behind and the
 * buffer is full, events are dropped according to the overflow policy and
 * counted; nothing is dropped silently.
 */
export type OverflowPolicy = "drop-oldest" | "drop-newest";

export class BoundedBuffer<T> {
    readonly capacity: number;
    readonly policy: OverflowPolicy;
    private readonly slots: (T | undefined)[];
    private head = 0;
    private length = 0;
    /** Total items discarded because the buffer was full. */
    dropped = 0;

    constructor(capacity: number, policy: OverflowPolicy = "drop-oldest") {
        if (!Number.isInteger(capacity) || capacity < 1) {
            throw new RangeError("buffer capacity must be a positive integer");
        }
        this.capacity = capacity;
        this.policy = policy;
        this.slots = new Array<T | undefined>(capacity);
    }

    get size(): number {
        return this.length;
    }

    /** Adds an item. Returns false when an item (old or new) was dropped. */
    push(item: T): boolean {
        if (this.length < this.capacity) {
            this.slots[(this.head + this.length) % this.capacity] = item;
            this.length += 1;
            return true;
        }
        this.dropped += 1;
        if (this.policy === "drop-newest") {
            return false;
        }
        // drop-oldest: overwrite the head slot and advance.
        this.slots[this.head] = item;
        this.head = (this.head + 1) % this.capacity;
        return false;
    }

    /** Removes and returns up to `max` items in FIFO order. */
    drain(max: number = this.length): T[] {
        const n = Math.min(Math.max(0, Math.floor(max)), this.length);
        const out: T[] = new Array<T>(n);
        for (let i = 0; i < n; i += 1) {
            const index = (this.head + i) % this.capacity;
            out[i] = this.slots[index] as T;
            this.slots[index] = undefined;
        }
        this.head = (this.head + n) % this.capacity;
        this.length -= n;
        return out;
    }

    clear(): void {
        this.drain();
    }
}
