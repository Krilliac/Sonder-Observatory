import { describe, expect, it, vi } from "vitest";
import type { ProducerConnection } from "../../src/ingest/live/manager";
import type { LiveIngestStatus } from "../../src/ingest/live/client";
import { relatedGroups } from "../../src/inspector/related";
import { isErrorEvent } from "../../src/query/classify";
import { brandSvgMarkup } from "../../src/renderer/brand";
import {
    connectionAdvice,
    describeProbe,
    MAX_RECENT_ENDPOINTS,
    parseRecentEndpoints,
    rememberEndpoint,
    type RecentEndpoint,
} from "../../src/renderer/connectionPanel";
import { dragHasFiles, recordingFileProblem } from "../../src/renderer/dropZone";
import { errorSearchStart, findMatching, listText, producersInSession, syntheticBannerText, timelineSummaryText } from "../../src/renderer/navigation";
import { presetLine, probePresets } from "../../src/renderer/onboarding";
import { parseLaunchParams, secretParamWarning, urlWithoutSecrets } from "../../src/renderer/params";
import { producerCardModel, shortInstance } from "../../src/renderer/producersPanel";
import { isTypingTarget, SHORTCUTS, shortcutAction } from "../../src/renderer/shortcuts";
import { clampSplit, readSplit, SPLIT_DEFAULT, SPLIT_MAX, SPLIT_MIN, splitForKey, writeSplit } from "../../src/renderer/splitter";
import { otherTheme, parseTheme, readStoredTheme, resolveTheme, THEME_STORAGE_KEY, toggleLabel, writeStoredTheme } from "../../src/renderer/theme";
import { eventSearchText } from "../../src/renderer/virtualWindow";
import { at, makeEvent } from "../helpers";

class MemoryStorage {
    data = new Map<string, string>();
    getItem(k: string) {
        return this.data.get(k) ?? null;
    }
    setItem(k: string, v: string) {
        this.data.set(k, v);
    }
    removeItem(k: string) {
        this.data.delete(k);
    }
}
const throwing = {
    getItem: () => {
        throw new Error("blocked");
    },
    setItem: () => {
        throw new Error("blocked");
    },
    removeItem: () => {
        throw new Error("blocked");
    },
} as unknown as Storage;

function status(overrides: Partial<LiveIngestStatus> = {}): LiveIngestStatus {
    return {
        state: "open",
        url: "http://127.0.0.1:11437/v1/telemetry/sse",
        transport: "sse",
        loopback: true,
        warning: null,
        attempts: 1,
        reconnects: 0,
        retryInMs: null,
        lastEventId: null,
        resumeRequested: false,
        received: 12,
        appended: 12,
        dropped: 1,
        rejected: 0,
        buffered: 3,
        bufferCapacity: 20000,
        batches: 2,
        lastError: null,
        ...overrides,
    };
}

function connection(overrides: Partial<ProducerConnection> = {}): ProducerConnection {
    return {
        id: "producer-1",
        url: "http://127.0.0.1:11437",
        label: null,
        hasToken: false,
        streamUrl: "http://127.0.0.1:11437/v1/telemetry/sse",
        discovery: null,
        identity: { name: "sonder-inference", version: "0.3.0", node_id: "host", instance_id: "tel-0123456789abcdef", role: "inference", synthetic: true },
        status: status(),
        ...overrides,
    };
}

describe("URL parameters", () => {
    it("collects repeatable ?connect and the legacy ?ws alias, dropping duplicates", () => {
        const p = parseLaunchParams(new URLSearchParams("connect=http://a/&connect=http://b/&ws=http://a/&theme=light&view=events"));
        expect(p.connect).toEqual(["http://a/", "http://b/"]);
        expect(p.fixture).toBe(false);
        expect(p.theme).toBe("light");
        expect(p.view).toBe("events");
        expect(p.ignoredSecrets).toEqual([]);
    });

    it("loads the fixture unless ?fixture=0 or a connect URL is given", () => {
        expect(parseLaunchParams(new URLSearchParams("")).fixture).toBe(true);
        expect(parseLaunchParams(new URLSearchParams("fixture=0")).fixture).toBe(false);
        expect(parseLaunchParams(new URLSearchParams("theme=blue")).theme).toBeNull();
    });

    it("ignores token parameters with a warning and strips them from the URL", () => {
        const p = parseLaunchParams(new URLSearchParams("token=abc&access_token=def"));
        expect(p.ignoredSecrets).toEqual(["token", "access_token"]);
        const warning = secretParamWarning(p.ignoredSecrets)!;
        expect(warning).toContain('"token" and "access_token"');
        expect(warning).not.toContain("abc");
        expect(secretParamWarning([])).toBeNull();
        expect(urlWithoutSecrets("http://h/?fixture=0&token=abc&x=1")).toBe("http://h/?fixture=0&x=1");
        expect(urlWithoutSecrets("http://h/?fixture=0")).toBeNull();
        expect(urlWithoutSecrets("not a url")).toBeNull();
    });
});

