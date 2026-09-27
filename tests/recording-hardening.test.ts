import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assessExportSensitivity } from "../src/export/sensitivity";
import type { ObservatoryEvent } from "../src/protocol/events";
import { buildManifest } from "../src/recording/sobs";
import { at } from "./helpers";

function fixture(name: string): ObservatoryEvent[] {
    const text = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
    return text
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as ObservatoryEvent);
}

describe("recording manifest for real producers", () => {
    it("marks a finished Sonder-Inference recording complete and records its capture policy", () => {
        // Inference opens sessions with session.created and ends them with
        // session.closed; engine-scoped events end with engine.stopped.
        const m = buildManifest(fixture("sonder-inference-912503a.jsonl"));
        expect(m.complete).toBe(true);
        expect(m.capture_policy).toBe("off");
    });

    it("ignores producer housekeeping (telemetry.dropped) when judging completeness", () => {
        const m = buildManifest(fixture("sonder-inference-b2170c0.jsonl"));
        expect(m.complete).toBe(true);
        expect(m.capture_policy).toBe("unspecified");
    });

    it("still marks a session without an end event incomplete", () => {
        const events = fixture("sonder-inference-912503a.jsonl").filter((e) => e.event_type !== "session.closed");
        expect(buildManifest(events).complete).toBe(false);
        expect(buildManifest([at(0, "session.started"), at(1, "x")]).complete).toBe(false);
    });
});

describe("export sensitivity for Sonder-Inference text capture", () => {
    function token(text: unknown): ObservatoryEvent {
        return at(1, "inference.token.generated", { request_id: "r", attributes: { index: 0, unit: "chunk", text } });
    }

    it("treats captured token text (attributes.text) as plaintext", () => {
        const a = assessExportSensitivity([token("my secret prompt answer")]);
        expect(a.fullText).toBe(true);
        expect(a.sensitive).toBe(true);
    });

    it("does not flag redacted or absent token text", () => {
        expect(assessExportSensitivity([token("[redacted]")]).sensitive).toBe(false);
        expect(assessExportSensitivity([at(1, "inference.token.generated", { attributes: { index: 0 } })]).sensitive).toBe(false);
    });

    it("treats prompt or response text on any event as plaintext", () => {
        expect(assessExportSensitivity([at(1, "request.started", { attributes: { prompt: "hello" } })]).fullText).toBe(true);
        expect(assessExportSensitivity([at(1, "request.completed", { attributes: { response: "hi" } })]).fullText).toBe(true);
        expect(assessExportSensitivity([at(1, "request.completed", { attributes: { messages: [{ role: "user", content: "x" }] } })]).fullText).toBe(true);
    });
});
