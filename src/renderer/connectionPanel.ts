/**
 * Sources panel (#connection-panel): producer URL, transport, bearer token,
 * Test (probeProducer) and Connect, the LOCAL_PRESETS and up to eight recent
 * endpoints.
 *
 * Tokens: the #token-input value goes straight into the connection request
 * (LiveConnectionManager keeps it in memory for that producer) and the field
 * is cleared afterwards. Tokens are never stored, logged, put in a URL or
 * written into the DOM. Recent endpoints store only URL and transport, in
 * localStorage (per viewer, try/catch: it may be unavailable).
 */
import { classifyProducerUrl } from "../ingest/live/discovery";
import type { TransportPreference } from "../ingest/live/endpoint";
import { LOCAL_PRESETS, probeProducer, type ProbeOptions, type ProbeResult, type ProducerEndpointInput } from "../ingest/live/manager";
import { h } from "./dom";
import { redactUrlSecrets } from "./params";

export const RECENT_ENDPOINTS_KEY = "sonder-observatory.recent-endpoints";
export const MAX_RECENT_ENDPOINTS = 8;

export const TRANSPORT_OPTIONS: readonly { value: TransportPreference; label: string }[] = [
    { value: "auto", label: "Auto (discovery or URL)" },
    { value: "sse", label: "SSE" },
    { value: "ndjson", label: "NDJSON" },
    { value: "websocket", label: "WebSocket" },
];

export interface RecentEndpoint {
    url: string;
    transport: TransportPreference;
}

function isTransport(value: unknown): value is TransportPreference {
    return TRANSPORT_OPTIONS.some((o) => o.value === value);
}

/** Whether a URL may be remembered: it must pass the endpoint policy (no credentials, no token params). */
export function rememberable(url: string): boolean {
    const classified = classifyProducerUrl(url);
    return classified.ok && classified.kind !== null;
}

/** Parses the stored list, dropping anything malformed or no longer allowed. */
export function parseRecentEndpoints(raw: string | null): RecentEndpoint[] {
    if (!raw) {
        return [];
    }
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(value)) {
        return [];
    }
    const out: RecentEndpoint[] = [];
    for (const item of value) {
        const url = (item as { url?: unknown })?.url;
        const transport = (item as { transport?: unknown })?.transport;
        if (typeof url === "string" && rememberable(url) && !out.some((e) => e.url === url)) {
            out.push({ url, transport: isTransport(transport) ? transport : "auto" });
        }
        if (out.length >= MAX_RECENT_ENDPOINTS) {
            break;
        }
    }
    return out;
}

/** Most recent first, deduplicated by URL, at most MAX_RECENT_ENDPOINTS. */
export function rememberEndpoint(list: readonly RecentEndpoint[], entry: RecentEndpoint): RecentEndpoint[] {
    if (!rememberable(entry.url)) {
        return [...list];
    }
    return [entry, ...list.filter((e) => e.url !== entry.url)].slice(0, MAX_RECENT_ENDPOINTS);
}

export function loadRecentEndpoints(storage: Storage | null): RecentEndpoint[] {
    try {
        return parseRecentEndpoints(storage?.getItem(RECENT_ENDPOINTS_KEY) ?? null);
    } catch {
        return [];
    }
}

export function saveRecentEndpoints(storage: Storage | null, list: readonly RecentEndpoint[]): void {
    try {
        if (list.length === 0) {
            storage?.removeItem(RECENT_ENDPOINTS_KEY);
        } else {
            storage?.setItem(RECENT_ENDPOINTS_KEY, JSON.stringify(list.map(({ url, transport }) => ({ url, transport }))));
        }
    } catch {
        // Recent endpoints are a convenience; without storage the list lives for this page only.
    }
}

const TOKEN_ERROR = /bearer token|HTTP 401|unauthori[sz]ed/i;
/** The endpoint policy refused a URL that carries a secret (src/ingest/live/endpoint.ts). */
const SECRET_IN_URL = /credentials in the URL are not allowed|query parameter is not allowed: tokens never go in URLs/i;
const CORS_SETTINGS = /SONDER_OBSERVATORY_ORIGINS|SONDER_CORS_ORIGINS|--cors-origin/;

/**
 * Fallback CORS guidance when a network error hides the cause. Same order and
 * caveat as discovery.ts corsHint: the route-scoped Runtime setting first;
 * the global SONDER_CORS_ORIGINS only where it is missing, because it also
 * opens the admin routes to that origin.
 */
