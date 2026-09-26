import { describe, expect, it, vi } from "vitest";
import type { LaunchInfo, OpenedRecording, RecentRecording } from "../src/integrations/desktop";
import { DesktopIntegration, RECENT_CLEAR, recentOptions, type DesktopBridge } from "../src/integrations/desktopUi";

// Minimal DOM stand-in (the test environment is node, without jsdom).
type Listener = (ev: { preventDefault(): void }) => void;
class FakeElement {
    id = "";
    className = "";
    title = "";
    textContent: string | null = "";
    hidden = false;
    disabled = false;
    value = "";
    dataset: Record<string, string> = {};
    children: FakeElement[] = [];
    siblingsAfter: FakeElement[] = [];
    attrs: Record<string, string> = {};
    listeners: Record<string, Listener[]> = {};
    constructor(readonly tag: string) {}
    setAttribute(k: string, v: string) {
        this.attrs[k] = v;
    }
    after(...els: FakeElement[]) {
        this.siblingsAfter.push(...els);
    }
    replaceChildren(...els: FakeElement[]) {
        this.children = els;
    }
    addEventListener(type: string, fn: Listener) {
        (this.listeners[type] ??= []).push(fn);
    }
    fire(type: string) {
        let prevented = false;
        for (const fn of this.listeners[type] ?? []) {
            fn({ preventDefault: () => (prevented = true) });
        }
        return prevented;
    }
}

function fakeDoc() {
    const capture = new FakeElement("span");
    const label = new FakeElement("label");
    const input = new FakeElement("input");
    const byId: Record<string, FakeElement> = { "capture-badge": capture, "file-input": input };
    const doc = {
        createElement: (tag: string) => new FakeElement(tag),
        getElementById: (id: string) => byId[id] ?? null,
        querySelector: (sel: string) => (sel === 'label[for="file-input"]' ? label : null),
    };
    return { doc: doc as unknown as Document, capture, label, input };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
    return {
        isDesktop: () => true,
        getLaunchInfo: async () => null,
        openRecordingNative: async () => null,
        listRecentRecordings: async () => [],
        openRecentRecordingText: async () => ({ text: "", label: "" }),
        clearRecentRecordings: async () => undefined,
        readGrantText: async () => ({ text: "", label: "" }),
        ...overrides,
    };
}

const recent: RecentRecording[] = [
    { id: "recent-1", name: "run.sobs", kind: "file", available: true },
    { id: "recent-2", name: "session", kind: "folder", available: false },
];

describe("recentOptions", () => {
    it("shows a disabled placeholder when empty", () => {
        expect(recentOptions([])).toEqual([{ value: "", text: "No recent recordings", disabled: true }]);
    });

    it("lists entries, marks missing ones and adds clear", () => {
        const opts = recentOptions(recent);
        expect(opts.map((o) => o.value)).toEqual(["", "recent-1", "recent-2", RECENT_CLEAR]);
        expect(opts[2]).toMatchObject({ disabled: true, text: expect.stringMatching(/session \(missing\)/) });
    });
});

