/**
 * Producers list (#producers): one card per live connection, with the stable
 * DOM hooks of contract section 8.6:
 *
 *   [data-testid=producer-card][data-producer=<producer.name>]
 *     [data-testid=producer-state]    connecting | live | reconnecting | failed | disconnected
 *     [data-testid=producer-counters] received / appended / dropped / rejected / buffered / reconnects
 *
 * Everything is visible text (nothing hover-only). Cards are keyed by
 * connection id and updated in place, so a focused button survives the
 * frequent counter updates.
 */
import { producerState, type ProducerState } from "../ingest/live/status";
import type { ProducerConnection } from "../ingest/live/manager";
import { connectionAdvice } from "./connectionPanel";
import { h } from "./dom";

export interface ProducerCardModel {
    id: string;
    /** producer.name once known (discovery or first event), else "". */
    producer: string;
    title: string;
    role: string;
    version: string;
    instance: string;
    transport: string;
    url: string;
    state: ProducerState;
    counters: [string, string][];
    lastError: string | null;
    advice: string | null;
    synthetic: boolean;
    /** Card actions, by state. */
    actions: ("disconnect" | "reconnect" | "edit" | "remove")[];
}

/** "rt-0123456789abcdef" -> "rt-012345678…" */
export function shortInstance(instance: string | null | undefined, max = 12): string {
    if (!instance) {
        return "—";
    }
    return instance.length > max ? `${instance.slice(0, max)}…` : instance;
}

function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

/**
 * Card model for a connection. `closed` marks a connection the user
 * disconnected (kept in the list with its final counters).
 */
export function producerCardModel(c: ProducerConnection, closed = false): ProducerCardModel {
    const s = c.status;
    const state: ProducerState = closed ? "disconnected" : producerState(s);
    const identity = c.identity;
    const actions: ProducerCardModel["actions"] =
        state === "failed"
            ? ["edit", "remove"]
            : state === "disconnected"
              ? [c.hasToken ? "edit" : "reconnect", "remove"]
              : ["disconnect"];
    const error = s.lastError;
    return {
        id: c.id,
        producer: identity?.name ?? "",
        title: identity?.name ?? c.label ?? hostOf(c.url),
        role: identity?.role ?? "role unknown",
        version: identity?.version ?? "—",
        instance: shortInstance(identity?.instance_id),
        transport: s.transport ?? "—",
        url: c.streamUrl ?? c.url,
        state,
        counters: [
            ["received", String(s.received)],
            ["appended", String(s.appended)],
            ["dropped", String(s.dropped)],
            ["rejected", String(s.rejected)],
            ["buffered", s.bufferCapacity > 0 ? `${s.buffered}/${s.bufferCapacity}` : String(s.buffered)],
            ["reconnects", String(s.reconnects)],
        ],
        lastError: error,
        advice: error && (state === "failed" || state === "reconnecting") ? connectionAdvice(error, c.hasToken) : null,
        synthetic: identity?.synthetic === true,
        actions,
    };
}

const STATE_TONE: Record<ProducerState, string> = {
    connecting: "warn",
    live: "ok",
    reconnecting: "warn",
    failed: "error",
    disconnected: "idle",
};

export interface ProducersPanelCallbacks {
    onDisconnect(id: string): void;
    onReconnect(id: string): void;
    onEdit(id: string): void;
    onRemove(id: string): void;
}

interface CardParts {
    root: HTMLElement;
    key: string;
}

const ACTION_TEXT = { disconnect: "Disconnect", reconnect: "Reconnect", edit: "Edit in Sources", remove: "Remove" } as const;

export class ProducersPanel {
    readonly element: HTMLElement;
    private readonly list: HTMLUListElement;
    private readonly empty: HTMLElement;
    private readonly cards = new Map<string, CardParts>();

    constructor(private readonly callbacks: ProducersPanelCallbacks) {
        this.list = h("ul", { id: "producers", class: "producer-list", "aria-labelledby": "producers-title" });
        this.empty = h("p", { id: "producers-empty", class: "muted", text: "No live producers. Connect one in Sources." });
        this.element = h(
            "section",
            { class: "side-section", role: "region", "aria-labelledby": "producers-title" },
            h("h2", { id: "producers-title", text: "Producers" }),
            this.empty,
            this.list,
        );
    }

    update(models: readonly ProducerCardModel[]): void {
        const seen = new Set<string>();
        models.forEach((m, index) => {
            seen.add(m.id);
            const key = JSON.stringify(m);
            let parts = this.cards.get(m.id);
            if (parts && parts.key === key) {
                return;
            }
            const hadFocus = parts?.root.contains(document.activeElement) ?? false;
            const focusedAction = hadFocus ? (document.activeElement as HTMLElement | null)?.dataset.action : undefined;
            const root = this.renderCard(m);
            if (parts) {
                parts.root.replaceWith(root);
            } else {
                const before = this.list.children[index] ?? null;
                this.list.insertBefore(root, before);
            }
            parts = { root, key };
            this.cards.set(m.id, parts);
            if (focusedAction) {
                (root.querySelector<HTMLElement>(`[data-action="${focusedAction}"]`) ?? root.querySelector<HTMLElement>("button"))?.focus();
            }
        });
        for (const [id, parts] of this.cards) {
            if (!seen.has(id)) {
                parts.root.remove();
                this.cards.delete(id);
            }
        }
        this.empty.hidden = models.length > 0;
    }

    private renderCard(m: ProducerCardModel): HTMLLIElement {
        const titleId = `producer-title-${m.id}`;
        const counters = h(
            "dl",
            { class: "counters", "data-testid": "producer-counters" },
            ...m.counters.map(([name, value]) => h("div", {}, h("dt", { text: name }), h("dd", { class: "mono", "data-counter": name, text: value }))),
        );
        const actions = h(
            "div",
            { class: "card-actions" },
            ...m.actions.map((action) => {
                const btn = h("button", {
                    type: "button",
                    class: "small",
                    "data-action": action,
                    text: ACTION_TEXT[action],
                    "aria-label": `${ACTION_TEXT[action]} ${m.title}`,
                });
                btn.addEventListener("click", () => {
                    if (action === "disconnect") {
                        this.callbacks.onDisconnect(m.id);
                    } else if (action === "reconnect") {
                        this.callbacks.onReconnect(m.id);
                    } else if (action === "edit") {
                        this.callbacks.onEdit(m.id);
                    } else {
                        this.callbacks.onRemove(m.id);
                    }
                });
                return btn;
            }),
        );
        const article = h(
            "article",
            {
                class: "producer-card",
                "data-testid": "producer-card",
                "data-producer": m.producer,
                "data-state": m.state,
                "aria-labelledby": titleId,
            },
            h(
                "div",
                { class: "producer-head" },
                h("h3", { id: titleId, class: "producer-name", text: m.title }),
                m.synthetic ? h("span", { class: "tag tag-synthetic", text: "SYNTHETIC" }) : null,
                h("span", { class: "state-word", "data-testid": "producer-state", "data-tone": STATE_TONE[m.state], text: m.state }),
            ),
            h(
                "p",
                { class: "producer-meta" },
                `${m.role} · ${m.version} · instance `,
                h("span", { class: "mono", text: m.instance }),
                ` · ${m.transport}`,
            ),
            h("p", { class: "producer-url mono", text: m.url }),
            counters,
            m.lastError ? h("p", { class: "producer-error", text: `Last error: ${m.lastError}` }) : null,
            m.advice ? h("p", { class: "producer-advice", text: m.advice }) : null,
            actions,
        );
        return h("li", {}, article);
    }
}
