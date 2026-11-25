/**
 * Fixed-capacity FIFO ring buffer with optional byte budget and drop accounting.
 *
 * The live client pushes decoded events here as they arrive and drains them
 * in batches into the session store. When the consumer falls behind and the
 * buffer exceeds either its item capacity or its estimated byte budget, events
 * are dropped according to the overflow policy and counted; nothing is dropped
 * silently.
 */
export type OverflowPolicy = "drop-oldest" | "drop-newest";

export interface BoundedBufferOptions<T> {
    /** Maximum estimated bytes held in the buffer. Default Infinity (count-only). */
    maxBytes?: number;
    /** Byte-size estimator for each item when `maxBytes` is finite. */
    sizeOf?: (item: T) => number;
}

export class BoundedBuffer<T> {
    readonly capacity: number;
    readonly policy: OverflowPolicy;
    readonly maxBytes: number;
    private readonly sizeOf: ((item: T) => number) | null;
    private readonly slots: (T | undefined)[];
    private readonly sizes: number[];
    private head = 0;
    private length = 0;
    private totalBytes = 0;
    /** Total items discarded because the buffer was full (count or bytes). */
    dropped = 0;

    constructor(capacity: number, policy: OverflowPolicy = "drop-oldest", options: BoundedBufferOptions<T> = {}) {
        if (!Number.isInteger(capacity) || capacity < 1) {
            throw new RangeError("buffer capacity must be a positive integer");
        }
        const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
        if (maxBytes !== Number.POSITIVE_INFINITY && (!Number.isFinite(maxBytes) || maxBytes < 1)) {
            throw new RangeError("buffer maxBytes must be a positive number");
        }
        this.capacity = capacity;
        this.policy = policy;
        this.maxBytes = maxBytes;
        this.sizeOf = Number.isFinite(maxBytes) ? (options.sizeOf ?? (() => 1)) : null;
        this.slots = new Array<T | undefined>(capacity);
        this.sizes = new Array<number>(capacity).fill(0);
    }

    get size(): number {
        return this.length;
    }

    /** Estimated bytes currently buffered (0 when no byte budget is configured). */
    get bytes(): number {
        return this.totalBytes;
    }

    /** Adds an item. Returns false when one or more items (old or new) were dropped. */
    push(item: T): boolean {
        let itemBytes = 0;
        if (this.sizeOf) {
            const estimated = this.sizeOf(item);
            if (!Number.isFinite(estimated)) {
                this.dropped += 1;
                return false;
            }
            itemBytes = Math.max(0, estimated);
            if (itemBytes > this.maxBytes) {
                this.dropped += 1;
                return false;
            }
        }
        if (this.policy === "drop-newest") {
            if (this.length >= this.capacity || (this.sizeOf && this.totalBytes + itemBytes > this.maxBytes)) {
                this.dropped += 1;
                return false;
            }
            const tail = (this.head + this.length) % this.capacity;
            this.slots[tail] = item;
            this.sizes[tail] = itemBytes;
            this.length += 1;
            this.totalBytes += itemBytes;
            return true;
        }
        // drop-oldest: evict oldest items until both count and byte budgets have room.
        let droppedAny = false;
        while (
            this.length >= this.capacity ||
            (this.sizeOf && this.length > 0 && this.totalBytes + itemBytes > this.maxBytes)
        ) {
            this.slots[this.head] = undefined;
            this.totalBytes = Math.max(0, this.totalBytes - this.sizes[this.head]!);
            this.sizes[this.head] = 0;
            this.head = (this.head + 1) % this.capacity;
            this.length -= 1;
            this.dropped += 1;
            droppedAny = true;
        }
        const tail = (this.head + this.length) % this.capacity;
        this.slots[tail] = item;
        this.sizes[tail] = itemBytes;
        this.length += 1;
        this.totalBytes += itemBytes;
        return !droppedAny;
    }

    /** Removes and returns up to `max` items in FIFO order. */
    drain(max: number = this.length): T[] {
        const limit = Number.isNaN(max) ? 0 : Math.max(0, Math.floor(max));
        const n = Math.min(limit, this.length);
        const out: T[] = new Array<T>(n);
        for (let i = 0; i < n; i += 1) {
            const index = (this.head + i) % this.capacity;
            out[i] = this.slots[index] as T;
            this.slots[index] = undefined;
            this.totalBytes = Math.max(0, this.totalBytes - this.sizes[index]!);
            this.sizes[index] = 0;
        }
        this.head = (this.head + n) % this.capacity;
        this.length -= n;
        if (this.length === 0) {
            this.totalBytes = 0;
        }
        return out;
    }

    clear(): void {
        this.drain();
    }
}
