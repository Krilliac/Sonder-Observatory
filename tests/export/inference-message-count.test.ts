import { describe, expect, it } from "vitest";
import { assessExportSensitivity } from "../../src/export/sensitivity";
import type { ObservatoryEvent } from "../../src/protocol/events";
import { at } from "../helpers";

function queued(messages: unknown, overrides: Partial<ObservatoryEvent> = {}): ObservatoryEvent {
    return at(1, "request.queued", {
        producer: { name: "sonder-inference", version: "0.1.0", node_id: "test", role: "inference", synthetic: true },
        attributes: { kind: "chat", messages },
        ...overrides,
    });
}

describe("documented Inference chat message counters", () => {
    it.each([0, 1, 1024])("keeps a messages count of %s structural with capture off", (count) => {
        const events = [at(0, "session.created", { attributes: { text_capture: "off" } }), queued(count)];
        const sensitivity = assessExportSensitivity(events);
        expect(sensitivity.capturePolicy).toBe("off");
        expect(sensitivity.fullText).toBe(false);
        expect(sensitivity.sensitive).toBe(false);
    });

    it.each(["private plaintext", [{ role: "user", content: "private plaintext" }], { content: "private plaintext" }])(
        "requires acknowledgement for actual message payloads %#", (messages) => {
            expect(assessExportSensitivity([queued(messages)]).fullText).toBe(true);
        },
    );

    it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, true])(
        "retains the conservative guard for an invalid counter %#", (messages) => {
            expect(assessExportSensitivity([queued(messages)]).sensitive).toBe(true);
        },
    );

    it.each([
        { producer: { name: "other-producer", version: "1", node_id: "test" } },
        { event_type: "request.started" },
        { event_type: "request.completed" },
        { attributes: { kind: "generate", messages: 1 } },
        { attributes: { messages: 1 } },
    ])("retains numeric-payload warnings outside the documented shape %#", (overrides) => {
        expect(assessExportSensitivity([queued(1, overrides)]).sensitive).toBe(true);
    });

    it.each(["full", "on"])("keeps declared %s capture sensitive even with only counter events selected", (policy) => {
        const events = [at(0, "session.created", { attributes: { text_capture: policy } }), queued(1)];
        expect(assessExportSensitivity(events, { text: "request.queued" }).sensitive).toBe(true);
    });

    it("keeps other text attributes and unredacted tool payloads sensitive", () => {
        expect(assessExportSensitivity([queued(1, { attributes: { kind: "chat", messages: 1, prompt: "private prompt" } })]).sensitive).toBe(true);
        expect(assessExportSensitivity([queued(1), at(2, "tool.completed", { attributes: { result: 1 } })]).toolPayloads).toBe(true);
    });
});
