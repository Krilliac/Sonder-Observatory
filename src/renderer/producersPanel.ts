/**
 * Producers list (#producers): one card per live connection, with the stable
 * DOM hooks of contract section 8.6:
 *
 *   [data-testid=producer-card][data-producer=<producer.name>]
 *     [data-testid=producer-node]     producer.node_id (when known)
 *     [data-testid=producer-state]    connecting | live | reconnecting | failed | disconnected
 *     [data-testid=producer-counters] received / appended / dropped / rejected / buffered / reconnects (+ live rate)
 *
 * Everything is visible text (nothing hover-only). Cards are keyed by
 * connection id, built once and patched in place, so buttons stay the same
 * elements (focus and a slow mouse click survive) while counters change.
 */
import type { HealthGpuDevice } from "../ingest/live/health";
import { producerState, type ProducerState } from "../ingest/live/status";
import type { ProducerConnection } from "../ingest/live/manager";
import { connectionAdvice } from "./connectionPanel";
import { h } from "./dom";
import { fmtBytes } from "./format";
import { redactUrlSecrets } from "./params";
import "./routeBadges.css";

export const RATE_WINDOW_MS = 5_000;
const MIN_RATE_SPAN_MS = 1_000;
const SAMPLE_BUCKET_MS = 250;
const RATE_REFRESH_MS = 1_000;
const MAX_INLINE_GPUS = 4;
const MAX_INLINE_CAPS = 4;

export interface EventRateSnapshot {
    /** Recent valid events per second over the rolling window. */
    eventsPerSec: number;
    /** Milliseconds since the last observed event on this connection, or null if none yet. */
    lastEventAgeMs: number | null;
    /** True when at least one event arrived inside the rolling window. */
    active: boolean;
}

export interface ProducerGpuChip {
    id: string;
    name: string;
    gpuClass: "discrete" | "integrated-uma" | "unknown";
    backendHint: string | null;
    effectiveVramMib: number | null;
    effectiveFreeVramMib: number | null;
    dedicatedTotalMib: number | null;
    sharedTotalMib: number | null;
}

export interface ProducerNodeSummary {
    source: "node" | "health";
    platform: string | null;
    gpuCount: number;
    discreteCount: number;
    umaCount: number;
    hybridPoolAvailable: boolean;
    combinedVramMib: number | null;
    combinedFreeVramMib: number | null;
    recommendedDevices: string[];
    llamaArgDevice: string | null;
    gpus: ProducerGpuChip[];
    modelCount: number;
    modelNames: string[];
    availableBackends: number;
    totalBackends: number;
    activeCapabilities: string[];
    topologyLabel: string;
    residencyLabel: string | null;
}

export interface ProducerCardModel {
    id: string;
    /** producer.name once known (discovery or first event), else "". */
    producer: string;
    /** producer.node_id once known (discovery, node snapshot, or first event), else null. */
    nodeId: string | null;
    title: string;
    role: string;
    version: string;
    instance: string;
    transport: string;
    url: string;
    state: ProducerState;
    /** Total valid events decoded from this producer (for rolling live rate). */
    received: number;
    counters: [string, string][];
    lastError: string | null;
    advice: string | null;
    synthetic: boolean;
    /** Optional hardware/hybrid-GPU topology and residency summary from `/v1/sonder/node` or `/v1/sonder/health`. */
    nodeHardware: ProducerNodeSummary | null;
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

export function formatRelativeAge(ageMs: number): string {
    const sec = Math.max(0, Math.floor(ageMs / 1000));
    if (sec < 2) {
        return "just now";
    }
    if (sec < 60) {
        return `${sec}s ago`;
    }
    const min = Math.floor(sec / 60);
    if (min < 60) {
        return `${min}m ago`;
    }
    const hr = Math.floor(min / 60);
    return `${hr}h ago`;
}

export function formatRateNumber(eventsPerSec: number): string {
    if (!Number.isFinite(eventsPerSec) || eventsPerSec <= 0) {
        return "0.0";
    }
    if (eventsPerSec >= 100) {
        return String(Math.round(eventsPerSec));
    }
    return eventsPerSec.toFixed(1);
}

export function formatEventRate(snapshot: EventRateSnapshot): string {
    const rate = `${formatRateNumber(snapshot.eventsPerSec)} events/s`;
    if (snapshot.active) {
        return rate;
    }
    if (snapshot.lastEventAgeMs !== null) {
        return `${rate} · ${formatRelativeAge(snapshot.lastEventAgeMs)}`;
    }
    return rate;
}

interface RateSample {
    t: number;
    delta: number;
}

interface ProducerRateState {
    firstLiveAt: number | null;
    lastReceived: number;
    lastEventAt: number | null;
    samples: RateSample[];
}

/**
 * Tracks a bounded sliding-window event rate and last-event age per connection
 * id. Pure with respect to `now` so unit tests can drive it deterministically.
 */
export class ProducerRateTracker {
    private readonly entries = new Map<string, ProducerRateState>();

