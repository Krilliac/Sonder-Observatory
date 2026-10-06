import { describe, expect, it, vi } from "vitest";
import { createIdentityKeys, producerStreamKey, scopedRequestKey, scopedSessionKey } from "../src/query/identity";
import { makeEvent } from "./helpers";

describe("call-local identity keys", () => {
    it("preserves native bytes for hostile literal fields, modes and repeated values", () => {
        const literals = ["", " ", "\u0000", "\u0001", "|", '"', "\\", "\r\n\t", "é", "e\u0301", "😀", "\ud800"];
        const keys = createIdentityKeys();
        for (const literal of literals) {
            for (const known of [false, true]) {
                const e = makeEvent({ event_id: "no-instance-suffix", session_id: literal, producer: {
                    name: literal, version: "test", node_id: literal, instance_id: known ? `i${literal}` : null,
                } });
                const before = JSON.stringify(e);
                const expected = producerStreamKey(e);
                for (let repeat = 0; repeat < 3; repeat += 1) {
                    expect(keys.stream(e)).toBe(expected);
                    expect(keys.request(expected, literal)).toBe(scopedRequestKey(expected, literal));
                    expect(keys.session(expected, literal)).toBe(scopedSessionKey(expected, literal));
                }
                expect(JSON.stringify(e)).toBe(before);
            }
        }
    });

    it("recomputes instance inference from event fields and never caches an event object", () => {
        const keys = createIdentityKeys();
        const e = makeEvent({ event_id: "i-2", sequence: 2, session_id: "s", producer: {
            name: "n", version: "test", node_id: "node", instance_id: null,
        } });
        const inferred = keys.stream(e);
        for (const eventId of ["i-02", "i-3", "i-\n2", "plain", "other-2", "i-2"]) {
            e.event_id = eventId;
            expect(keys.stream(e)).toBe(producerStreamKey(e));
        }
        e.sequence = 3;
        expect(keys.stream(e)).toBe(producerStreamKey(e));
        e.producer.instance_id = "i";
        e.session_id = "other session";
        expect(keys.stream(e)).toBe(inferred);
        e.producer.name = "different";
        expect(keys.stream(e)).toBe(producerStreamKey(e));
        e.producer.node_id = "other node";
        expect(keys.stream(e)).toBe(producerStreamKey(e));
        e.producer.instance_id = "";
        expect(keys.stream(e)).toBe(producerStreamKey(e));
    });

    it("shares explicit/inferred identities across sessions, while separating fallback mode", () => {
        const keys = createIdentityKeys();
        const e = makeEvent({ event_id: "i-2", sequence: 2, session_id: "s1", producer: {
            name: "n", version: "test", node_id: "node", instance_id: "i",
        } });
        const inferred = { ...e, session_id: "s2", producer: { ...e.producer, instance_id: undefined } };
        const fallback = { ...inferred, event_id: "plain", session_id: "i" };
        const expected = producerStreamKey(e);
        const spy = vi.spyOn(JSON, "stringify");
        try {
            expect(keys.stream(e)).toBe(expected);
            expect(keys.stream(inferred)).toBe(expected);
            expect(spy).toHaveBeenCalledTimes(1);
            expect(keys.stream(fallback)).not.toBe(expected);
            expect(spy).toHaveBeenCalledTimes(2);
            expect(keys.stream(e)).toBe(expected);
            expect(spy).toHaveBeenCalledTimes(3);
        } finally {
            spy.mockRestore();
        }
    });

    it("holds only the last tuple and keeps request/session and composer lifetimes separate", () => {
        const keys = createIdentityKeys();
        const expectedRequest = scopedRequestKey("stream", "");
        const expectedSession = scopedSessionKey("stream", "");
        const spy = vi.spyOn(JSON, "stringify");
        try {
            expect(keys.request("stream", "")).toBe(expectedRequest);
            expect(keys.request("stream", "")).toBe(expectedRequest);
            expect(keys.session("stream", "")).toBe(expectedSession);
            expect(keys.session("stream", "")).toBe(expectedSession);
            expect(spy).toHaveBeenCalledTimes(2);
            keys.request("other", "");
            expect(keys.request("stream", "")).toBe(expectedRequest);
            expect(spy).toHaveBeenCalledTimes(4);
            expect(createIdentityKeys().request("stream", "")).toBe(expectedRequest);
            expect(spy).toHaveBeenCalledTimes(5);
        } finally {
            spy.mockRestore();
        }
    });

    it.each(["request", "session"] as const)("uses stateless %s fallback at the retained-data cap without limiting output", kind => {
        const compose = kind === "request" ? scopedRequestKey : scopedSessionKey;
        const keys = createIdentityKeys();
        const admitted = "x".repeat(Math.floor((16_384 - compose("", "").length) / 2));
        const oversized = admitted + "x";
        const expected = compose("", oversized);
        const spy = vi.spyOn(JSON, "stringify");
        try {
            keys[kind]("", admitted);
            keys[kind]("", admitted);
            expect(spy).toHaveBeenCalledTimes(1);
            expect(keys[kind]("", oversized)).toBe(expected);
            expect(keys[kind]("", oversized)).toBe(expected);
            expect(spy).toHaveBeenCalledTimes(3);
            keys[kind]("", admitted);
            expect(spy).toHaveBeenCalledTimes(4);
        } finally {
            spy.mockRestore();
        }
    });

    it("does not retain oversized producer scopes and restores small-scope correctness", () => {
        const keys = createIdentityKeys();
        const small = makeEvent({ producer: { name: "n", version: "test", node_id: "node", instance_id: "i" } });
        const big = { ...small, producer: { ...small.producer, node_id: "\\".repeat(16_384) } };
        const expected = producerStreamKey(big);
        const spy = vi.spyOn(JSON, "stringify");
        try {
            keys.stream(small);
            keys.stream(small);
            expect(spy).toHaveBeenCalledTimes(1);
            expect(keys.stream(big)).toBe(expected);
            expect(keys.stream(big)).toBe(expected);
            expect(spy).toHaveBeenCalledTimes(3);
            keys.stream(small);
            expect(spy).toHaveBeenCalledTimes(4);
        } finally {
            spy.mockRestore();
        }
    });
});
