/**
 * Live producer lifecycle, remembered connection metadata (never tokens),
 * health snapshot, and unallowlisted query-endpoint confirmation banner.
 */
import { isLoopbackHost, type TransportPreference } from "../ingest/live/endpoint";
import type { HealthBackend } from "../ingest/live/health";
import { LiveConnectionManager, type ProducerConnection, type ProducerEndpointInput } from "../ingest/live/manager";
import type { SessionStore } from "../replay/session";
import { byId, h } from "./dom";
import { redactUrlSecrets } from "./params";
import { producerCardModel, type ProducerCardModel } from "./producersPanel";

interface RememberedInput {
    url: string;
    transport: TransportPreference;
    label?: string;
}

export interface LiveControllerHooks {
    onAppend(): void;
    onBeforeAddProducer(): void;
    onEditFill(input: { url: string; transport: TransportPreference }, focus: "url" | "token"): void;
    onRender(): void;
    onQueueRender(): void;
}

export class LiveController {
    private readonly manager: LiveConnectionManager;
    private readonly hooks: LiveControllerHooks;
    private activeConnections: ProducerConnection[] = [];
    /** Producers the user disconnected: kept as cards with their final counters. */
    private readonly closed = new Map<string, ProducerConnection>();
    /** URL/transport/label per connection id (never the token), for Reconnect and Edit. */
    private readonly inputs = new Map<string, RememberedInput>();
    /** Query-supplied ?connect= / ?ws= URLs outside the local Sonder allowlist awaiting confirmation. */
    private pendingQueryConnects: string[] = [];
    private pendingConnectStamp = "";

    constructor(store: SessionStore, hooks: LiveControllerHooks) {
        this.hooks = hooks;
        this.manager = new LiveConnectionManager(store, {
            onAppend: () => this.hooks.onAppend(),
        });
    }

    get connections(): readonly ProducerConnection[] {
        return this.activeConnections;
    }

    get closedCount(): number {
        return this.closed.size;
    }

    hasAny(): boolean {
        return this.activeConnections.length > 0 || this.closed.size > 0;
    }

    subscribe(): void {
        this.manager.subscribe((connections) => {
            this.activeConnections = [...connections];
            this.hooks.onQueueRender();
        });
    }

    setPendingQueryConnects(urls: readonly string[]): void {
        this.pendingQueryConnects = [...urls];
    }

    /** Adds a live producer; its events merge into the current live session. */
    addProducer(input: ProducerEndpointInput): void {
        this.hooks.onBeforeAddProducer();
        const remembered: RememberedInput = { url: input.url, transport: input.transport ?? "auto", ...(input.label ? { label: input.label } : {}) };
        void this.manager.add(input).then((connection) => {
            this.inputs.set(connection.id, remembered);
            this.hooks.onQueueRender();
        });
        this.hooks.onRender();
    }

    connectProducers(inputs: readonly ProducerEndpointInput[]): void {
        for (const input of inputs) {
            this.addProducer(input);
        }
    }

    async disconnectProducer(id: string): Promise<void> {
        const connection = this.activeConnections.find((c) => c.id === id);
        if (connection) {
            this.closed.set(id, { ...connection, status: { ...connection.status, state: "closed", retryInMs: null } });
        }
        await this.manager.remove(id);
        this.hooks.onRender();
    }

    reconnectProducer(id: string): void {
        const connection = this.closed.get(id);
        this.closed.delete(id);
        if (!connection) {
            return;
        }
        const input = this.inputs.get(id) ?? { url: connection.url, transport: "auto" as const };
        this.addProducer({ url: input.url, transport: input.transport, ...(connection.label ? { label: connection.label } : {}) });
    }

    editProducer(id: string): void {
        const connection = this.closed.get(id) ?? this.activeConnections.find((c) => c.id === id);
        if (!connection) {
            return;
        }
        const input = this.inputs.get(id) ?? { url: connection.url, transport: "auto" as const };
        const needsToken = connection.hasToken || /token/i.test(connection.status.lastError ?? "");
        this.hooks.onEditFill({ url: redactUrlSecrets(input.url), transport: input.transport }, needsToken ? "token" : "url");
        void this.removeProducer(id);
    }