    constructor(private readonly windowMs = RATE_WINDOW_MS) {}

    observe(id: string, received: number, state: ProducerState, now: number): EventRateSnapshot | null {
        const safeReceived = Math.max(0, Math.floor(received));
        let entry = this.entries.get(id);
        if (state !== "live") {
            if (!entry) {
                this.entries.set(id, {
                    firstLiveAt: null,
                    lastReceived: safeReceived,
                    lastEventAt: safeReceived > 0 ? now : null,
                    samples: [],
                });
            } else {
                if (safeReceived > entry.lastReceived) {
                    entry.lastEventAt = now;
                }
                entry.firstLiveAt = null;
                entry.lastReceived = safeReceived;
                entry.samples = [];
            }
            return null;
        }
        if (!entry) {
            entry = {
                firstLiveAt: now,
                lastReceived: safeReceived,
                lastEventAt: safeReceived > 0 ? now : null,
                samples: [],
            };
            this.entries.set(id, entry);
            return this.snapshot(id, now);
        }
        if (entry.firstLiveAt === null) {
            entry.firstLiveAt = now;
        }
        if (safeReceived > entry.lastReceived) {
            const delta = safeReceived - entry.lastReceived;
            entry.lastReceived = safeReceived;
            entry.lastEventAt = now;
            const last = entry.samples[entry.samples.length - 1];
            if (last && now >= last.t && now - last.t < SAMPLE_BUCKET_MS) {
                last.delta += delta;
                last.t = now;
            } else {
                entry.samples.push({ t: now, delta });
            }
        } else if (safeReceived < entry.lastReceived) {
            entry.firstLiveAt = now;
            entry.lastReceived = safeReceived;
            entry.lastEventAt = safeReceived > 0 ? now : null;
            entry.samples = [];
        }
        return this.snapshot(id, now);
    }

    snapshot(id: string, now: number): EventRateSnapshot | null {
        const entry = this.entries.get(id);
        if (!entry || entry.firstLiveAt === null) {
            return null;
        }
        const cutoff = now - this.windowMs;
        let firstKept = 0;
        while (firstKept < entry.samples.length && entry.samples[firstKept]!.t <= cutoff) {
            firstKept += 1;
        }
        if (firstKept > 0) {
            entry.samples.splice(0, firstKept);
        }
        let total = 0;
        for (const sample of entry.samples) {
            total += sample.delta;
        }
        const lastEventAgeMs = entry.lastEventAt !== null ? Math.max(0, now - entry.lastEventAt) : null;
        if (total === 0) {
            return { eventsPerSec: 0, lastEventAgeMs, active: false };
        }
        const spanMs = Math.min(this.windowMs, Math.max(MIN_RATE_SPAN_MS, now - entry.firstLiveAt));
        return {
            eventsPerSec: total / (spanMs / 1000),
            lastEventAgeMs,
            active: true,
        };
    }

    delete(id: string): void {
        this.entries.delete(id);
    }

