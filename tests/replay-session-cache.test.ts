import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/replay/session";
import { at } from "./helpers";

const real = { name: "sonder-runtime", version: "1", node_id: "n1" };
const synthetic = { ...real, name: "fixture", synthetic: true };

describe("SessionStore per-array caches", () => {
    it("synthetic and capturePolicy follow every append and reset", () => {
        const store = new SessionStore();
        store.reset("live", "test");
        expect(store.synthetic).toBe(false);
        expect(store.capturePolicy).toBe("unspecified");
        store.append([at(1, "session.started", { producer: real, attributes: { text_capture: "off" } })]);
        expect(store.synthetic).toBe(false);
        expect(store.capturePolicy).toBe("off");
        expect(store.capturePolicy).toBe("off");
        store.append([at(2, "session.created", { producer: synthetic, attributes: { text_capture: "redacted" } })]);
        expect(store.synthetic).toBe(true);
        expect(store.capturePolicy).toBe("off,redacted");
        store.reset("file", "other", { synthetic: true } as never);
        expect(store.synthetic).toBe(true);
        expect(store.capturePolicy).toBe("unspecified");
    });
});
