/**
 * Producers list (#producers): one card per live connection, with the stable
 * DOM hooks of contract section 8.6:
 *
 *   [data-testid=producer-card][data-producer=<producer.name>]
 *     [data-testid=producer-state]    connecting | live | reconnecting | failed | disconnected
 *     [data-testid=producer-counters] received / appended / dropped / rejected / buffered / reconnects
 *
 * Everything is visible text (nothing hover-only). Cards are keyed by
 * connection id, built once and patched in place, so buttons stay the same
 * elements (focus and a slow mouse click survive) while counters change.
 */
import { producerState, type ProducerState } from "../ingest/live/status";
import type { ProducerConnection } from "../ingest/live/manager";
import { connectionAdvice } from "./connectionPanel";
import { h } from "./dom";
import { redactUrlSecrets } from "./params";

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
        url: redactUrlSecrets(c.streamUrl ?? c.url),
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

/** Element references of one card; everything else is patched in place. */
interface CardParts {
    root: HTMLLIElement;
    article: HTMLElement;
    title: HTMLHeadingElement;
    synthetic: HTMLElement;
    state: HTMLElement;
    metaHead: Text;
    instance: HTMLElement;
    metaTail: Text;
    url: HTMLElement;
    counters: HTMLElement;
    counterValues: Map<string, HTMLElement>;
    error: HTMLElement;
    advice: HTMLElement;
    actions: HTMLElement;
    /** Actions and title the buttons were built for (rebuilt only when these change). */
    actionsKey: string;
    /** The model last applied, so unchanged cards are skipped cheaply. */
    last: ProducerCardModel | null;
}

const ACTION_TEXT = { disconnect: "Disconnect", reconnect: "Reconnect", edit: "Edit in Sources", remove: "Remove" } as const;

function setText(el: Node, text: string): void {
    if (el.textContent !== text) {
        el.textContent = text;
    }
}

function setAttr(el: HTMLElement, name: string, value: string): void {
    if (el.getAttribute(name) !== value) {
        el.setAttribute(name, value);
    }
}

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

    /**
     * Each card is built once per connection and then patched: counter
     * updates change text nodes only, and the action buttons are replaced
     * only when the set of actions (or the title in their names) changes.
     * Buttons therefore stay the same elements while a producer streams, so a
     * press-and-release at human speed lands on the button it started on.
     */
    update(models: readonly ProducerCardModel[]): void {
        const seen = new Set<string>();
        models.forEach((m, index) => {
            seen.add(m.id);
            let parts = this.cards.get(m.id);
            if (!parts) {
                parts = this.buildCard(m.id);
                this.cards.set(m.id, parts);
            }
            if (this.list.children[index] !== parts.root) {
                this.list.insertBefore(parts.root, this.list.children[index] ?? null);
            }
            this.patch(parts, m);
        });
        for (const [id, parts] of this.cards) {
            if (!seen.has(id)) {
                parts.root.remove();
                this.cards.delete(id);
            }
        }
        this.empty.hidden = models.length > 0;
    }

    private buildCard(id: string): CardParts {
        const titleId = `producer-title-${id}`;
        const title = h("h3", { id: titleId, class: "producer-name" });
        const synthetic = h("span", { class: "tag tag-synthetic", text: "SYNTHETIC", hidden: true });
        const state = h("span", { class: "state-word", "data-testid": "producer-state" });
        const metaHead = document.createTextNode("");
        const instance = h("span", { class: "mono" });
        const metaTail = document.createTextNode("");
        const url = h("p", { class: "producer-url mono" });
        const counters = h("dl", { class: "counters", "data-testid": "producer-counters" });
        const error = h("p", { class: "producer-error", hidden: true });
        const advice = h("p", { class: "producer-advice", hidden: true });
        const actions = h("div", { class: "card-actions" });
        const article = h(
            "article",
            { class: "producer-card", "data-testid": "producer-card", "aria-labelledby": titleId },
            h("div", { class: "producer-head" }, title, synthetic, state),
            h("p", { class: "producer-meta" }, metaHead, instance, metaTail),
            url,
            counters,
            error,
            advice,
            actions,
        );
        return {
            root: h("li", {}, article),
            article,
            title,
            synthetic,
            state,
            metaHead,
            instance,
            metaTail,
            url,
            counters,
            counterValues: new Map(),
            error,
            advice,
            actions,
            actionsKey: "",
            last: null,
        };
    }

    private patch(p: CardParts, m: ProducerCardModel): void {
        const last = p.last;
        if (last && JSON.stringify(last) === JSON.stringify(m)) {
            return;
        }
        p.last = m;
        setAttr(p.article, "data-producer", m.producer);
        setAttr(p.article, "data-state", m.state);
        setText(p.title, m.title);
        p.synthetic.hidden = !m.synthetic;
        setText(p.state, m.state);
        setAttr(p.state, "data-tone", STATE_TONE[m.state]);
        setText(p.metaHead, `${m.role} · ${m.version} · instance `);
        setText(p.instance, m.instance);
        setText(p.metaTail, ` · ${m.transport}`);
        setText(p.url, m.url);
        for (const [name, value] of m.counters) {
            let dd = p.counterValues.get(name);
            if (!dd) {
                dd = h("dd", { class: "mono", "data-counter": name });
                p.counters.append(h("div", {}, h("dt", { text: name }), dd));
                p.counterValues.set(name, dd);
            }
            setText(dd, value);
        }
        p.error.hidden = !m.lastError;
        setText(p.error, m.lastError ? `Last error: ${m.lastError}` : "");
        p.advice.hidden = !m.advice;
        setText(p.advice, m.advice ?? "");
        const actionsKey = `${m.actions.join(",")}\u0000${m.title}`;
        if (actionsKey !== p.actionsKey) {
            p.actionsKey = actionsKey;
            this.renderActions(p, m);
        }
    }

    private renderActions(p: CardParts, m: ProducerCardModel): void {
        const focused = p.actions.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.action : undefined;
        const buttons = m.actions.map((action) => {
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
        });
        p.actions.replaceChildren(...buttons);
        if (focused !== undefined) {
            (buttons.find((b) => b.dataset.action === focused) ?? buttons[0])?.focus();
        }
    }
}
