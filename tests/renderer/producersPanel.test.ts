import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveIngestStatus } from "../../src/ingest/live/client";
import { LOCAL_PRESETS, type ProducerConnection, type ProducerEndpointInput } from "../../src/ingest/live/manager";
import { BRIDGED_PRESETS, ConnectionPanel, FULL_STACK_ENDPOINTS } from "../../src/renderer/connectionPanel";
import { producerCardModel, ProducersPanel } from "../../src/renderer/producersPanel";

class FakeNode {
    parentNode: FakeElement | null = null;
    private text = "";

    get textContent(): string {
        return this.text;
    }

    set textContent(value: string) {
        this.text = value;
    }

    remove(): void {
        if (!this.parentNode) {
            return;
        }
        const idx = this.parentNode.childNodes.indexOf(this);
        if (idx >= 0) {
            this.parentNode.childNodes.splice(idx, 1);
        }
        this.parentNode = null;
    }
}

class FakeText extends FakeNode {
    constructor(data: string) {
        super();
        this.textContent = data;
    }
}

class FakeElement extends FakeNode {
    readonly tagName: string;
    readonly childNodes: FakeNode[] = [];
    readonly attrs = new Map<string, string>();
    readonly listeners = new Map<string, ((ev: { preventDefault(): void }) => void)[]>();
    readonly dataset: Record<string, string | undefined>;
    hidden = false;
    value = "";
    focused = false;
    private readonly owner: FakeDocument;

    constructor(tagName: string, owner: FakeDocument) {
        super();
        this.tagName = tagName.toUpperCase();
        this.owner = owner;
        this.dataset = new Proxy<Record<string, string | undefined>>(
            {},
            {
                get: (_target, prop) => (typeof prop === "string" ? this.attrs.get(`data-${prop}`) : undefined),
                set: (_target, prop, val) => {
                    if (typeof prop === "string") {
                        this.setAttribute(`data-${prop}`, String(val));
                    }
                    return true;
                },
                deleteProperty: (_target, prop) => {
                    if (typeof prop === "string") {
                        this.removeAttribute(`data-${prop}`);
                    }
                    return true;
                },
            },
        );
    }

    get id(): string {
        return this.attrs.get("id") ?? "";
    }

    get className(): string {
        return this.attrs.get("class") ?? "";
    }

    set className(value: string) {
        this.attrs.set("class", value);
    }

    get children(): FakeElement[] {
        return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
    }

    override get textContent(): string {
        if (this.childNodes.length === 0) {
            return super.textContent;
        }
        return this.childNodes.map((n) => n.textContent).join("");
    }

    override set textContent(value: string) {
        this.childNodes.length = 0;
        super.textContent = value;
    }

    setAttribute(name: string, value: string): void {
        if (name === "hidden") {
            this.hidden = true;
        }
        if (name === "value") {
            this.value = value;
        }
        this.attrs.set(name, value);
    }

    getAttribute(name: string): string | null {
        return this.attrs.get(name) ?? null;
    }

    removeAttribute(name: string): void {
        if (name === "hidden") {
            this.hidden = false;
        }
        this.attrs.delete(name);
    }

    append(...nodes: (FakeNode | string)[]): void {
        for (const item of nodes) {
            const node = typeof item === "string" ? new FakeText(item) : item;
            node.remove();
            node.parentNode = this;
            this.childNodes.push(node);
        }
    }

    insertBefore(node: FakeNode, ref: FakeNode | null): FakeNode {
        node.remove();
        node.parentNode = this;
        const idx = ref ? this.childNodes.indexOf(ref) : -1;
        if (idx >= 0) {
            this.childNodes.splice(idx, 0, node);
        } else {
            this.childNodes.push(node);
        }
        return node;
    }

    replaceChildren(...nodes: (FakeNode | string)[]): void {
        for (const existing of [...this.childNodes]) {
            existing.parentNode = null;
        }
        this.childNodes.length = 0;
        this.append(...nodes);
    }

    contains(node: FakeNode | null): boolean {
        let cur: FakeNode | null = node;
        while (cur) {
            if (cur === this) {
                return true;
            }
            cur = cur.parentNode;
        }
        return false;
    }

    addEventListener(type: string, fn: (ev: { preventDefault(): void }) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(fn);
        this.listeners.set(type, list);
    }

    click(): void {
        for (const fn of this.listeners.get("click") ?? []) {
            fn({ preventDefault() {} });
        }
    }

    focus(): void {
        this.focused = true;
        this.owner.activeElement = this;
    }

    findAll(pred: (el: FakeElement) => boolean): FakeElement[] {
        const out: FakeElement[] = [];
        const walk = (el: FakeElement) => {
            if (pred(el)) {
                out.push(el);
            }
            for (const child of el.children) {
                walk(child);
            }
        };
        walk(this);
        return out;
    }