describe("theme", () => {
    it("resolves param, then saved choice, then the system preference", () => {
        expect(resolveTheme({ param: "light", stored: "dark", prefersDark: true })).toBe("light");
        expect(resolveTheme({ param: null, stored: "light", prefersDark: true })).toBe("light");
        expect(resolveTheme({ param: null, stored: null, prefersDark: false })).toBe("light");
        expect(resolveTheme({ param: null, stored: null, prefersDark: true })).toBe("dark");
        expect(parseTheme("dark")).toBe("dark");
        expect(parseTheme("sepia")).toBeNull();
        expect(otherTheme("dark")).toBe("light");
        expect(toggleLabel("dark").text).toBe("Light theme");
    });

    it("stores the choice and survives blocked storage", () => {
        const s = new MemoryStorage() as unknown as Storage;
        writeStoredTheme(s, "light");
        expect(s.getItem(THEME_STORAGE_KEY)).toBe("light");
        expect(readStoredTheme(s)).toBe("light");
        expect(readStoredTheme(throwing)).toBeNull();
        expect(() => writeStoredTheme(throwing, "dark")).not.toThrow();
        expect(readStoredTheme(null)).toBeNull();
    });
});

describe("shortcuts", () => {
    const input = { tagName: "INPUT", type: "text" };
    it("maps keys to actions", () => {
        expect(shortcutAction({ key: "?" })).toBe("help");
        expect(shortcutAction({ key: " ", target: { tagName: "DIV" } })).toBe("play-pause");
        expect(shortcutAction({ key: "j" })).toBe("next-event");
        expect(shortcutAction({ key: "K" })).toBe("previous-event");
        expect(shortcutAction({ key: "]" })).toBe("next-error");
        expect(shortcutAction({ key: "[" })).toBe("previous-error");
        expect(shortcutAction({ key: "/" })).toBe("focus-filter");
        expect(shortcutAction({ key: "f" })).toBe("follow-latest");
        expect(shortcutAction({ key: "t" })).toBe("toggle-theme");
        expect(shortcutAction({ key: "x" })).toBeNull();
        // Every action in the dialog is reachable.
        expect(new Set(SHORTCUTS.map((s) => s.action)).size).toBe(SHORTCUTS.length);
    });

    it("is off while typing, with modifiers, and for Space on native controls", () => {
        expect(shortcutAction({ key: "t", target: input })).toBeNull();
        expect(shortcutAction({ key: "t", target: { tagName: "TEXTAREA" } })).toBeNull();
        expect(shortcutAction({ key: "t", target: { tagName: "SELECT" } })).toBeNull();
        expect(shortcutAction({ key: "t", target: { tagName: "DIV", isContentEditable: true } })).toBeNull();
        expect(shortcutAction({ key: "t", ctrlKey: true })).toBeNull();
        expect(shortcutAction({ key: "j", metaKey: true })).toBeNull();
        expect(shortcutAction({ key: " ", target: { tagName: "BUTTON" } })).toBeNull();
        expect(shortcutAction({ key: " ", target: { tagName: "DIV", getAttribute: () => "tab" } })).toBeNull();
        // A checkbox or range is not a text field: letters still work there.
        expect(isTypingTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
        expect(shortcutAction({ key: "t", target: { tagName: "INPUT", type: "range" } })).toBe("toggle-theme");
        expect(isTypingTarget({ tagName: "INPUT", type: "password" })).toBe(true);
        expect(isTypingTarget(null)).toBe(false);
    });
});

describe("splitter", () => {
    it("clamps and moves with the keyboard", () => {
        expect(clampSplit(10)).toBe(SPLIT_MIN);
        expect(clampSplit(99)).toBe(SPLIT_MAX);
        expect(clampSplit(Number.NaN)).toBe(SPLIT_DEFAULT);
        expect(splitForKey("ArrowRight", 60)).toBe(65);
        expect(splitForKey("ArrowLeft", 60)).toBe(55);
        expect(splitForKey("Home", 60)).toBe(SPLIT_MIN);
        expect(splitForKey("End", 60)).toBe(SPLIT_MAX);
        expect(splitForKey("x", 60)).toBeNull();
    });

    it("persists per viewer, tolerating blocked storage", () => {
        const s = new MemoryStorage() as unknown as Storage;
        expect(readSplit(s)).toBe(SPLIT_DEFAULT);
        writeSplit(s, 70);
        expect(readSplit(s)).toBe(70);
        expect(readSplit(throwing)).toBe(SPLIT_DEFAULT);
        expect(() => writeSplit(throwing, 50)).not.toThrow();
    });
});

describe("drop zone", () => {
    it("accepts recordings only", () => {
        for (const name of ["a.sobs", "b.NDJSON", "c.jsonl", "d.json"]) {
            expect(recordingFileProblem(name)).toBeNull();
        }
        expect(recordingFileProblem("notes.txt")).toMatch(/not a recording/);
        expect(dragHasFiles(["text/plain", "Files"])).toBe(true);
        expect(dragHasFiles(["text/uri-list"])).toBe(false);
        expect(dragHasFiles(undefined)).toBe(false);
    });
});

describe("recent endpoints", () => {
    it("keeps the most recent eight, deduplicated, never with credentials or tokens", () => {
        let list: RecentEndpoint[] = [];
        for (let i = 0; i < 10; i += 1) {
            list = rememberEndpoint(list, { url: `http://127.0.0.1:${9000 + i}`, transport: "auto" });
        }
        expect(list).toHaveLength(MAX_RECENT_ENDPOINTS);
        expect(list[0]!.url).toBe("http://127.0.0.1:9009");
        list = rememberEndpoint(list, { url: "http://127.0.0.1:9005", transport: "sse" });
        expect(list[0]).toEqual({ url: "http://127.0.0.1:9005", transport: "sse" });
        expect(list.filter((e) => e.url === "http://127.0.0.1:9005")).toHaveLength(1);
        expect(rememberEndpoint([], { url: "http://127.0.0.1:1/sse?token=abc", transport: "auto" })).toEqual([]);
        expect(rememberEndpoint([], { url: "http://user:pw@127.0.0.1:1/", transport: "auto" })).toEqual([]);
    });

    it("parses stored lists defensively", () => {
        expect(parseRecentEndpoints(null)).toEqual([]);
        expect(parseRecentEndpoints("{not json")).toEqual([]);
        expect(parseRecentEndpoints('{"url":"x"}')).toEqual([]);
        const raw = JSON.stringify([
            { url: "http://127.0.0.1:11435", transport: "ndjson", token: "leak" },
            { url: "http://127.0.0.1:11435", transport: "sse" },
            { url: "http://127.0.0.1:1/?access_token=x" },
            { url: 5 },
            { url: "ws://127.0.0.1:8766/ws", transport: "carrier-pigeon" },
        ]);
        expect(parseRecentEndpoints(raw)).toEqual([
            { url: "http://127.0.0.1:11435", transport: "ndjson" },
            { url: "ws://127.0.0.1:8766/ws", transport: "auto" },
        ]);
    });
});

describe("connection guidance", () => {
    it("names the token step and the CORS settings", () => {
        expect(connectionAdvice("the producer requires a bearer token; add one", false)).toMatch(/needs a token/);
        expect(connectionAdvice("HTTP 401: the producer requires a bearer token", true)).toMatch(/rejected this token/);
        expect(connectionAdvice("could not reach x (Failed to fetch)", false, true)).toMatch(/SONDER_CORS_ORIGINS.*--cors-origin/);
        expect(connectionAdvice("could not reach x; Sonder-Inference takes --cors-origin o", false, true)).toBeNull();
        expect(connectionAdvice("HTTP 404", false)).toBeNull();
    });

    it("describes probe results", () => {
        const discovery = {
            schema: "sonder.telemetry.producer/1",
            producer: { name: "sonder-runtime", version: "1.2.3", node_id: "box", instance_id: "rt-abc", role: "runtime", synthetic: false },
            event_schema: "sonder.observatory.event/1",
            streams: [
                { transport: "sse", url: "/v1/observability/events" },
                { transport: "ndjson", url: "/v1/observability/events?format=ndjson" },
            ],
            resume: { header: "Last-Event-ID", query: "last_event_id", retained_events: 42, oldest_sequence: 0, next_sequence: 42 },
            auth: { required: true, schemes: ["bearer"] },
            clock: { mono_ns: "host-monotonic" },
        } as never;
        const ok = describeProbe("http://127.0.0.1:11435", { ok: true, discovery, streamUrl: "http://127.0.0.1:11435/v1/observability/events", error: null, corsSuspected: false }, false);
        expect(ok.ok).toBe(true);
        expect(ok.lines.join(" ")).toMatch(/Found sonder-runtime 1\.2\.3 \(role runtime\).*Streams: sse, ndjson.*bearer token required \(enter it under Bearer token\).*Retained events: 42/);
        const direct = describeProbe("http://h/sse", { ok: true, discovery: null, streamUrl: "http://h/sse", error: null, corsSuspected: false }, false);
        expect(direct.lines[0]).toMatch(/no discovery document/);
        const bad = describeProbe("http://h/", { ok: false, discovery: null, streamUrl: null, error: "could not reach http://h/", corsSuspected: true }, false);
        expect(bad.ok).toBe(false);
        expect(bad.lines[1]).toMatch(/SONDER_CORS_ORIGINS/);
    });
});

describe("producer cards", () => {
    it("maps client states to the contract state words and actions", () => {
        const live = producerCardModel(connection());
        expect(live).toMatchObject({ producer: "sonder-inference", state: "live", role: "inference", version: "0.3.0", instance: "tel-01234567…", transport: "sse", synthetic: true, actions: ["disconnect"] });
        expect(live.counters).toEqual([
            ["received", "12"],
            ["appended", "12"],
            ["dropped", "1"],
            ["rejected", "0"],
            ["buffered", "3/20000"],
            ["reconnects", "0"],
        ]);
        expect(producerCardModel(connection({ status: status({ state: "connecting" }) })).state).toBe("connecting");
        expect(producerCardModel(connection({ status: status({ state: "reconnecting" }) })).state).toBe("reconnecting");
        expect(producerCardModel(connection({ status: status({ state: "closed" }) })).state).toBe("disconnected");
        expect(producerCardModel(connection(), true)).toMatchObject({ state: "disconnected", actions: ["reconnect", "remove"] });
        expect(producerCardModel(connection({ hasToken: true }), true).actions).toEqual(["edit", "remove"]);
    });

    it("explains failures and falls back to the URL before identity is known", () => {
        const failed = producerCardModel(
            connection({ identity: null, status: status({ state: "failed", lastError: "the producer requires a bearer token; add one to this connection" }) }),
        );
        expect(failed).toMatchObject({ producer: "", title: "127.0.0.1:11437", state: "failed", actions: ["edit", "remove"], synthetic: false });
        expect(failed.advice).toMatch(/needs a token/);
        expect(shortInstance(null)).toBe("—");
        expect(shortInstance("rt-abc")).toBe("rt-abc");
    });
});

describe("navigation", () => {
    const events = [at(1, "request.started"), at(2, "tool.failed"), at(3, "x.y"), at(4, "request.failed"), at(5, "x.z")];

    it("finds next and previous errors from the selection or the cursor", () => {
        expect(findMatching(events, errorSearchStart(-1, 0, 1), 1, isErrorEvent)).toBe(1);
        expect(findMatching(events, errorSearchStart(1, 5, 1), 1, isErrorEvent)).toBe(3);
        expect(findMatching(events, errorSearchStart(3, 5, -1), -1, isErrorEvent)).toBe(1);
        expect(findMatching(events, errorSearchStart(-1, 5, -1), -1, isErrorEvent)).toBe(3);
        expect(findMatching(events, errorSearchStart(1, 5, -1), -1, isErrorEvent)).toBe(-1);
        expect(findMatching(events, errorSearchStart(3, 5, 1), 1, isErrorEvent)).toBe(-1);
    });

    it("summarises producers and names the synthetic ones", () => {
        const mixed = [
            makeEvent({ producer: { name: "b", version: "1", node_id: "n", role: "runtime" } }),
            makeEvent({ producer: { name: "a", version: "1", node_id: "n", synthetic: true } }),
            makeEvent({ producer: { name: "b", version: "1", node_id: "n" } }),
        ];
        const summary = producersInSession(mixed);
        expect(summary).toEqual([
            { name: "a", role: null, synthetic: true, events: 1 },
            { name: "b", role: "runtime", synthetic: false, events: 2 },
        ]);
        expect(producersInSession(mixed)).toBe(summary); // cached per array
        expect(listText(["a", "b", "c"])).toBe("a, b and c");
        expect(listText([])).toBe("");
        expect(syntheticBannerText(["x", "y"])).toMatch(/^Synthetic data from x and y:/);
        expect(syntheticBannerText([])).toMatch(/^Synthetic data:/);
    });

    it("writes a text alternative for the timeline", () => {
        expect(timelineSummaryText({ total: 0, visible: 0, cursorSeconds: 0, durationSeconds: 0, classCounts: [], errors: 0, requests: 0, selected: null })).toBe("Timeline: no events yet.");
        const text = timelineSummaryText({
            total: 10,
            visible: 4,
            cursorSeconds: 1.5,
            durationSeconds: 3,
            classCounts: [
                ["request", 3],
                ["tool", 0],
                ["error", 1],
            ],
            errors: 1,
            requests: 2,
            selected: { eventType: "tool.failed", producer: "rt", seconds: 1.25 },
        });
        expect(text).toBe(
            "Timeline: 10 events over 3.000 s; cursor at 1.500 s with 4 events at or before it. By class: request 3, error 1. 2 request span(s), 1 error event(s). Selected: tool.failed from rt at 1.250 s.",
        );
    });

    it("the event filter matches run_id and producer name", () => {
        const e = makeEvent({ run_id: "Run_42", request_id: "req_1", producer: { name: "Sonder-Runtime", version: "1", node_id: "n" } });
        const text = eventSearchText(e);
        expect(text).toContain("run_42");
        expect(text).toContain("sonder-runtime");
        expect(text).toContain("req_1");
    });
});

describe("related groups (contract 8.4)", () => {
    const rt = { name: "sonder-runtime", version: "1", node_id: "n" };
    const inf = { name: "sonder-inference", version: "1", node_id: "n" };
    const turnStart = at(1, "request.started", { request_id: "R", run_id: "R", producer: rt });
    const turnEnd = at(9, "request.completed", { request_id: "R", run_id: "R", producer: rt });
    const childQueued = at(2, "request.queued", { request_id: "inf-1", run_id: "R", producer: inf, attributes: { parent_request_id: "R", kind: "chat" } });
    const childToken = at(3, "inference.token.generated", { request_id: "inf-1", run_id: "R", producer: inf });
    const unrelated = at(4, "x.y", { request_id: "other", run_id: "other", producer: inf });
    const all = [turnStart, childQueued, childToken, unrelated, turnEnd];

    it("links child requests across producers and groups the run", () => {
        const groups = relatedGroups(turnEnd, all);
        expect(groups.map((g) => g.kind)).toEqual(["request", "children", "run"]);
        expect(groups[0]!.events).toEqual([turnStart]);
        expect(groups[1]!.events).toEqual([childQueued, childToken]);
        expect(groups[1]!.value).toBe("inf-1");
        expect(groups[2]!.events.map((e) => e.producer.name)).toEqual(["sonder-runtime", "sonder-inference", "sonder-inference"]);
    });

    it("links a child event to its parent request", () => {
        const groups = relatedGroups(childQueued, all);
        const parent = groups.find((g) => g.kind === "parent")!;
        expect(parent.value).toBe("R");
        expect(parent.events).toEqual([turnStart, turnEnd]);
        expect(groups.find((g) => g.kind === "request")!.events).toEqual([childToken]);
    });

    it("limits long groups and reports the total", () => {
        const many = Array.from({ length: 30 }, (_, i) => at(100 + i, "inference.token.generated", { run_id: "big" }));
        const group = relatedGroups(many[0]!, many, 25).find((g) => g.kind === "run")!;
        expect(group.events).toHaveLength(25);
        expect(group.total).toBe(29);
        expect(relatedGroups(at(1, "x"), [at(2, "y")])).toEqual([]);
    });
});

describe("onboarding and brand", () => {
    it("probes every preset with a short timeout and never throws", async () => {
        const probe = vi.fn(async (url: string, opts: { timeoutMs?: number }) => {
            expect(opts.timeoutMs).toBe(1000);
            if (url.includes("11437")) {
                throw new Error("boom");
            }
            return { ok: url.includes("8766"), discovery: null, streamUrl: url, error: url.includes("8766") ? null : "refused", corsSuspected: false };
        });
        const results = await probePresets(undefined, probe);
        expect(probe).toHaveBeenCalledTimes(3);
        expect(results.map((r) => r.result.ok)).toEqual([false, false, true]);
        expect(results[1]!.result.error).toBe("boom");
        expect(presetLine(results[2]!)).toBe("Fake live producer (synthetic) at http://127.0.0.1:8766/sse");
    });

    it("namespaces the icon's ids for inline use", () => {
        const svg = brandSvgMarkup('<svg width="1024" height="1024"><!-- c --><linearGradient id="bg"/><rect fill="url(#bg)"/></svg>');
        expect(svg).toBe('<svg width="28" height="28" aria-hidden="true" focusable="false"><linearGradient id="brand-bg"/><rect fill="url(#brand-bg)"/></svg>');
        expect(brandSvgMarkup()).toContain('id="brand-dome"');
    });
});
