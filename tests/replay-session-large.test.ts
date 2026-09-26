import { describe, expect, it } from "vitest";
import type { RejectedLine } from "../src/recording/ndjson";
import { SessionStore } from "../src/replay/session";
import { makeEvent } from "./helpers";

// SessionStore used to spread its argument into push(), which throws
// "Maximum call stack size exceeded" for very large recordings.
describe("SessionStore with very large inputs", () => {
    it("appends 300k events and 300k rejected lines in one call", () => {
        const n = 300_000;
        const events = Array.from({ length: n }, (_, i) => makeEvent({ event_id: `e${i}`, sequence: i, mono_ns: i }));
        const rejected: RejectedLine[] = Array.from({ length: n }, (_, i) => ({ line: i + 1, reason: "synthetic", raw: "" }));
        const store = new SessionStore();
        store.reset("file", "large");
        expect(() => store.append(events)).not.toThrow();
        expect(() => store.addRejected(rejected)).not.toThrow();
        expect(store.events).toHaveLength(n);
        expect(store.rejected).toHaveLength(n);
        expect(store.events[n - 1]!.event_id).toBe(`e${n - 1}`);
    });
});