    find(pred: (el: FakeElement) => boolean): FakeElement | null {
        return this.findAll(pred)[0] ?? null;
    }
}

class FakeDocument {
    activeElement: FakeElement | null = null;

    createElement(tag: string): FakeElement {
        return new FakeElement(tag, this);
    }

    createTextNode(text: string): FakeText {
        return new FakeText(text);
    }
}

function makeStatus(overrides: Partial<LiveIngestStatus> = {}): LiveIngestStatus {
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
        received: 0,
        appended: 0,
        dropped: 0,
        rejected: 0,
        buffered: 0,
        bufferCapacity: 20000,
        batches: 0,
        lastError: null,
        ...overrides,
    };
}

function makeConnection(overrides: Partial<ProducerConnection> = {}): ProducerConnection {
    return {
        id: "producer-1",
        url: "http://127.0.0.1:11437",
        label: null,
        hasToken: false,
        streamUrl: "http://127.0.0.1:11437/v1/telemetry/sse",
        discovery: null,
        health: null,
        identity: {
            name: "sonder-inference",
            version: "0.3.0",
            node_id: "workstation-1",
            instance_id: "tel-0123456789abcdef",
            role: "inference",
            synthetic: false,
        },
        status: makeStatus(),
        ...overrides,
    };
}

describe("ProducersPanel and ConnectionPanel DOM", () => {
    let prevDocument: unknown;
    let fakeDoc: FakeDocument;
    let panel: ProducersPanel | null = null;

    beforeEach(() => {
        prevDocument = (globalThis as { document?: unknown }).document;
        fakeDoc = new FakeDocument();
        (globalThis as { document?: unknown }).document = fakeDoc;
    });

    afterEach(() => {
        panel?.dispose();
        panel = null;
        vi.useRealTimers();
        if (prevDocument === undefined) {
            delete (globalThis as { document?: unknown }).document;
        } else {
            (globalThis as { document?: unknown }).document = prevDocument;
        }
    });

    it("renders node_id badges in .producer-head, keeps URL tooltips, and updates live rate in place", () => {
        vi.useFakeTimers();
        let now = 10_000;
        panel = new ProducersPanel(
            {
                onDisconnect: vi.fn(),
                onReconnect: vi.fn(),
                onEdit: vi.fn(),
                onRemove: vi.fn(),
            },
            { now: () => now },
        );

        const localConn = makeConnection({ id: "producer-1" });
        const remoteConn = makeConnection({
            id: "producer-2",
            url: "http://127.0.0.1:5175",
            streamUrl: "http://127.0.0.1:5175/v1/telemetry/sse",
            identity: {
                name: "sonder-inference",
                version: "0.3.0",
                node_id: "NODE1",
                instance_id: "tel-fedcba9876543210",
                role: "inference",
                synthetic: false,
            },
        });
        const unknownConn = makeConnection({
            id: "producer-3",
            url: "http://u:SECRET@127.0.0.1:9/?token=SECRET2",
            streamUrl: null,
            identity: null,
            status: makeStatus({ state: "failed", lastError: "credentials in the URL are not allowed" }),
        });

        panel.update([producerCardModel(localConn), producerCardModel(remoteConn), producerCardModel(unknownConn)]);

        const root = panel.element as unknown as FakeElement;
        const cards = root.findAll((el) => el.getAttribute("data-testid") === "producer-card");
        expect(cards).toHaveLength(3);

        const [localCard, remoteCard, failedCard] = cards as [FakeElement, FakeElement, FakeElement];
        // Both sonder-inference cards keep their contract data-producer and button label,
        // while showing distinct node badges inside .producer-head.
        expect(localCard.getAttribute("data-producer")).toBe("sonder-inference");
        expect(remoteCard.getAttribute("data-producer")).toBe("sonder-inference");
        expect(localCard.getAttribute("data-node")).toBe("workstation-1");
        expect(remoteCard.getAttribute("data-node")).toBe("NODE1");

        const localHead = localCard.find((el) => el.className === "producer-head")!;
        const localNode = localHead.find((el) => el.getAttribute("data-testid") === "producer-node")!;
        expect(localNode.hidden).toBe(false);
        expect(localNode.textContent).toBe("workstation-1");
        expect(localNode.getAttribute("title")).toBe("Node: workstation-1");

        const remoteHead = remoteCard.find((el) => el.className === "producer-head")!;
        const remoteNode = remoteHead.find((el) => el.getAttribute("data-testid") === "producer-node")!;
        expect(remoteNode.hidden).toBe(false);
        expect(remoteNode.textContent).toBe("NODE1");

        // Failed card with no identity hides its node badge and redacts URL + title tooltip.
        const failedNode = failedCard.find((el) => el.getAttribute("data-testid") === "producer-node")!;
        expect(failedNode.hidden).toBe(true);
        expect(failedCard.getAttribute("data-node")).toBeNull();
        const failedUrl = failedCard.find((el) => el.className.includes("producer-url"))!;
        expect(failedUrl.textContent).toBe("http://127.0.0.1:9/");
        expect(failedUrl.getAttribute("title")).toBe("http://127.0.0.1:9/");
        expect(failedUrl.getAttribute("title")).not.toMatch(/SECRET/);

        // Live cards expose the full stream URL tooltip and the live rate pill inside counters.
        const remoteUrl = remoteCard.find((el) => el.className.includes("producer-url"))!;
        expect(remoteUrl.getAttribute("title")).toBe("http://127.0.0.1:5175/v1/telemetry/sse");

        const localRateRow = localCard.find((el) => el.className === "producer-rate-row")!;
        const localRate = localCard.find((el) => el.getAttribute("data-testid") === "producer-rate")!;
        const failedRateRow = failedCard.find((el) => el.className === "producer-rate-row")!;
        expect(localRateRow.hidden).toBe(false);
        expect(localRate.textContent).toBe("0.0 events/s");
        expect(localRate.getAttribute("data-active")).toBe("false");
        expect(failedRateRow.hidden).toBe(true);

        // Card and Disconnect button stay the exact same elements across counter + rate patches.
        const disconnectBtn = localCard.find((el) => el.getAttribute("data-action") === "disconnect")!;
        expect(disconnectBtn.getAttribute("aria-label")).toBe("Disconnect sonder-inference");

        now = 11_000;
        panel.update([
            producerCardModel(makeConnection({ id: "producer-1", status: makeStatus({ received: 25, appended: 25 }) })),
            producerCardModel(remoteConn),
            producerCardModel(unknownConn),
        ]);
        expect(root.findAll((el) => el.getAttribute("data-testid") === "producer-card")[0]).toBe(localCard);
        expect(localCard.find((el) => el.getAttribute("data-action") === "disconnect")).toBe(disconnectBtn);
        expect(localRate.textContent).toBe("25.0 events/s");
        expect(localRate.getAttribute("data-active")).toBe("true");

        // Background 1s tick decays idle live rate without another update() call.
        now = 16_000;
        vi.advanceTimersByTime(1_000);
        expect(localRate.textContent).toBe("0.0 events/s · 5s ago");
        expect(localRate.getAttribute("data-active")).toBe("false");

        // Disconnecting hides the live rate row cleanly.
        panel.update([producerCardModel(localConn, true)]);
        expect(localRateRow.hidden).toBe(true);
    });

    it("preserves local presets and wires bridged presets and full-stack connect", () => {
        const connected: ProducerEndpointInput[] = [];
        const cp = new ConnectionPanel(null, {
            onConnect: (input) => connected.push(input),
        });
        const root = cp.element as unknown as FakeElement;

        // Existing #preset-list stays strictly intact (3 LOCAL_PRESETS in order).
        const localList = root.find((el) => el.id === "preset-list")!;
        const localButtons = localList.findAll((el) => el.tagName === "BUTTON");
        expect(localButtons.map((b) => b.getAttribute("data-url"))).toEqual(LOCAL_PRESETS.map((p) => p.url));

        // Bridged telemetry group exposes loopback bridged endpoints without affecting #preset-list.
        const bridgeList = root.find((el) => el.id === "bridge-preset-list")!;
        const bridgeButtons = bridgeList.findAll((el) => el.tagName === "BUTTON");
        expect(bridgeButtons.map((b) => b.getAttribute("data-url"))).toEqual(BRIDGED_PRESETS.map((p) => p.url));

        // Clicking a bridged preset fills #ws-url with transport "auto".
        const urlInput = root.find((el) => el.id === "ws-url")!;
        const transport = root.find((el) => el.id === "transport-select")!;
        const tokenInput = root.find((el) => el.id === "token-input")!;
        transport.value = "ndjson";
        bridgeButtons[1]!.click();
        expect(urlInput.value).toBe("http://127.0.0.1:5175");
        expect(transport.value).toBe("auto");

        // Connect stack connects all 3 full-stack endpoints without forwarding any typed bearer token.
        tokenInput.value = "should-never-be-sent-to-bridge";
        const stackBtn = root.find((el) => el.id === "connect-stack-btn")!;
        stackBtn.click();
        expect(connected).toEqual(FULL_STACK_ENDPOINTS.map((url) => ({ url, transport: "auto" })));
        expect(connected.every((c) => c.token === undefined)).toBe(true);
    });
});