describe("DesktopIntegration", () => {
    it("browser mode: only adds the badge and leaves the file input alone", async () => {
        const { doc, capture, label } = fakeDoc();
        const host = { openRecordingText: vi.fn() };
        await new DesktopIntegration(host, doc, fakeBridge({ isDesktop: () => false })).mount();
        const badge = capture.siblingsAfter[0];
        expect(badge?.textContent).toBe("browser");
        expect(badge?.dataset.mode).toBe("browser");
        expect(label.listeners.click).toBeUndefined();
        expect(host.openRecordingText).not.toHaveBeenCalled();
    });

    it("desktop mode: native open replaces the file input click and feeds the app", async () => {
        const { doc, capture, label, input } = fakeDoc();
        const host = { openRecordingText: vi.fn() };
        const opened: OpenedRecording = { text: "{}\n", label: "run.sobs" };
        const listRecent = vi.fn(async () => recent);
        const api = fakeBridge({ openRecordingNative: async () => opened, listRecentRecordings: listRecent });
        await new DesktopIntegration(host, doc, api).mount();

        expect(capture.siblingsAfter[0]?.textContent).toBe("desktop");
        const [select] = input.siblingsAfter;
        expect(select?.id).toBe("recent-select");
        expect(select?.children.map((o) => o.value)).toEqual(["", "recent-1", "recent-2", RECENT_CLEAR]);

        expect(label.fire("click")).toBe(true);
        await flush();
        expect(host.openRecordingText).toHaveBeenCalledWith("{}\n", "run.sobs");
        expect(listRecent).toHaveBeenCalledTimes(2);
    });

    it("opens and clears recent entries from the menu", async () => {
        const { doc, input } = fakeDoc();
        const host = { openRecordingText: vi.fn() };
        const openRecent = vi.fn(async (id: string) => ({ text: "x", label: id }));
        const clear = vi.fn(async () => undefined);
        await new DesktopIntegration(
            host,
            doc,
            fakeBridge({ listRecentRecordings: async () => recent, openRecentRecordingText: openRecent, clearRecentRecordings: clear }),
        ).mount();
        const select = input.siblingsAfter[0]!;
        select.value = "recent-1";
        select.fire("change");
        await flush();
        expect(openRecent).toHaveBeenCalledWith("recent-1");
        expect(host.openRecordingText).toHaveBeenCalledWith("x", "recent-1");
        select.value = RECENT_CLEAR;
        select.fire("change");
        await flush();
        expect(clear).toHaveBeenCalledOnce();
    });

    it("loads --open at launch and shows warnings and errors", async () => {
        const { doc, input } = fakeDoc();
        const host = { openRecordingText: vi.fn() };
        const info: LaunchInfo = {
            connect: null,
            session: null,
            capability: null,
            open: { id: "rec-1", name: "launch.sobs", kind: "file" },
            warnings: ["ignored unknown argument --foo"],
        };
        const integration = new DesktopIntegration(
            host,
            doc,
            fakeBridge({
                getLaunchInfo: async () => info,
                readGrantText: async (g) => ({ text: "l", label: g.name }),
                openRecordingNative: async () => {
                    throw new Error("permission denied");
                },
            }),
        );
        await integration.mount();
        expect(host.openRecordingText).toHaveBeenCalledWith("l", "launch.sobs");
        const status = input.siblingsAfter[1]!;
        expect(status.textContent).toMatch(/--foo/);
        await integration.openNative();
        expect(status.textContent).toMatch(/could not open recording: permission denied/);
        expect(status.hidden).toBe(false);
    });

    it("starts a live connection for --connect at launch", async () => {
        const { doc } = fakeDoc();
        const host = { openRecordingText: vi.fn(), connectLive: vi.fn() };
        const info: LaunchInfo = {
            connect: "ws://127.0.0.1:8766/ws",
            session: null,
            capability: null,
            open: null,
            warnings: [],
        };
        await new DesktopIntegration(host, doc, fakeBridge({ getLaunchInfo: async () => info })).mount();
        expect(host.connectLive).toHaveBeenCalledWith("ws://127.0.0.1:8766/ws", { session: null, capability: null });
        expect(host.openRecordingText).not.toHaveBeenCalled();
    });

    it("passes --session and --capability to the live connection", async () => {
        const { doc } = fakeDoc();
        const host = { openRecordingText: vi.fn(), connectLive: vi.fn() };
        const info: LaunchInfo = {
            connect: "http://127.0.0.1:8766/events",
            session: "ses_42",
            capability: "cap-token",
            open: null,
            warnings: [],
        };
        await new DesktopIntegration(host, doc, fakeBridge({ getLaunchInfo: async () => info })).mount();
        expect(host.connectLive).toHaveBeenCalledWith("http://127.0.0.1:8766/events", {
            session: "ses_42",
            capability: "cap-token",
        });
    });

    it("prefers --open over --connect and says so", async () => {
        const { doc, input } = fakeDoc();
        const host = { openRecordingText: vi.fn(), connectLive: vi.fn() };
        const info: LaunchInfo = {
            connect: "ws://127.0.0.1:8766/ws",
            session: null,
            capability: null,
            open: { id: "rec-1", name: "launch.sobs", kind: "file" },
            warnings: [],
        };
        await new DesktopIntegration(
            host,
            doc,
            fakeBridge({ getLaunchInfo: async () => info, readGrantText: async (g) => ({ text: "l", label: g.name }) }),
        ).mount();
        expect(host.openRecordingText).toHaveBeenCalledWith("l", "launch.sobs");
        expect(host.connectLive).not.toHaveBeenCalled();
        expect(input.siblingsAfter[1]!.textContent).toMatch(/--open and --connect/);
    });

    it("ignores --connect when the host cannot connect", async () => {
        const { doc } = fakeDoc();
        const host = { openRecordingText: vi.fn() };
        const info: LaunchInfo = { connect: "ws://127.0.0.1:1/", session: null, capability: null, open: null, warnings: [] };
        await expect(new DesktopIntegration(host, doc, fakeBridge({ getLaunchInfo: async () => info })).mount()).resolves.toBeUndefined();
        expect(host.openRecordingText).not.toHaveBeenCalled();
    });
});
