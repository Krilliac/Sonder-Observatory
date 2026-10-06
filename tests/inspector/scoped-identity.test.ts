import { describe, expect, it } from "vitest";
import { relatedGroups, type RelatedGroup } from "../../src/inspector/related";
import { orderEvents } from "../../src/replay/order";
import { SessionStore } from "../../src/replay/session";
import type { ObservatoryEvent } from "../../src/protocol/events";
import { at } from "../helpers";

const runtime = { name: "sonder-runtime", version: "test", node_id: "n", instance_id: "rt", role: "runtime", synthetic: true };
const inference = { ...runtime, name: "sonder-inference", instance_id: "inf", role: "inference" };
const parent = () => at(1, "request.started", { producer: runtime, request_id: "R", run_id: "run" });
const own = (ms: number, extra: Partial<ObservatoryEvent> = {}) => at(ms, "inference.token.generated", {
    producer: inference, request_id: "child", run_id: "run", ...extra,
});
const lifecycle = (ms: number) => own(ms, { event_type: "request.queued", attributes: { parent_request_id: "R" } });
const group = (groups: RelatedGroup[], kind: RelatedGroup["kind"]) => groups.find(g => g.kind === kind);

function checkRows(selected: ObservatoryEvent, events: readonly ObservatoryEvent[], expected: readonly ObservatoryEvent[], parents: readonly ObservatoryEvent[] = []) {
    const before = JSON.stringify({ selected, events });
    for (const limit of [0, 1, 25]) {
        const groups = relatedGroups(selected, events, limit);
        for (const [kind, rows] of [["request", expected], ["parent", parents]] as const) {
            const actual = group(groups, kind);
            if (rows.length === 0) {
                expect(actual).toBeUndefined();
            } else {
                expect(actual?.total).toBe(rows.length);
                expect(actual?.events).toEqual(rows.slice(0, limit));
                actual?.events.forEach((event, i) => expect(event).toBe(rows[i]));
            }
        }
    }
    expect(JSON.stringify({ selected, events })).toBe(before);
}

describe("producer-scoped request identity on immutable marked and unmarked inputs", () => {
    it("keeps unmarked input order and duplicate occurrences while marked input keeps its own deduplicated order", () => {
        const root = parent();
        const queued = lifecycle(2);
        const selected = own(3);
        const tail = own(4);
        const sameId = { ...selected, attributes: { unit: "token" } };
        const foreign = own(5, { producer: { ...inference, instance_id: "foreign" }, attributes: { parent_request_id: "foreign-root" } });
        const input = Object.freeze([tail, root, queued, tail, selected, sameId, foreign]);
        checkRows(selected, input, [tail, queued, tail], [root]);
        const marked = orderEvents(input).events;
        checkRows(selected, marked, [queued, tail], [root]);
        expect(relatedGroups(selected, marked)).toEqual(relatedGroups(selected, Object.freeze([...marked])));
    });

    it("includes an outside selection's lineage facts without adding it to request rows", () => {
        const root = parent();
        const queued = lifecycle(2);
        const token = own(3);
        const selected = own(90, { attributes: { parent_request_id: "different-root" } });
        const events = orderEvents([root, queued, token]).events;
        for (const input of [events, Object.freeze([...events])]) {
            checkRows(selected, input, [queued, token]);
            const absent = own(91, { request_id: "absent", attributes: { parent_request_id: "R" } });
            checkRows(absent, input, [], [root]);
        }
    });

    it.each(["parent", "run"])("withholds early conflicting %s facts without losing later request rows", conflict => {
        const root = parent();
        const queued = lifecycle(2);
        const selected = own(3);
        const conflicting = own(4, conflict === "parent" ? { attributes: { parent_request_id: "other" } } : { run_id: "other" });
        const tail = Array.from({ length: 40 }, (_, i) => own(5 + i));
        const events = orderEvents([root, queued, selected, conflicting, ...tail]).events;
        for (const input of [events, Object.freeze([...events])]) {
            checkRows(selected, input, [queued, conflicting, ...tail]);
        }
    });

    it.each([undefined, null, "", " ", " child "])("preserves the literal request ID %j", requestId => {
        const root = parent();
        const queued = own(2, { request_id: requestId, attributes: { parent_request_id: "R" } });
        const selected = own(3, { request_id: requestId });
        const trimmed = lifecycle(4);
        const foreign = own(5, { request_id: requestId, producer: { ...inference, name: "foreign-producer" } });
        const events = orderEvents([root, queued, selected, trimmed, foreign]).events;
        const hasRequest = typeof requestId === "string" && requestId !== "";
        for (const input of [events, Object.freeze([...events])]) {
            checkRows(selected, input, hasRequest ? [queued] : [], hasRequest ? [root] : []);
        }
    });

    it("preserves explicit and inferred stream identity while excluding foreign producers, nodes and instances", () => {
        const selected = own(20);
        const explicit = own(2, { session_id: "another-session" });
        const inferred = own(3, { producer: { ...inference, instance_id: undefined }, event_id: "inf-3", sequence: 3 });
        const foreign = [
            own(4, { producer: { ...inference, name: "foreign" } }),
            own(5, { producer: { ...inference, node_id: "foreign" } }),
            own(6, { producer: { ...inference, instance_id: "foreign" } }),
            own(7, { producer: { ...inference, instance_id: undefined }, event_id: "foreign-7", sequence: 7 }),
        ];
        const events = orderEvents([explicit, inferred, ...foreign, selected]).events;
        for (const input of [events, Object.freeze([...events])]) {
            checkRows(selected, input, [explicit, inferred]);
        }
    });

    it("separates schema-admitted embedded delimiters across producer fields", () => {
        const selected = own(3, { producer: { ...inference, name: "x", node_id: "y\u0000z", instance_id: "i" }, request_id: "r\u0000s" });
        const collision = own(2, { producer: { ...inference, name: "x\u0000y", node_id: "z", instance_id: "i" }, request_id: "r\u0000s" });
        const sameStream = own(4, { producer: selected.producer, request_id: selected.request_id });
        const other = own(5, { producer: { ...selected.producer, instance_id: "different" }, request_id: "r\u0000s" });
        const events = orderEvents([collision, selected, sameStream, other]).events;
        for (const input of [events, Object.freeze([...events])]) {
            checkRows(selected, input, [sameStream]);
        }
    });

    it("does not leak later lifecycle or run conflicts into older immutable cursor prefixes", () => {
        const root = parent();
        const queued = lifecycle(2);
        const selected = own(3, { run_id: null });
        const conflict = own(4, { run_id: "other" });
        const store = new SessionStore();
        store.reset("live", "synthetic request-prefix control");
        store.append([root]);
        const beforeLifecycle = store.events;
        checkRows(selected, beforeLifecycle, []);
        store.append([queued]);
        const beforeConflict = store.events;
        checkRows(selected, beforeConflict, [queued], [root]);
        store.append([selected, conflict]);
        checkRows(selected, store.events, [queued, conflict]);
        for (const input of [beforeLifecycle, Object.freeze([...beforeLifecycle])]) {
            checkRows(selected, input, []);
        }
        for (const input of [beforeConflict, Object.freeze([...beforeConflict])]) {
            checkRows(selected, input, [queued], [root]);
        }
        const visible = store.events.slice(0, 2);
        checkRows(selected, visible, [queued], [root]);
        store.reset("file", "synthetic replacement without lifecycle");
        store.append([root, selected]);
        checkRows(selected, store.events, []);
        checkRows(selected, beforeConflict, [queued], [root]);
    });
});