    clear(): void {
        this.entries.clear();
    }
}

function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

function normalizeNodeId(nodeId: string | null | undefined): string | null {
    const trimmed = nodeId?.trim() ?? "";
    return trimmed !== "" ? trimmed : null;
}

function validMib(value: number | null | undefined): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function formatMib(mib: number): string {
    return fmtBytes(mib * 1024 * 1024);
}

function gpuChipOf(g: HealthGpuDevice): ProducerGpuChip {
    const gpuClass: ProducerGpuChip["gpuClass"] =
        g.isIntegratedUma === true ? "integrated-uma" : g.isIntegratedUma === false ? "discrete" : "unknown";
    return {
        id: g.id,
        name: g.name,
        gpuClass,
        backendHint: g.backendHint,
        effectiveVramMib: validMib(g.effectiveVramMib),
        effectiveFreeVramMib: validMib(g.effectiveFreeVramMib),
        dedicatedTotalMib: validMib(g.dedicatedTotalMib),
        sharedTotalMib: validMib(g.sharedTotalMib),
    };
}

/** Builds a compact hardware, hybrid-GPU pool, and residency summary from `/v1/sonder/node` (or GPU-enriched health). */
export function producerNodeSummary(c: ProducerConnection): ProducerNodeSummary | null {
    const node = c.node ?? null;
    const health = c.health;
    const hasHealthHardware =
        health !== null &&
        ((health.gpus !== undefined && health.gpus.length > 0) ||
            health.gpuPool != null ||
            health.combinedGpuVramMib != null);
    if (!node && !hasHealthHardware) {
        return null;
    }

    const source: "node" | "health" = node ? "node" : "health";
    const gpus = (node ? node.gpus : (health?.gpus ?? [])).map(gpuChipOf);
    const pool = node?.gpuPool ?? health?.gpuPool ?? null;
    const discreteCount = pool?.discreteGpuCount ?? gpus.filter((g) => g.gpuClass === "discrete").length;
    const umaCount = pool?.integratedUmaGpuCount ?? gpus.filter((g) => g.gpuClass === "integrated-uma").length;
    const gpuCount = gpus.length > 0 ? gpus.length : discreteCount + umaCount;
    const combinedVramMib = validMib(node?.combinedGpuVramMib ?? health?.combinedGpuVramMib ?? pool?.combinedGpuVramMib);
    const combinedFreeVramMib = validMib(pool?.combinedFreeGpuVramMib);
    const hybridPoolAvailable = pool?.hybridVulkanPoolAvailable === true;
    const recommendedDevices = pool ? [...pool.recommendedDevices] : [];
    const llamaArgDevice = pool?.llamaArgDevice ?? null;

    const backends = node && node.backends.length > 0 ? node.backends : (health?.backends ?? []);
    const models = node && node.models.length > 0 ? node.models : (health?.models ?? []);
    const availableBackends = backends.filter((b) => b.available !== false).length;
    const totalBackends = backends.length;
    const modelCount = models.length;
    const modelNames = models.map((m) => m.id);
    const platform = node?.platform ?? null;

    const activeCapabilities = node
        ? Object.entries(node.capabilities)
              .filter(([, enabled]) => enabled === true)
              .map(([key]) => key)
              .sort((a, b) => a.localeCompare(b))
        : [];

    const mixParts: string[] = [];
    if (discreteCount > 0) {
        mixParts.push(`${discreteCount} discrete`);
    }
    if (umaCount > 0) {
        mixParts.push(`${umaCount} UMA`);
    }
    const topoParts: string[] = [];
    if (gpuCount === 0) {
        topoParts.push("CPU-only (0 GPUs)");
    } else {
        topoParts.push(`${gpuCount} GPU${gpuCount === 1 ? "" : "s"}${mixParts.length > 0 ? ` (${mixParts.join(" + ")})` : ""}`);
    }
    if (combinedVramMib !== null) {
        topoParts.push(`${formatMib(combinedVramMib)} VRAM`);
    }

    const resParts: string[] = [];
    if (modelCount > 0 || source === "node") {
        resParts.push(`${modelCount} ${modelCount === 1 ? "model" : "models"}`);
    }
    if (totalBackends > 0) {
        resParts.push(`${availableBackends}/${totalBackends} backend${totalBackends === 1 ? "" : "s"}`);
    }
    const deviceSpec = llamaArgDevice ?? (recommendedDevices.length > 0 ? recommendedDevices.join(",") : null);
    if (deviceSpec) {
        resParts.push(deviceSpec);
    }
    if (platform) {
        resParts.push(platform);
    }

    return {
        source,
        platform,
        gpuCount,
        discreteCount,
        umaCount,
        hybridPoolAvailable,
        combinedVramMib,
        combinedFreeVramMib,
        recommendedDevices,
        llamaArgDevice,
        gpus,
        modelCount,
        modelNames,
        availableBackends,
        totalBackends,
        activeCapabilities,
        topologyLabel: topoParts.join(" · "),
        residencyLabel: resParts.length > 0 ? resParts.join(" · ") : null,
    };
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
        nodeId: normalizeNodeId(identity?.node_id) ?? normalizeNodeId(c.node?.nodeId),
        title: identity?.name ?? c.label ?? hostOf(c.url),
        role: identity?.role ?? "role unknown",
        version: identity?.version ?? c.node?.version ?? "—",
        instance: shortInstance(identity?.instance_id ?? c.node?.instanceId),
        transport: s.transport ?? "—",
        url: redactUrlSecrets(c.streamUrl ?? c.url),
        state,
        received: s.received,
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
        synthetic: identity?.synthetic === true || c.node?.synthetic === true,
        nodeHardware: producerNodeSummary(c),
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

export interface ProducersPanelOptions {
    /** Clock for live event-rate tracking; injectable for tests. */
    now?: () => number;
}

/** Element references of one card; everything else is patched in place. */
interface CardParts {
    root: HTMLLIElement;
    article: HTMLElement;
    title: HTMLHeadingElement;
    node: HTMLElement;
    synthetic: HTMLElement;
    state: HTMLElement;
    metaHead: Text;
    instance: HTMLElement;
    metaTail: Text;
    url: HTMLElement;
    hwBox: HTMLElement;
    hwTopology: HTMLElement;
    hwHybrid: HTMLElement;
    hwGpus: HTMLUListElement;
    hwResidency: HTMLElement;
    hwCaps: HTMLElement;
    counters: HTMLElement;
    counterValues: Map<string, HTMLElement>;
    rateRow: HTMLElement;
    rateValue: HTMLElement;
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
    private readonly rateTracker = new ProducerRateTracker();
    private readonly now: () => number;
    private rateTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly callbacks: ProducersPanelCallbacks,
        options: ProducersPanelOptions = {},
    ) {
        this.now = options.now ?? (() => Date.now());
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
        const now = this.now();
        const seen = new Set<string>();
        let hasLive = false;
        models.forEach((m, index) => {
            seen.add(m.id);
            if (m.state === "live") {
                hasLive = true;
            }
            let parts = this.cards.get(m.id);
            if (!parts) {
                parts = this.buildCard(m.id);
                this.cards.set(m.id, parts);
            }
            if (this.list.children[index] !== parts.root) {
                this.list.insertBefore(parts.root, this.list.children[index] ?? null);
            }
            this.patch(parts, m);
            const rate = this.rateTracker.observe(m.id, m.received, m.state, now);
            this.patchRate(parts, m.state, rate);
        });
        for (const [id, parts] of this.cards) {
            if (!seen.has(id)) {
                parts.root.remove();
                this.cards.delete(id);
                this.rateTracker.delete(id);
            }
        }
        this.empty.hidden = models.length > 0;
        this.syncRateTimer(hasLive);
    }

    dispose(): void {
        this.syncRateTimer(false);
    }

    private buildCard(id: string): CardParts {
        const titleId = `producer-title-${id}`;
        const title = h("h3", { id: titleId, class: "producer-name" });
        const node = h("span", { class: "tag producer-node mono", "data-testid": "producer-node", hidden: true });
        const synthetic = h("span", { class: "tag tag-synthetic", text: "SYNTHETIC", hidden: true });
        const state = h("span", { class: "state-word", "data-testid": "producer-state" });
        const metaHead = document.createTextNode("");
        const instance = h("span", { class: "mono" });
        const metaTail = document.createTextNode("");
        const url = h("p", { class: "producer-url mono" });
        const hwTopology = h("span", { class: "producer-hw-topology", "data-testid": "producer-hw-topology" });
        const hwHybrid = h("span", {
            class: "producer-hw-pill producer-hw-hybrid",
            "data-testid": "producer-hw-hybrid",
            text: "Hybrid Vulkan",
            hidden: true,
        });
        const hwGpus = h("ul", { class: "producer-hw-gpus", "data-testid": "producer-hw-gpus" });
        const hwResidency = h("p", { class: "producer-hw-meta", "data-testid": "producer-hw-residency", hidden: true });
        const hwCaps = h("div", { class: "producer-hw-caps", "data-testid": "producer-hw-caps", hidden: true });
        const hwBox = h(
            "div",
            { class: "producer-node-hw", "data-testid": "producer-node-hw", hidden: true },
            h("div", { class: "producer-hw-head" }, hwTopology, hwHybrid),
            hwGpus,
            hwResidency,
            hwCaps,
        );
        const rateValue = h("dd", {
            class: "mono producer-rate",
            "data-testid": "producer-rate",
            "data-counter": "rate",
            "data-active": "false",
        });
        const rateRow = h("div", { class: "producer-rate-row", hidden: true }, h("dt", { text: "rate" }), rateValue);
        const counters = h("dl", { class: "counters", "data-testid": "producer-counters" }, rateRow);
        const error = h("p", { class: "producer-error", hidden: true });
        const advice = h("p", { class: "producer-advice", hidden: true });
        const actions = h("div", { class: "card-actions" });
        const article = h(
            "article",
            { class: "producer-card", "data-testid": "producer-card", "aria-labelledby": titleId },
            h("div", { class: "producer-head" }, title, node, synthetic, state),
            h("p", { class: "producer-meta" }, metaHead, instance, metaTail),
            url,
            hwBox,
            counters,
            error,
            advice,
            actions,
        );
        return {
            root: h("li", {}, article),
            article,
            title,
            node,
            synthetic,
            state,
            metaHead,
            instance,
            metaTail,
            url,
            hwBox,
            hwTopology,
            hwHybrid,
            hwGpus,
            hwResidency,
            hwCaps,
            counters,
            counterValues: new Map(),
            rateRow,
            rateValue,
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
        if (m.nodeId !== null) {
            setAttr(p.article, "data-node", m.nodeId);
            p.node.hidden = false;
            setText(p.node, m.nodeId);
            setAttr(p.node, "title", `Node: ${m.nodeId}`);
        } else {
            p.article.removeAttribute("data-node");
            p.node.hidden = true;
            setText(p.node, "");
            p.node.removeAttribute("title");
        }
        setText(p.title, m.title);
        p.synthetic.hidden = !m.synthetic;
        setText(p.state, m.state);
        setAttr(p.state, "data-tone", STATE_TONE[m.state]);
        setText(p.metaHead, `${m.role} · ${m.version} · instance `);
        setText(p.instance, m.instance);
        setText(p.metaTail, ` · ${m.transport}`);
        setText(p.url, m.url);
        setAttr(p.url, "title", m.url);
        this.patchNodeHardware(p, m.nodeHardware);
        for (const [name, value] of m.counters) {
            let dd = p.counterValues.get(name);
            if (!dd) {
                dd = h("dd", { class: "mono producer-counter-value", "data-counter": name });
                p.counters.insertBefore(h("div", {}, h("dt", { text: name }), dd), p.rateRow);
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

    private patchNodeHardware(p: CardParts, hw: ProducerNodeSummary | null): void {
        if (!hw) {
            p.hwBox.hidden = true;
            p.hwGpus.replaceChildren();
            p.hwCaps.replaceChildren();
            return;
        }
        p.hwBox.hidden = false;
        setAttr(p.hwBox, "data-source", hw.source);
        setText(p.hwTopology, hw.topologyLabel);
        p.hwHybrid.hidden = !hw.hybridPoolAvailable;
        if (hw.hybridPoolAvailable) {
            const devTip = hw.llamaArgDevice ?? hw.recommendedDevices.join(",");
            setAttr(p.hwHybrid, "title", devTip ? `Hybrid discrete + UMA Vulkan pool (${devTip})` : "Hybrid discrete + UMA Vulkan pool available");
        } else {
            p.hwHybrid.removeAttribute("title");
        }

        const shownGpus = hw.gpus.slice(0, MAX_INLINE_GPUS);
        const gpuItems = shownGpus.map((gpu) => {
            const clsTag = gpu.gpuClass === "integrated-uma" ? "UMA" : gpu.gpuClass === "discrete" ? "dGPU" : "GPU";
            const vramText =
                gpu.effectiveVramMib !== null
                    ? gpu.effectiveFreeVramMib !== null && gpu.effectiveFreeVramMib <= gpu.effectiveVramMib
                        ? `${formatMib(gpu.effectiveFreeVramMib)} free / ${formatMib(gpu.effectiveVramMib)}`
                        : formatMib(gpu.effectiveVramMib)
                    : gpu.dedicatedTotalMib !== null
                      ? formatMib(gpu.dedicatedTotalMib)
                      : null;
            const tipParts = [gpu.name, gpu.id, clsTag];
            if (gpu.backendHint) {
                tipParts.push(gpu.backendHint);
            }
            if (gpu.gpuClass === "integrated-uma" && gpu.dedicatedTotalMib !== null && gpu.sharedTotalMib !== null) {
                tipParts.push(`${formatMib(gpu.dedicatedTotalMib)} carveout + ${formatMib(gpu.sharedTotalMib)} shared`);
            } else if (vramText) {
                tipParts.push(vramText);
            }
            return h(
                "li",
                { class: "producer-hw-gpu", "data-gpu-class": gpu.gpuClass, title: tipParts.join(" · ") },
                h("span", { class: "producer-hw-gpu-name", text: gpu.name }),
                h("span", { class: `producer-hw-pill producer-hw-class-${gpu.gpuClass}`, text: clsTag }),
                gpu.backendHint ? h("span", { class: "producer-hw-pill mono", text: gpu.backendHint }) : null,
                vramText ? h("span", { class: "producer-hw-vram mono", text: vramText }) : null,
            );
        });
        if (hw.gpus.length > MAX_INLINE_GPUS) {
            gpuItems.push(h("li", { class: "producer-hw-more muted", text: `+${hw.gpus.length - MAX_INLINE_GPUS} more GPUs` }));
        }
        p.hwGpus.hidden = gpuItems.length === 0;
        p.hwGpus.replaceChildren(...gpuItems);

        p.hwResidency.hidden = !hw.residencyLabel;
        setText(p.hwResidency, hw.residencyLabel ?? "");
        if (hw.modelNames.length > 0) {
            setAttr(p.hwResidency, "title", `Models: ${hw.modelNames.slice(0, 8).join(", ")}${hw.modelNames.length > 8 ? ` (+${hw.modelNames.length - 8} more)` : ""}`);
        } else {
            p.hwResidency.removeAttribute("title");
        }

        const shownCaps = hw.activeCapabilities.slice(0, MAX_INLINE_CAPS);
        p.hwCaps.hidden = shownCaps.length === 0;
        if (shownCaps.length > 0) {
            const capEls = shownCaps.map((cap) => h("span", { class: "producer-hw-pill mono", text: cap }));
            if (hw.activeCapabilities.length > MAX_INLINE_CAPS) {
                capEls.push(h("span", { class: "producer-hw-pill", text: `+${hw.activeCapabilities.length - MAX_INLINE_CAPS}` }));
            }
            p.hwCaps.replaceChildren(...capEls);
        } else {
            p.hwCaps.replaceChildren();
        }
    }

    private patchRate(p: CardParts, state: ProducerState, rate: EventRateSnapshot | null): void {
        const visible = state === "live" && rate !== null;
        p.rateRow.hidden = !visible;
        if (!visible) {
            setAttr(p.rateValue, "data-active", "false");
            p.rateValue.removeAttribute("title");
            return;
        }
        setText(p.rateValue, formatEventRate(rate));
        setAttr(p.rateValue, "data-active", rate.active ? "true" : "false");
        const detail =
            rate.lastEventAgeMs !== null
                ? `${formatRateNumber(rate.eventsPerSec)} events/s over the last 5s (last event ${formatRelativeAge(rate.lastEventAgeMs)})`
                : `${formatRateNumber(rate.eventsPerSec)} events/s over the last 5s (waiting for events)`;
        setAttr(p.rateValue, "title", detail);
    }

    private syncRateTimer(hasLive: boolean): void {
        if (hasLive && this.rateTimer === null) {
            this.rateTimer = setInterval(() => this.refreshRates(), RATE_REFRESH_MS);
            (this.rateTimer as unknown as { unref?: () => void }).unref?.();
        } else if (!hasLive && this.rateTimer !== null) {
            clearInterval(this.rateTimer);
            this.rateTimer = null;
        }
    }

    private refreshRates(): void {
        const now = this.now();
        let hasLive = false;
        for (const [id, parts] of this.cards) {
            if (parts.last?.state === "live") {
                hasLive = true;
                this.patchRate(parts, "live", this.rateTracker.snapshot(id, now));
            }
        }
        if (!hasLive) {
            this.syncRateTimer(false);
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
