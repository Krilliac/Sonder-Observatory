/**
 * Empty state (#onboarding), shown while there is no source: find local
 * Sonder producers (probe LOCAL_PRESETS with a 1 s timeout and list the ones
 * that answered, each with Connect), open a recording (button, or drop a file
 * on the window), or load the synthetic demo (labelled synthetic).
 */
import { LOCAL_PRESETS, probeProducer, type ProbeOptions, type ProbeResult } from "../ingest/live/manager";
import { h } from "./dom";
import { RECORDING_FILE_EXTENSIONS } from "./dropZone";

export const PRESET_PROBE_TIMEOUT_MS = 1000;

export type Preset = (typeof LOCAL_PRESETS)[number];

export interface PresetProbe {
    preset: Preset;
    result: ProbeResult;
}

/** Probes every preset in parallel; never throws. */
export async function probePresets(
    presets: readonly Preset[] = LOCAL_PRESETS,
    probe: (url: string, opts: ProbeOptions) => Promise<ProbeResult> = probeProducer,
    timeoutMs = PRESET_PROBE_TIMEOUT_MS,
): Promise<PresetProbe[]> {
    return Promise.all(
        presets.map(async (preset) => {
            try {
                return { preset, result: await probe(preset.url, { timeoutMs }) };
            } catch (error) {
                return {
                    preset,
                    result: { ok: false, discovery: null, streamUrl: null, error: (error as Error)?.message ?? String(error), corsSuspected: false },
                };
            }
        }),
    );
}

/** One line per answering preset. */
export function presetLine(p: PresetProbe): string {
    const d = p.result.discovery?.producer;
    if (!d) {
        return `${p.preset.label} at ${p.preset.url}`;
    }
    return `${p.preset.label}: ${d.name} ${d.version} (role ${d.role}) at ${p.preset.url}`;
}

export interface OnboardingCallbacks {
    onConnect(url: string): void;
    onOpenRecording(): void;
    onLoadDemo(): void;
    onShowSources(): void;
    probe?: (url: string, opts: ProbeOptions) => Promise<ProbeResult>;
}

export class Onboarding {
    readonly element: HTMLElement;
    private readonly status: HTMLElement;
    private readonly results: HTMLUListElement;
    private readonly findBtn: HTMLButtonElement;
    private run = 0;

    constructor(private readonly callbacks: OnboardingCallbacks) {
        this.findBtn = h("button", { id: "discover-btn", type: "button", class: "primary", text: "Find local Sonder producers" });
        this.findBtn.addEventListener("click", () => void this.discover());
        this.status = h("p", { id: "discover-status", class: "muted", role: "status", "aria-live": "polite" });
        this.results = h("ul", { id: "discover-results", class: "discover-results" });
        const sources = h("button", { type: "button", class: "link-button", text: "enter any producer URL in Sources" });
        sources.addEventListener("click", () => callbacks.onShowSources());
        const open = h("button", { id: "onboarding-open-btn", type: "button", text: "Open recording…" });
        open.addEventListener("click", () => callbacks.onOpenRecording());
        const demo = h("button", { id: "demo-btn", type: "button", text: "Load synthetic demo" });
        demo.addEventListener("click", () => callbacks.onLoadDemo());
        this.element = h(
            "section",
            { id: "onboarding", class: "onboarding", "aria-labelledby": "onboarding-title", hidden: true },
            h("h2", { id: "onboarding-title", text: "No data yet" }),
            h("p", { class: "lead", text: "Watch a Sonder producer live, replay a recording, or explore the synthetic demo." }),
            h(
                "div",
                { class: "onboarding-grid" },
                h(
                    "article",
                    { class: "onboarding-card", "aria-labelledby": "onboarding-live" },
                    h("h3", { id: "onboarding-live", text: "Live producers" }),
                    h("p", {
                        text: `Checks Sonder Runtime, Sonder-Inference and the fake producer on this machine (${LOCAL_PRESETS.map((p) => p.url).join(", ")}), waiting up to 1 s each.`,
                    }),
                    this.findBtn,
                    this.status,
                    this.results,
                    h("p", { class: "muted" }, "Elsewhere? ", sources, "."),
                ),
                h(
                    "article",
                    { class: "onboarding-card", "aria-labelledby": "onboarding-recording" },
                    h("h3", { id: "onboarding-recording", text: "Recording" }),
                    h("p", { text: `Drop a ${RECORDING_FILE_EXTENSIONS.join(", ")} file anywhere on this window, or open one.` }),
                    open,
                ),
                h(
                    "article",
                    { class: "onboarding-card", "aria-labelledby": "onboarding-demo" },
                    h("h3", { id: "onboarding-demo" }, "Synthetic demo ", h("span", { class: "tag tag-synthetic", text: "SYNTHETIC" })),
                    h("p", { text: "A generated session (fixtures/synthetic-session.ndjson). Not measured from Sonder Runtime or a model." }),
                    demo,
                ),
            ),
        );
    }

    setVisible(visible: boolean): void {
        this.element.hidden = !visible;
    }

    async discover(): Promise<void> {
        const run = ++this.run;
        this.findBtn.disabled = true;
        this.status.textContent = "Looking for local producers…";
        this.results.replaceChildren();
        try {
            const probes = await probePresets(LOCAL_PRESETS, this.callbacks.probe ?? probeProducer);
            if (run !== this.run) {
                return;
            }
            const found = probes.filter((p) => p.result.ok);
            const missing = probes.filter((p) => !p.result.ok).map((p) => p.preset.label);
            this.status.textContent =
                found.length === 0
                    ? `No local producer answered (${missing.join(", ")}). Start one, or connect in Sources.`
                    : `${found.length} producer(s) answered.${missing.length > 0 ? ` No answer from ${missing.join(", ")}.` : ""}`;
            this.results.replaceChildren(
                ...found.map((p) => {
                    const connect = h("button", { type: "button", class: "small", text: "Connect", "aria-label": `Connect to ${p.preset.label}`, "data-url": p.preset.url });
                    connect.addEventListener("click", () => this.callbacks.onConnect(p.preset.url));
                    const synthetic = p.result.discovery?.producer.synthetic === true || p.preset.role === "fixture";
                    return h(
                        "li",
                        { "data-url": p.preset.url },
                        h("span", { text: presetLine(p) }),
                        synthetic ? h("span", { class: "tag tag-synthetic", text: "SYNTHETIC" }) : null,
                        connect,
                    );
                }),
            );
        } finally {
            if (run === this.run) {
                this.findBtn.disabled = false;
            }
        }
    }
}