export const CORS_ADVICE =
    "If the producer is running, allow this page's origin: Sonder Runtime lists it in SONDER_OBSERVATORY_ORIGINS " +
    "(telemetry routes only; on runtimes without that setting SONDER_CORS_ORIGINS works too, but it also allows " +
    "that origin to call admin routes); Sonder-Inference takes --cors-origin.";

/**
 * Extra guidance for a connection or probe error: what to change. The
 * underlying messages already name the CORS settings; this adds the token
 * step and falls back to naming the settings when a network error hides CORS.
 */
export function connectionAdvice(error: string, hasToken: boolean, corsSuspected = false): string | null {
    if (SECRET_IN_URL.test(error)) {
        return "Remove the credentials or token parameter from the URL, and paste the token into Sources > Bearer token instead.";
    }
    if (TOKEN_ERROR.test(error)) {
        return hasToken
            ? "The producer rejected this token. Check the token and connect again."
            : "This producer needs a token: paste it into Sources > Bearer token and connect again.";
    }
    if (corsSuspected && !CORS_SETTINGS.test(error)) {
        return CORS_ADVICE;
    }
    return null;
}

export interface ProbeReport {
    ok: boolean;
    lines: string[];
}

/** Human-readable result of the Test button. */
export function describeProbe(url: string, result: ProbeResult, hasToken: boolean): ProbeReport {
    if (!result.ok) {
        const advice = connectionAdvice(result.error ?? "", hasToken, result.corsSuspected);
        return { ok: false, lines: [`Test failed for ${redactUrlSecrets(url)}: ${result.error ?? "unknown error"}`, ...(advice ? [advice] : [])] };
    }
    const d = result.discovery;
    if (!d) {
        return { ok: true, lines: [`Reachable: ${result.streamUrl ?? url} answered as a telemetry stream (no discovery document).`] };
    }
    const p = d.producer;
    const transports = d.streams.map((s) => s.transport).join(", ");
    return {
        ok: true,
        lines: [
            `Found ${p.name} ${p.version} (role ${p.role}${p.synthetic ? ", SYNTHETIC data" : ""}) on node ${p.node_id}, instance ${p.instance_id}.`,
            `Streams: ${transports}; would open ${result.streamUrl ?? "none"}.`,
            `Auth: ${d.auth.required ? `bearer token required${hasToken ? " (token given)" : " (enter it under Bearer token)"}` : "none"}. Retained events: ${d.resume.retained_events}.`,
        ],
    };
}

export interface ConnectionPanelCallbacks {
    onConnect(input: ProducerEndpointInput): void;
    /** Injected for tests; defaults to probeProducer. */
    probe?: (url: string, opts: ProbeOptions) => Promise<ProbeResult>;
}

export class ConnectionPanel {
    readonly element: HTMLElement;
    private readonly urlInput: HTMLInputElement;
    private readonly transport: HTMLSelectElement;
    private readonly token: HTMLInputElement;
    private readonly result: HTMLElement;
    private readonly recentList: HTMLUListElement;
    private readonly recentSection: HTMLElement;
    private recent: RecentEndpoint[];
    private probeRun = 0;

