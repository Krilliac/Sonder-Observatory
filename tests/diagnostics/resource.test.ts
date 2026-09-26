import { describe, expect, it } from "vitest";
import { syntheticStream } from "../../src/diagnostics/fixtures";
import { assertEvidence, detect, getCase } from "./helpers";

describe("resource-pressure detector", () => {
    it("reports the VRAM episode and the kv.pressure event", () => {
        const c = getCase("resource-pressure", "positive");
        const f = detect("resource-pressure", c.events);
        assertEvidence(f, c.events);
        const vram = f.find((x) => x.provenance === "derived")!;
        expect(vram.severity).toBe("critical");
        expect(vram.evidenceEventIds).toHaveLength(3);
        expect(vram.facts.scope).toBe("dev_gpu0/vram");
        const kv = f.find((x) => x.provenance === "producer-reported")!;
        expect(kv.severity).toBe("critical");
    });

    it("accepts used_fraction samples and configurable thresholds", () => {
        const e = syntheticStream("res_frac");
        const events = [e(0, "device.memory.sample", { used_fraction: 0.82, kind: "ram" }, { device_id: "host" })];
        expect(detect("resource-pressure", events)).toEqual([]);
        const f = detect("resource-pressure", events, { resource: { warnFraction: 0.8 } });
        expect(f).toHaveLength(1);
        expect(f[0]!.severity).toBe("warning");
    });

    it("kv.pressure without occupancy is still a warning (the producer asserted pressure)", () => {
        const e = syntheticStream("res_kv");
        expect(detect("resource-pressure", [e(0, "kv.pressure", {})])[0]!.severity).toBe("warning");
    });

    it("negative case: no findings", () => {
        expect(detect("resource-pressure", getCase("resource-pressure", "negative").events)).toEqual([]);
    });
});
