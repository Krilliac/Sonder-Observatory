/**
 * Parity of every pre-existing metric on the existing fixtures (M1
 * synthetic, regressed, Sonder-Inference, 3D-view and fixture:large
 * sessions) across the prompt-cache / speculation change: deriveMetrics and
 * metricsAt, with the additive fields removed, hash to the values recorded on
 * main 0da5916 before the change. None of these streams carry the new
 * attributes, so their new aggregates are empty.
 *
 * A deliberate change to an existing metric must update these digests (print
 * `digest(...)` for the fixture) and say why in the commit.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateEvents } from "../../scripts/gen-large-fixture.mjs";
import { regressFixtureEvents } from "../../scripts/generate-fixture-regressed.mjs";
import { deepSyntheticFixture, ollamaPoolFixture } from "../../src/inference3d/fixtures";
import type { ObservatoryEvent } from "../../src/protocol/events";
import { deriveMetrics, type Metrics } from "../../src/query/metrics";
import { MetricsIndex } from "../../src/query/metricsIndex";
import { parseNdjson } from "../../src/recording/ndjson";
import { orderEvents } from "../../src/replay/order";

/** Metrics without the fields added for prompt-cache and speculation reports. */
function preexisting(m: Metrics): unknown {
    const omit = (o: object, keys: readonly string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
    return {
        ...omit(m, ["promptCache", "speculation"]),
        requests: m.requests.map((span) => omit(span, ["sessionId", "model", "promptCache", "speculation"])),
    };
}

const digest = (m: Metrics) => createHash("sha256").update(JSON.stringify(preexisting(m))).digest("hex").slice(0, 16);
const root = new URL("../../", import.meta.url);
const read = (p: string) => orderEvents(parseNdjson(readFileSync(new URL(p, root), "utf8")).events).events;

/** [name, events, full digest, digests at 10%, 33%, 50%, 77% of the events]. */
function cases(): [string, () => readonly ObservatoryEvent[], string, string[]][] {
    const m1 = () => read("fixtures/synthetic-session.ndjson");
    const large = (n: number, seed?: number) => () => orderEvents([...generateEvents(n, seed)] as ObservatoryEvent[]).events;
    return [
        ["synthetic", m1, "9c3c1514c6e4bd64", ["f28f6fd04f7c89cf", "825a9ee4398b59bd", "e6ad3586206c4b31", "fabc6bef5d77f71a"]],
        ["regressed", () => orderEvents(regressFixtureEvents(m1()) as ObservatoryEvent[]).events, "8a2dbeb0d0064b11", ["43536f385be593f4", "9540a0f432fbafe9", "fb88c8dc0ce3e988", "c1c6d928af84826e"]],
        ["inference b2170c0", () => read("tests/fixtures/sonder-inference-b2170c0.jsonl"), "a38c3c0b169f8b2a", ["8aa9b288440efb80", "26571e9719897e91", "e1dd8fad288bc273", "de6dd7922d73ea37"]],
        ["inference 912503a", () => read("tests/fixtures/sonder-inference-912503a.jsonl"), "82d13ecda806a3f5", ["6540b15e04f3c333", "23391eb6eec9d726", "1937988a6bd504e5", "c339c30c4ae632d6"]],
        ["ollama pool", () => orderEvents(ollamaPoolFixture()).events, "a4844e02b65a71b2", ["e5e7882a2fa737ce", "a0a2045fa542283e", "7ec3fb43f86aa185", "823231d0381201be"]],
        ["deep synthetic", () => orderEvents(deepSyntheticFixture()).events, "dde87e8e8610a5e8", ["a8ba597651408381", "0641ed3787695a97", "570dbd7900e58fac", "f61c9c1a99956066"]],
        ["fixture:large 10k", large(10_000), "da5e5a62db3f82ef", ["571e4f1e3223e1f8", "f460afcc27f928d3", "fd032b9a30279c29", "f685848619318e51"]],
        ["fixture:large 40k seed 5", large(40_000, 5), "e8014d3bb79d54cb", ["b198df0985e5aae2", "d1f6db6382b7b7d4", "220f2377ff6817a2", "97a816fe625ec603"]],
        ["fixture:large 100k", large(100_000), "5c28e54db8f496b8", ["d1f77959ae5bb33e", "eb05e6e117fd8d3e", "490f8ea0e1637613", "500a8663008d1168"]],
    ];
}

describe("existing metrics are unchanged on streams without the new fields", () => {
    for (const [name, load, full, prefixes] of cases()) {
        it(name, () => {
            const events = load();
            const m = deriveMetrics(events);
            expect(digest(m)).toBe(full);
            const index = new MetricsIndex(events);
            expect(digest(index.at(events.length))).toBe(full);
            expect([0.1, 0.33, 0.5, 0.77].map((f) => digest(index.at(Math.floor(events.length * f))))).toEqual(prefixes);
            expect(m.promptCache.requests).toBe(0);
            expect(m.speculation.requests).toBe(0);
            expect(m.requests.every((r) => r.promptCache === null && r.speculation === null)).toBe(true);
        });
    }
});