    constructor(
        private readonly storage: Storage | null,
        private readonly callbacks: ConnectionPanelCallbacks,
        initialUrl = "",
    ) {
        this.recent = loadRecentEndpoints(storage);
        this.urlInput = h("input", {
            id: "ws-url",
            type: "text",
            inputmode: "url",
            value: redactUrlSecrets(initialUrl),
            placeholder: "http://127.0.0.1:11435",
            spellcheck: "false",
            autocomplete: "off",
            "aria-describedby": "ws-url-help",
        });
        this.transport = h(
            "select",
            { id: "transport-select" },
            ...TRANSPORT_OPTIONS.map((o) => h("option", { value: o.value, text: o.label })),
        );
        this.token = h("input", {
            id: "token-input",
            type: "password",
            autocomplete: "off",
            spellcheck: "false",
            "aria-describedby": "token-help",
        });
        this.result = h("div", { id: "probe-result", class: "probe-result", role: "status", "aria-live": "polite" });
        const probeBtn = h("button", { id: "probe-btn", type: "button", text: "Test" });
        const connectBtn = h("button", { id: "connect-btn", type: "submit", class: "primary", text: "Connect" });
        const form = h(
            "form",
            { id: "connection-form", class: "connection-form", novalidate: true },
            h("label", { for: "ws-url", text: "Producer URL" }),
            this.urlInput,
            h("p", { id: "ws-url-help", class: "hint", text: "Base URL (finds the stream via discovery), discovery URL, or stream URL: http(s)://, ws(s)://." }),
            h("div", { class: "field-row" }, h("label", { for: "transport-select", text: "Transport" }), this.transport),
            h("label", { for: "token-input", text: "Bearer token (optional)" }),
            this.token,
            h("p", { id: "token-help", class: "hint", text: "Kept in memory for this connection only: never saved, logged or put in the URL." }),
            h("div", { class: "form-actions" }, probeBtn, connectBtn),
            this.result,
        );
        form.addEventListener("submit", (ev) => {
            ev.preventDefault();
            this.connect();
        });
        probeBtn.addEventListener("click", () => void this.test());

        const presets = h(
            "ul",
            { id: "preset-list", class: "endpoint-list" },
            ...LOCAL_PRESETS.map((p) => {
                const btn = h("button", { type: "button", class: "endpoint-btn", "data-url": p.url });
                btn.append(h("span", { class: "endpoint-label", text: p.label }), h("span", { class: "endpoint-url mono", text: p.url }));
                btn.addEventListener("click", () => this.fill({ url: p.url, transport: "auto" }));
                return h("li", {}, btn);
            }),
        );
        this.recentList = h("ul", { id: "recent-endpoints", class: "endpoint-list" });
        const clear = h("button", { id: "recent-clear", type: "button", class: "small", text: "Clear recent" });
        clear.addEventListener("click", () => {
            this.recent = [];
            saveRecentEndpoints(this.storage, this.recent);
            this.renderRecent();
        });
        this.recentSection = h("div", { class: "recent-block" }, h("div", { class: "subhead" }, h("h3", { text: "Recent" }), clear), this.recentList);

        this.element = h(
            "section",
            { id: "connection-panel", class: "side-section", role: "region", "aria-labelledby": "sources-title" },
            h("h2", { id: "sources-title", text: "Sources" }),
            form,
            h("h3", { text: "Local presets" }),
            presets,
            this.recentSection,
        );
        this.renderRecent();
    }

    get url(): string {
        return this.urlInput.value.trim();
    }

    /** Fills the form (presets, recent entries, a producer card's Edit). */
    fill(entry: { url: string; transport?: TransportPreference }, focus: "url" | "token" = "url"): void {
        this.urlInput.value = entry.url;
        this.transport.value = entry.transport ?? "auto";
        this.setResult(null);
        (focus === "token" ? this.token : this.urlInput).focus();
    }

    focusUrl(): void {
        this.urlInput.focus();
    }

    setResult(report: ProbeReport | null): void {
        if (!report) {
            this.result.replaceChildren();
            delete this.result.dataset.tone;
            return;
        }
        this.result.dataset.tone = report.ok ? "ok" : "error";
        this.result.replaceChildren(...report.lines.map((line) => h("p", { text: line })));
    }

    private readToken(): string | undefined {
        const token = this.token.value.trim();
        return token === "" ? undefined : token;
    }

    private connect(): void {
        const url = this.url;
        if (url === "") {
            this.setResult({ ok: false, lines: ["Enter a producer URL first, or pick a preset."] });
            this.urlInput.focus();
            return;
        }
        const transport = this.transport.value as TransportPreference;
        const token = this.readToken();
        // The token leaves the DOM now; the manager keeps it for this producer only.
        this.token.value = "";
        this.setResult(null);
        this.callbacks.onConnect({ url, transport, ...(token !== undefined ? { token } : {}) });
        if (rememberable(url)) {
            this.recent = rememberEndpoint(this.recent, { url, transport });
            saveRecentEndpoints(this.storage, this.recent);
            this.renderRecent();
        }
    }

    private async test(): Promise<void> {
        const url = this.url;
        if (url === "") {
            this.setResult({ ok: false, lines: ["Enter a producer URL to test."] });
            return;
        }
        const token = this.readToken();
        const run = ++this.probeRun;
        this.result.dataset.tone = "pending";
        this.result.replaceChildren(h("p", { text: `Testing ${redactUrlSecrets(url)}…` }));
        const probe = this.callbacks.probe ?? probeProducer;
        const result = await probe(url, token !== undefined ? { token } : {});
        if (run === this.probeRun) {
            this.setResult(describeProbe(url, result, token !== undefined));
        }
    }

    private renderRecent(): void {
        this.recentSection.hidden = this.recent.length === 0;
        this.recentList.replaceChildren(
            ...this.recent.map((entry) => {
                const btn = h("button", { type: "button", class: "endpoint-btn", "data-url": entry.url });
                btn.append(h("span", { class: "endpoint-url mono", text: entry.url }));
                if (entry.transport !== "auto") {
                    btn.append(h("span", { class: "endpoint-label", text: entry.transport }));
                }
                btn.addEventListener("click", () => this.fill(entry));
                return h("li", {}, btn);
            }),
        );
    }
}
