import { describe, expect, it } from "vitest";
import { ollamaPoolFixture } from "../../src/inference3d/fixtures";
import { UpdateMemo } from "../../src/inference3d/inference3dPanel";

describe("3D panel update memo", () => {
    const input = (all: ReturnType<typeof ollamaPoolFixture>) => ({ all, visible: all, nowNs: all[all.length - 1]!.mono_ns, healthStamp: "" });

    it("skips an identical update", () => {
        const memo = new UpdateMemo();
        const events = ollamaPoolFixture();
        expect(memo.changed(input(events))).toBe(true);
        expect(memo.changed(input(events))).toBe(false);
    });

    it("re-derives when another version of the same recording loads (same ids, times and count)", () => {
        const memo = new UpdateMemo();
        const original = ollamaPoolFixture();
        // A redacted copy: identical envelope ids, timestamps and length; only attribute values differ.
        const redacted = original.map((e) => (typeof e.attributes.text === "string" ? { ...e, attributes: { ...e.attributes, text: "[redacted]" } } : { ...e }));
        expect(redacted.length).toBe(original.length);
        expect(memo.changed(input(original))).toBe(true);
        expect(memo.changed(input(redacted))).toBe(true);
    });

    it("re-derives after invalidate (theme change)", () => {
        const memo = new UpdateMemo();
        const events = ollamaPoolFixture();
        memo.changed(input(events));
        memo.invalidate();
        expect(memo.changed(input(events))).toBe(true);
    });
});