    async removeProducer(id: string): Promise<void> {
        if (this.closed.delete(id)) {
            this.hooks.onRender();
            return;
        }
        await this.manager.remove(id);
        this.hooks.onRender();
    }

    /** Runs `load` once every live stream has stopped and flushed (so none appends into the new source). */
    afterLiveStopped(load: () => void): void {
        this.closed.clear();
        if (this.manager.list().length === 0) {
            load();
            return;
        }
        void this.manager.disconnectAll().then(load);
    }

    confirmPendingQueryConnects(): void {
        const urls = this.pendingQueryConnects;
        this.pendingQueryConnects = [];
        if (urls.length > 0) {
            this.connectProducers(urls.map((url) => ({ url })));
        }
        this.hooks.onRender();
    }

    dismissPendingQueryConnects(): void {
        this.pendingQueryConnects = [];
        this.hooks.onRender();
    }

    producerCardModels(): ProducerCardModel[] {
        return [...this.activeConnections.map((c) => producerCardModel(c)), ...[...this.closed.values()].map((c) => producerCardModel(c, true))].sort(
            (a, b) => Number(a.id.replace(/\D+/g, "")) - Number(b.id.replace(/\D+/g, "")),
        );
    }

    /** Health backends per producer instance (live connections that fetched their health link). */
    healthByInstance(): { map: Map<string, readonly HealthBackend[]>; stamp: string } {
        const map = new Map<string, readonly HealthBackend[]>();
        for (const c of this.activeConnections) {
            const instance = c.identity?.instance_id;
            if (instance && c.health) {
                map.set(instance, c.health.backends);
            }
        }
        return { map, stamp: [...map.entries()].map(([k, v]) => `${k}:${v.map((b) => `${b.name}=${b.capabilities.join("+")}`).join(",")}`).join(";") };
    }

    describeLiveSource(): string {
        const urls = this.activeConnections.map((c) => redactUrlSecrets(c.url));
        return `live: ${urls.join(", ") || "producers"}`;
    }

    /** Confirmation banner for query-supplied ?connect= / ?ws= endpoints outside the local Sonder allowlist. */
    renderConnectConfirm(): void {
        const stamp = this.pendingQueryConnects.join("\n");
        if (stamp === this.pendingConnectStamp) {
            return;
        }
        this.pendingConnectStamp = stamp;
        const box = byId("connect-confirm");
        const urls = this.pendingQueryConnects;
        if (urls.length === 0) {
            box.hidden = true;
            box.replaceChildren();
            return;
        }
        box.hidden = false;
        const n = urls.length;
        const describeScope = (rawUrl: string): string => {
            try {
                const parsed = new URL(rawUrl);
                return isLoopbackHost(parsed.hostname) ? "non-standard local port" : "remote host";
            } catch {
                return "unparsed URL";
            }
        };
        const confirmBtn = h("button", {
            id: "confirm-connect-btn",
            type: "button",
            class: "primary small",
            text: n === 1 ? "Connect endpoint" : `Connect ${n} endpoints`,
        });
        confirmBtn.addEventListener("click", () => this.confirmPendingQueryConnects());
        const dismissBtn = h("button", {
            id: "dismiss-connect-btn",
            type: "button",
            class: "small",
            text: "Dismiss",
        });
        dismissBtn.addEventListener("click", () => this.dismissPendingQueryConnects());
        box.replaceChildren(
            h("p", {
                class: "connect-confirm-text",
                text: `This link requests connecting to ${n} unallowlisted endpoint${n === 1 ? "" : "s"}. No network request has been sent yet:`,
            }),
            h(
                "ul",
                { class: "connect-confirm-list" },
                ...urls.map((url) =>
                    h(
                        "li",
                        {},
                        h("code", { class: "mono", text: redactUrlSecrets(url) }),
                        h("span", { text: ` (${describeScope(url)})` }),
                    ),
                ),
            ),
            h("div", { class: "connect-confirm-actions" }, confirmBtn, dismissBtn),
        );
    }
}
