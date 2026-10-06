import { describe, expect, it } from "vitest";
import type { ObservatoryEvent } from "../../src/protocol/events";
import { validateEvent } from "../../src/protocol/validate";
import { derivePipeline, streamLabel } from "../../src/inference3d/derive";
import { requestLabel, requestLabelsAt } from "../../src/inference3d/labels";
import { scopedRequestKey, tupleKey } from "../../src/query/identity";
import { streamKey } from "../../src/replay/order";
import { at } from "../helpers";

const a = { name: "x", node_id: "y\u0000z", instance_id: "i", version: "test", role: "inference", synthetic: true };
const b = { ...a, name: "x\u0000y", node_id: "z" };
const event = (ms: number, type: string, producer: ObservatoryEvent["producer"] = a, extra: Partial<ObservatoryEvent> = {}) => at(ms, type, { producer, request_id: "r", ...extra });
const alts = (text: string) => ({ candidates: [{ token_id: 7, probability: 0.8, text }] });

describe("scoped 3D identities and original source labels", () => {
    it("isolates colliding producer facts, requests, pools, layers and operators", () => {
        const events = [
            event(1, "request.started"), event(2, "request.started", b),
            event(3, "kv.allocated", a, { attributes: { blocks: 2 } }),
            event(4, "kv.allocated", b, { attributes: { blocks: 3 } }),
            event(5, "backend.layer.completed", a, { attributes: { layer: 0 } }),
            event(6, "backend.layer.completed", b, { attributes: { layer: 0 } }),
            event(7, "backend.operator.completed", a, { attributes: { operator: "op|part", layer: 0 } }),
            event(8, "backend.operator.completed", b, { attributes: { operator: "op|part", layer: 0 } }),
            event(9, "request.completed"), event(10, "request.failed", b),
        ];
        for (const e of events) expect(validateEvent(e).ok).toBe(true);
        const before = JSON.stringify(events);
        const m = derivePipeline(events);
        expect(m.requests.map(r => [r.stream, r.state])).toEqual([[streamKey(events[0]!), "completed"], [streamKey(events[1]!), "failed"]]);
        expect(m.capabilities).toHaveLength(2);
        expect(m.kvPools).toHaveLength(2);
        expect(m.kvPools.map(pool => pool.usedBlocks).sort()).toEqual([2, 3]);
        expect(m.layers).toHaveLength(2);
        expect(m.operators).toHaveLength(2);
        expect(streamLabel(streamKey(events[0]!))).toBe(`${a.name} @ ${a.node_id}`);
        expect(JSON.stringify(events)).toBe(before);
    });

    it("withholds a parent link when formerly colliding Runtime streams provide two compatible candidates", () => {
        const runtimeA = { ...a, role: "runtime" };
        const runtimeB = { ...b, role: "runtime" };
        const childProducer = { ...a, name: "child-producer", instance_id: "child" };
        const events = [
            event(1, "request.started", runtimeA, { request_id: "R", run_id: "same-run" }),
            event(2, "request.started", runtimeB, { request_id: "R", run_id: "same-run" }),
            event(3, "request.started", childProducer, { request_id: "child", run_id: "same-run", attributes: { parent_request_id: "R" } }),
        ];
        const m = derivePipeline(events);
        expect(m.requests.filter(r => r.requestId === "R")).toHaveLength(2);
        expect(m.links).toEqual([]);
    });

    it("isolates requests and output tokens across pipe request boundaries", () => {
        const pa = { ...a, name: "n", node_id: "n", instance_id: "i|r" };
        const pb = { ...pa, instance_id: "i" };
        const events = [
            event(1, "inference.decode.started", pa, { request_id: "s" }),
            event(2, "inference.decode.started", pb, { request_id: "r|s" }),
            event(3, "inference.token.generated", pa, { request_id: "s", attributes: { index: 0, probability: 0.4 } }),
            event(4, "inference.token.generated", pb, { request_id: "r|s", attributes: { index: 0, probability: 0.9 } }),
            event(5, "inference.sampling.candidates", pa, { request_id: "s", attributes: { index: 0, ...alts("a") } }),
            event(6, "inference.sampling.candidates", pb, { request_id: "r|s", attributes: { index: 0, ...alts("b") } }),
        ];
        const m = derivePipeline(events);
        expect(m.requests).toHaveLength(2);
        expect(m.tokens).toHaveLength(2);
        expect(m.requests.map(r => r.outputEvents)).toEqual([1, 1]);
        expect(new Set(m.tokens.map(t => t.requestEntityId)).size).toBe(2);
        expect(m.tokens.map(t => t.probability).sort()).toEqual([0.4, 0.9]);
    });

    it("keeps a full policy from crossing a pipe stream/session boundary into an off stream", () => {
        const pa = { ...a, name: "n", node_id: "n", instance_id: "i|s" };
        const pb = { ...pa, instance_id: "i" };
        const events = [
            event(1, "session.created", pa, { session_id: "t", attributes: { text_capture: "off" } }),
            event(2, "session.created", pb, { session_id: "s|t", attributes: { text_capture: "full" } }),
            event(3, "inference.decode.started", pa, { session_id: "t" }),
            event(4, "inference.decode.started", pb, { session_id: "s|t" }),
            event(5, "inference.token.generated", pa, { session_id: "t", attributes: { text: "synthetic-off", index: 0, probability: 0.9 } }),
            event(6, "inference.sampling.candidates", pa, { session_id: "t", attributes: { index: 0, ...alts("synthetic-off-alt") } }),
            event(7, "inference.token.generated", pb, { session_id: "s|t", attributes: { text: "synthetic-full", index: 0, probability: 0.9 } }),
            event(8, "inference.sampling.candidates", pb, { session_id: "s|t", attributes: { index: 0, ...alts("synthetic-full-alt") } }),
        ];
        const prefix = derivePipeline(events.slice(0, 6));
        const m = derivePipeline(events);
        const off = m.chunks.find(c => c.eventId === events[4]!.event_id)!;
        const full = m.chunks.find(c => c.eventId === events[6]!.event_id)!;
        expect(off.text).toBeNull();
        expect(off.textWithheld).toBe(true);
        expect(full.text).toBe("synthetic-full");
        expect(m.tokens.find(t => t.eventId === events[4]!.event_id)?.alternatives?.map(v => v.text)).toEqual([null]);
        expect(m.tokens.find(t => t.eventId === events[6]!.event_id)?.alternatives?.map(v => v.text)).toEqual(["synthetic-full-alt"]);
        expect(prefix.chunks[0]?.text).toBeNull();
    });

    it("separates request-present token keys from a requestless raw string matching the canonical key", () => {
        const started = event(1, "inference.decode.started", { ...a, node_id: "n|part" });
        const present = event(2, "inference.token.generated", started.producer, { attributes: { index: 0, probability: 0.7 } });
        const presentPairing = tupleKey("token-request", scopedRequestKey(streamKey(present), "r"), "0");
        const separator = presentPairing.lastIndexOf("|");
        expect(separator).toBeGreaterThan(0);
        const legacy = event(3, "inference.sampling.candidates", b, {
            request_id: null, session_id: presentPairing.slice(0, separator),
            event_id: presentPairing.slice(separator + 1), attributes: alts("legacy"),
        });
        expect(`${legacy.session_id}|${legacy.event_id}`).toBe(presentPairing);
        expect(validateEvent(legacy).ok).toBe(true);
        const m = derivePipeline([started, present, legacy]);
        expect(m.tokens).toHaveLength(2);
        expect(m.tokens.find(t => t.requestEntityId !== null)?.alternatives).toBeNull();
        expect(m.tokens.find(t => t.requestEntityId === null)?.alternatives).toHaveLength(1);
    });

    it("preserves legacy requestless raw-session/suffix pairing across producer and delimiter boundaries", () => {
        const token = event(1, "inference.token.generated", a, { request_id: null, session_id: "s|part", event_id: "end", attributes: { probability: 0.7 } });
        const candidates = event(2, "inference.sampling.candidates", b, { request_id: null, session_id: "s", event_id: "part|end", attributes: alts("legacy") });
        const m = derivePipeline([token, candidates]);
        expect(m.tokens).toHaveLength(1);
        expect(m.tokens[0]).toMatchObject({ id: "tok:end", eventId: "end", candidatesEventId: "part|end", requestEntityId: null, probability: 0.7 });
        expect(m.tokens[0]?.alternatives).toHaveLength(1);
        const indexed = event(3, "inference.token.generated", a, { request_id: null, session_id: "s", attributes: { index: 0, probability: 0.2 } });
        const byEvent = event(4, "inference.sampling.candidates", b, { request_id: null, session_id: "s", event_id: "0", attributes: alts("event-fallback") });
        expect(derivePipeline([indexed, byEvent]).tokens).toHaveLength(1);
    });

    it.each([undefined, null, "", " ", " r "])("preserves lifecycle versus output presence rules for %j", requestId => {
        const started = event(1, "request.started", a, { request_id: requestId });
        const output = event(2, "inference.token.generated", a, { request_id: requestId, attributes: { probability: 0.9 } });
        const m = derivePipeline([started, output]);
        const hasLifecycle = requestId !== undefined && requestId !== null;
        const hasOutput = typeof requestId === "string" && requestId !== "";
        expect(m.requests).toHaveLength(hasLifecycle ? 1 : 0);
        if (hasLifecycle) expect(m.requests[0]?.requestId).toBe(requestId);
        expect(m.chunks[0]?.requestEntityId !== null).toBe(hasOutput);
        expect(m.tokens[0]?.requestEntityId !== null).toBe(hasOutput);
    });

    it.each(["", "r|literal"])("keeps facts from creating requests and observes new request evidence for %j", requestId => {
        const factsBefore = event(1, "scheduler.configured", a, { request_id: requestId, attributes: { kv_num_blocks: 12 } });
        const started = event(2, "request.started", a, { request_id: requestId, attributes: { prompt_tokens: 3 } });
        const factsAfter = event(3, "scheduler.configured", a, { request_id: requestId, attributes: { prompt_tokens: 7 } });
        expect(derivePipeline([factsBefore]).requests).toEqual([]);
        const m = derivePipeline([factsBefore, started, factsAfter]);
        expect(m.requests).toHaveLength(1);
        expect(m.requests[0]).toMatchObject({
            requestId, startNs: started.mono_ns, lastNs: factsAfter.mono_ns,
            lastEventId: factsAfter.event_id, promptTokens: 7,
            evidence: [started.event_id, factsAfter.event_id],
        });
        expect(m.kvPools[0]?.totalBlocks).toBe(12);
    });

    it("keeps unrelated events out of request evidence across repeated cursor calls", () => {
        const started = event(1, "request.started", a, { attributes: { prompt_tokens: 3 } });
        const unrelated = event(2, "engine.metrics", a, { attributes: { prompt_tokens: 999 } });
        const events = [started, unrelated];
        const before = JSON.stringify(events);
        const early = derivePipeline(events, { nowNs: started.mono_ns });
        const later = derivePipeline(events);
        expect(later.requests[0]).toMatchObject({
            lastNs: started.mono_ns, lastEventId: started.event_id,
            promptTokens: 3, evidence: [started.event_id],
        });
        expect(derivePipeline(events, { nowNs: started.mono_ns })).toEqual(early);
        expect(JSON.stringify(events)).toBe(before);
    });

    it("distinguishes an unattached output from attached-but-unavailable source evidence", () => {
        const source = event(1, "inference.token.generated", a, { request_id: "original|source" });
        const key = scopedRequestKey(streamKey(source), source.request_id!);
        const refs = [{ eventId: source.event_id, requestEntityId: key }];
        const available = requestLabelsAt([source], refs, source.mono_ns);
        expect(requestLabel(key, available)).toBe("original|source");
        const missing = requestLabelsAt([], refs, source.mono_ns);
        expect(requestLabel(key, missing)).toBe("request evidence unavailable");
        expect(requestLabel(null, available)).toBe("no request");
        expect(requestLabel(null, missing)).toBe("no request");
        expect(requestLabel(key, requestLabelsAt([source], refs, source.mono_ns - 1))).toBe("request evidence unavailable");
        const candidate = event(2, "inference.sampling.candidates", a, { request_id: "original|source", attributes: { index: 0, ...alts("synthetic-candidate") } });
        const candidateOnly = [{ eventId: "missing-output", candidatesEventId: candidate.event_id, requestEntityId: key }];
        expect(requestLabel(key, requestLabelsAt([candidate], candidateOnly, candidate.mono_ns))).toBe("original|source");
        const wrongId = [{ ...candidateOnly[0]!, candidatesEventId: "different-candidate" }];
        expect(requestLabel(key, requestLabelsAt([candidate], wrongId, candidate.mono_ns))).toBe("request evidence unavailable");
        const foreign = { ...candidate, producer: b };
        expect(requestLabel(key, requestLabelsAt([foreign], candidateOnly, foreign.mono_ns))).toBe("request evidence unavailable");
        const wrongRequest = { ...candidate, request_id: "different-request" };
        expect(requestLabel(key, requestLabelsAt([wrongRequest], candidateOnly, wrongRequest.mono_ns))).toBe("request evidence unavailable");
        expect(requestLabel(key, requestLabelsAt([candidate], candidateOnly, candidate.mono_ns - 1))).toBe("request evidence unavailable");
    });

    it("resolves chunk/token labels for an omitted finished request from cursor-visible source evidence", () => {
        const events = [
            event(1, "request.started", a, { request_id: "old|original" }),
            event(2, "inference.token.generated", a, { request_id: "old|original", attributes: { probability: 0.9 } }),
            event(3, "request.completed", a, { request_id: "old|original" }),
        ];
        for (let i = 0; i < 120; i++) {
            events.push(event(4 + 2 * i, "request.started", a, { request_id: `r${i}` }));
            events.push(event(5 + 2 * i, "request.completed", a, { request_id: `r${i}` }));
        }
        const m = derivePipeline(events);
        expect(m.omittedFinished).toBe(1);
        expect(m.requests.some(r => r.requestId === "old|original")).toBe(false);
        const refs = [...m.chunks, ...m.tokens];
        const key = m.chunks[0]!.requestEntityId!;
        expect(requestLabelsAt(events, refs, m.nowNs).get(key)).toBe("old|original");
        expect(requestLabelsAt([], refs, m.nowNs).get(key)).toBeUndefined();
        expect(requestLabelsAt(events, refs, events[0]!.mono_ns).get(key)).toBeUndefined();
        const future = { ...events[1]!, mono_ns: (m.nowNs ?? 0) + 1 };
        expect(requestLabelsAt([future], refs, m.nowNs).get(key)).toBeUndefined();
        const foreign = { ...events[1]!, producer: b };
        expect(requestLabelsAt([foreign], refs, m.nowNs).get(key)).toBeUndefined();
        expect(m.chunks[0]?.id).toBe(`chunk:${events[1]!.event_id}`);
        expect(m.tokens[0]?.id).toBe(`tok:${events[1]!.event_id}`);
    });
});
