import { describe, expect, it } from "vitest";
import { parseNdjson, toNdjson } from "../src/recording/ndjson";
import { buildManifest, loadRecording, RECORDING_FORMAT, serializeRecording } from "../src/recording/sobs";
import { at, makeEvent } from "./helpers";

describe("parseNdjson", () => {
    it("skips blank lines, accepts CRLF and reports bad lines with line numbers", () => {
        const good = JSON.stringify(makeEvent());
        const text = `${good}\r\n\r\nnot json\r\n{"schema":"x"}\r\n`;
        const r = parseNdjson(text);
        expect(r.events).toHaveLength(1);
        expect(r.rejected.map((x) => x.line)).toEqual([3, 4]);
        expect(r.rejected[0]!.reason).toMatch(/invalid JSON/);
        expect(r.rejected[1]!.reason).toMatch(/schema/);
    });

    it("round-trips through toNdjson", () => {
        const events = [makeEvent(), makeEvent()];
        expect(parseNdjson(toNdjson(events)).events).toEqual(events);
        expect(toNdjson([])).toBe("");
    });
});

describe(".sobs recording", () => {
    const events = [
        at(0, "session.started", { run_id: "run1", attributes: { text_capture: "none" }, sampling: { level: "standard" } }),
        at(5, "telemetry.dropped", { attributes: { dropped_count: 2 } }),
        at(9, "session.ended"),
    ];

    it("builds a manifest describing the recording without inventing policy", () => {
        const m = buildManifest(events, new Date("2026-09-26T09:00:00Z"));
        expect(m).toMatchObject({
            format: RECORDING_FORMAT,
            created_at: "2026-09-26T09:00:00.000Z",
            complete: true,
            event_count: 3,
            schema_versions: ["sonder.observatory.event/1"],
            session_ids: ["ses_test"],
            run_ids: ["run1"],
            sampling_levels: ["standard"],
            capture_policy: "none",
            dropped_events: 2,
            synthetic: false,
        });
        expect(m.time_origin).toEqual({ wall_time: events[0]!.wall_time, mono_ns: 0 });
        expect(buildManifest([at(1, "x")]).capture_policy).toBe("unspecified");
        expect(buildManifest([at(1, "x")]).complete).toBe(false);
    });

    it("serializes manifest-first and loads back losslessly", () => {
        const text = serializeRecording(events, new Date("2026-09-26T09:00:00Z"));
        expect(JSON.parse(text.split("\n")[0]!).format).toBe(RECORDING_FORMAT);
        const loaded = loadRecording(text);
        expect(loaded.rejected).toEqual([]);
        expect(loaded.manifest?.event_count).toBe(3);
        expect(loaded.events).toEqual(events);
    });

    it("loads a bare NDJSON event log without a manifest", () => {
        const loaded = loadRecording(toNdjson(events));
        expect(loaded.manifest).toBeNull();
        expect(loaded.events).toHaveLength(3);
    });

    it("rejects a manifest that is not on line 1 and ZIP containers", () => {
        const text = `${JSON.stringify(events[0])}\n${JSON.stringify({ format: RECORDING_FORMAT })}\n`;
        const loaded = loadRecording(text);
        expect(loaded.manifest).toBeNull();
        expect(loaded.rejected[0]!.line).toBe(2);
        expect(loadRecording("PK\u0003\u0004...").rejected[0]!.reason).toMatch(/ZIP/);
    });

    it("sums the latest cumulative drop count per producer instance", () => {
        const inf = (instance: string) => ({ name: "sonder-inference", version: "0.1.0", node_id: "vm", instance_id: instance, role: "inference" });
        const drop = (ms: number, instance: string, seq: number, n: number) =>
            at(ms, "telemetry.dropped", {
                producer: inf(instance),
                sequence: seq,
                event_id: `${instance}-${seq}`,
                attributes: { dropped_events: n },
            });
        expect(buildManifest([drop(1, "tel-a", 0, 5), drop(2, "tel-a", 1, 7)]).dropped_events).toBe(7);
        expect(buildManifest([drop(1, "tel-a", 0, 5), drop(2, "tel-a", 1, 7), drop(3, "tel-b", 0, 4)]).dropped_events).toBe(11);
        // A report with no count no longer counts as 1.
        expect(buildManifest([at(1, "telemetry.dropped")]).dropped_events).toBe(0);
    });

    it("records each producer's role", () => {
        const m = buildManifest([
            makeEvent({ producer: { name: "sonder-runtime", version: "1", node_id: "h", role: "runtime" } }),
            makeEvent({ producer: { name: "sonder-inference", version: "1", node_id: "h" } }),
            makeEvent({ producer: { name: "sonder-inference", version: "1", node_id: "h", role: "inference", synthetic: true } }),
            makeEvent(),
        ]);
        expect(m.producers.map((p) => [p.name, p.role, p.synthetic])).toEqual([
            ["sonder-runtime", "runtime", false],
            ["sonder-inference", "inference", true],
            ["test-producer", null, false],
        ]);
    });

    it("flags synthetic producers", () => {
        const syn = makeEvent({ producer: { name: "fx", version: "1", node_id: "n", synthetic: true } });
        expect(buildManifest([syn]).synthetic).toBe(true);
        expect(buildManifest([syn]).producers[0]!.synthetic).toBe(true);
    });
});
