import { describe, expect, it } from "vitest";
import { buildManifest, loadRecording } from "../../src/recording/sobs";
import { loadRecordingChunked, loadRecordingStream } from "../../src/renderer/chunkedLoad";
import { generateEvents } from "../../scripts/gen-large-fixture.mjs";

const immediate = () => Promise.resolve();

function messyRecording(): string {
    const events = [...generateEvents(3_000, 11)];
    const lines = [JSON.stringify(buildManifest(events, new Date("2026-09-26T08:00:00Z")))];
    events.forEach((e, i) => {
        lines.push(JSON.stringify(e));
        if (i === 10) lines.push("{not json");
        if (i === 500) lines.push("");
        if (i === 1_200) lines.push(JSON.stringify({ ...e, event_id: "" }));
        if (i === 2_000) lines.push(lines[0]!); // a second manifest is rejected
        if (i === 2_500) lines.push(JSON.stringify({ ...e, event_id: "evt_unicode_✓", attributes: { note: "héllo wörld ✓ 日本 🚀" } }));
    });
    // Mix CRLF and LF line endings.
    return lines.map((l, i) => (i % 7 === 0 ? `${l}\r\n` : `${l}\n`)).join("");
}

function byteStream(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
    let pos = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (pos >= bytes.length) {
                controller.close();
                return;
            }
            controller.enqueue(bytes.slice(pos, pos + size));
            pos += size;
        },
    });
}

describe("loadRecordingChunked", () => {
    const text = messyRecording();
    const expected = loadRecording(text);

    it.each([1, 97, 4_096, 65_536, 10_000_000])("matches loadRecording with %i-char slices", async (chunkChars) => {
        const got = await loadRecordingChunked(text, { chunkChars, yieldToEventLoop: immediate });
        expect(got.manifest).toEqual(expected.manifest);
        expect(got.events).toEqual(expected.events);
        expect(got.rejected).toEqual(expected.rejected);
    });

    it("adapts slice size, yields between slices and reports monotonic progress", async () => {
        let yields = 0;
        const seen: number[] = [];
        const got = await loadRecordingChunked(text, {
            initialChunkChars: 32 * 1024,
            yieldToEventLoop: async () => {
                yields += 1;
            },
            onProgress: (p) => seen.push(p.bytesDone),
        });
        expect(got.events.length).toBe(expected.events.length);
        expect(yields).toBe(seen.length - 1);
        expect(seen.at(-1)).toBe(text.length);
        expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    });

    it("stops when aborted", async () => {
        const controller = new AbortController();
        const promise = loadRecordingChunked(text, {
            chunkChars: 4_096,
            signal: controller.signal,
            yieldToEventLoop: async () => controller.abort(),
        });
        await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    });

    it("delegates ZIP containers to the synchronous loader", async () => {
        const got = await loadRecordingChunked("PK\u0003\u0004...");
        expect(got).toEqual(loadRecording("PK\u0003\u0004..."));
    });

    it("yields with the default scheduler in Node", async () => {
        const small = text.slice(0, 200_000);
        const cut = small.slice(0, small.lastIndexOf("\n") + 1);
        const got = await loadRecordingChunked(cut, { chunkChars: 50_000 });
        expect(got.events).toEqual(loadRecording(cut).events);
    });

    it.each([1, 7, 4_093, 1_000_000])("streams bytes in %i-byte reads with the same result", async (size) => {
        const bytes = new TextEncoder().encode(text);
        let lastProgress = 0;
        const got = await loadRecordingStream(byteStream(bytes, size), {
            yieldToEventLoop: immediate,
            totalBytes: bytes.length,
            onProgress: (p) => {
                lastProgress = p.bytesDone;
            },
        });
        expect(got.manifest).toEqual(expected.manifest);
        expect(got.events).toEqual(expected.events);
        expect(got.rejected).toEqual(expected.rejected);
        expect(lastProgress).toBe(bytes.length);
    }, 60_000);

    it("streams a file without a trailing newline and detects ZIP containers", async () => {
        const noTrail = text.trimEnd();
        const got = await loadRecordingStream(byteStream(new TextEncoder().encode(noTrail), 999), { yieldToEventLoop: immediate });
        expect(got.events).toEqual(loadRecording(noTrail).events);
        const zip = await loadRecordingStream(byteStream(new TextEncoder().encode("PK\u0003\u0004rest"), 3));
        expect(zip.rejected[0]!.reason).toMatch(/ZIP/);
    });
});
