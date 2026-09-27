/**
 * Desktop integration for the app shell: mode badge, native "Open recording…",
 * a recent-recordings menu and the --open / --connect launch arguments.
 * main.ts calls mountDesktopIntegration(app) once after ObservatoryApp.start();
 * the app is the host (openRecordingText, connectProducers). Every validated
 * `--connect` URL (LaunchInfo.connectAll) is connected, each with the bearer
 * token bound to it (LaunchInfo.connectTokens, never sent to ws(s) URLs and
 * never shown). fileInputHost() is the fallback host that goes through the
 * app's `#file-input` change handler.
 *
 * In a browser nothing changes except the "browser" badge: the existing
 * `<input type="file">` stays the open path and no recent menu is shown.
 */
import type { ProducerEndpointInput } from "../ingest/live/manager";
import * as bridge from "./desktop";
import { launchProducers, type OpenedRecording, type RecentRecording } from "./desktop";
import { modeBadge, runtimeMode } from "./mode";

export interface RecordingHost {
    openRecordingText(text: string, label: string): void;
    /** Connects every launch producer, with its own token. Optional so file-only hosts still fit. */
    connectProducers?(inputs: readonly ProducerEndpointInput[]): void;
    /** Older hosts: one URL, no token. Used only when connectProducers is absent. */
    connectLive?(url: string): void;
}

/** Subset of the bridge used here, injectable for tests. */
export type DesktopBridge = Pick<
    typeof bridge,
    "isDesktop" | "getLaunchInfo" | "openRecordingNative" | "listRecentRecordings" | "openRecentRecordingText" | "clearRecentRecordings" | "readGrantText"
>;

export interface RecentOption {
    value: string;
    text: string;
    disabled: boolean;
}

export const RECENT_PLACEHOLDER = "";
export const RECENT_CLEAR = "__clear__";

/** Options for the recent-recordings `<select>`. Pure for unit tests. */
export function recentOptions(items: readonly RecentRecording[]): RecentOption[] {
    if (items.length === 0) {
        return [{ value: RECENT_PLACEHOLDER, text: "No recent recordings", disabled: true }];
    }
    return [
        { value: RECENT_PLACEHOLDER, text: "Recent…", disabled: false },
        ...items.map((r) => ({
            value: r.id,
            text: `${r.kind === "folder" ? "📁 " : ""}${r.name}${r.available ? "" : " (missing)"}`,
            disabled: !r.available,
        })),
        { value: RECENT_CLEAR, text: "Clear recent", disabled: false },
    ];
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export class DesktopIntegration {
    private status: HTMLElement | null = null;
    private recent: HTMLSelectElement | null = null;

    constructor(
        private readonly host: RecordingHost,
        private readonly doc: Document = document,
        private readonly api: DesktopBridge = bridge,
    ) {}

    get desktop(): boolean {
        return this.api.isDesktop();
    }

    /** Wire the badge and, in desktop mode, the native open + recent menu. */
    async mount(): Promise<void> {
        this.mountBadge();
        if (!this.desktop) {
            return;
        }
        this.mountDesktopControls();
        await this.refreshRecent();
        await this.applyLaunch();
    }

    /** Load a recording through the native dialog (desktop only). */
    async openNative(): Promise<void> {
        await this.run(() => this.api.openRecordingNative());
    }

    async openRecent(id: string): Promise<void> {
        if (id === RECENT_CLEAR) {
            await this.run(async () => {
                await this.api.clearRecentRecordings();
                return null;
            });
            return;
        }
        if (id !== RECENT_PLACEHOLDER) {
            await this.run(() => this.api.openRecentRecordingText(id));
        }
    }

    async refreshRecent(): Promise<void> {
        if (!this.recent) {
            return;
        }
        let items: RecentRecording[] = [];
        try {
            items = await this.api.listRecentRecordings();
        } catch (err) {
            this.setStatus(`recent recordings unavailable: ${errorText(err)}`);
        }
        this.recent.replaceChildren(
            ...recentOptions(items).map((o) => {
                const opt = this.doc.createElement("option");
                opt.value = o.value;
                opt.textContent = o.text;
                opt.disabled = o.disabled;
                return opt;
            }),
        );
        this.recent.value = RECENT_PLACEHOLDER;
        this.recent.disabled = items.length === 0;
    }

    private async applyLaunch(): Promise<void> {
        try {
            const info = await this.api.getLaunchInfo();
            if (!info) {
                return;
            }
            if (info.warnings.length > 0) {
                this.setStatus(info.warnings.join(" · "));
            }
            const open = info.open;
            const producers = launchProducers(info);
            if (open) {
                if (producers.length > 0) {
                    // One source at a time: the recording wins over --connect.
                    this.setStatus([...info.warnings, "--open and --connect both given; opened the recording"].join(" · "));
                }
                await this.run(() => this.api.readGrantText(open), false);
            } else if (producers.length > 0) {
                this.connectLaunchProducers(producers, info.warnings);
            }
        } catch (err) {
            this.setStatus(`launch arguments unavailable: ${errorText(err)}`);
        }
    }

    private connectLaunchProducers(producers: ProducerEndpointInput[], warnings: readonly string[]): void {
        if (this.host.connectProducers) {
            this.host.connectProducers(producers);
            return;
        }
        if (!this.host.connectLive) {
            return;
        }
        // A host without token support must not silently drop a token: skip those URLs and say so.
        const skipped = producers.filter((p) => p.token !== undefined).map((p) => p.url);
        for (const p of producers) {
            if (p.token === undefined) {
                this.host.connectLive(p.url);
            }
        }
        if (skipped.length > 0) {
            this.setStatus([...warnings, `not connected (this viewer cannot send tokens): ${skipped.join(", ")}`].join(" · "));
        }
    }

    private async run(load: () => Promise<OpenedRecording | null>, clearStatus = true): Promise<void> {
        try {
            const opened = await load();
            if (opened) {
                this.host.openRecordingText(opened.text, opened.label);
                if (clearStatus) {
                    this.setStatus("");
                }
            }
        } catch (err) {
            this.setStatus(`could not open recording: ${errorText(err)}`);
        }
        await this.refreshRecent();
    }

    private setStatus(text: string): void {
        if (this.status) {
            this.status.textContent = text;
            this.status.hidden = text === "";
        }
    }

    private mountBadge(): void {
        const mode = runtimeMode(this.desktop);
        const { text, title } = modeBadge(mode);
        const badge = this.doc.createElement("span");
        badge.id = "mode-badge";
        badge.className = "badge";
        badge.dataset.mode = mode;
        badge.textContent = text;
        badge.title = title;
        this.doc.getElementById("capture-badge")?.after(badge);
    }

    private mountDesktopControls(): void {
        const openLabel = this.doc.querySelector<HTMLLabelElement>('label[for="file-input"]');
        // Native dialog instead of the webview file input. The input stays in
        // the DOM (and keeps working) as the fallback.
        openLabel?.addEventListener(
            "click",
            (ev) => {
                ev.preventDefault();
                void this.openNative();
            },
            { capture: true },
        );
        if (openLabel) {
            openLabel.title = "Open a .sobs / .ndjson recording with the native file dialog";
        }

        const recent = this.doc.createElement("select");
        recent.id = "recent-select";
        recent.setAttribute("aria-label", "Recent recordings");
        recent.addEventListener("change", () => {
            const id = recent.value;
            recent.value = RECENT_PLACEHOLDER;
            void this.openRecent(id);
        });
        this.recent = recent;

        const status = this.doc.createElement("span");
        status.id = "desktop-status";
        status.className = "muted";
        status.setAttribute("role", "status");
        status.hidden = true;
        this.status = status;

        const anchor = this.doc.getElementById("file-input") ?? openLabel;
        anchor?.after(recent, status);
    }
}

/**
 * Default host: wraps the text in a File and dispatches `change` on the app's
 * `#file-input`, exactly as if the user had picked it in the browser dialog.
 */
export function fileInputHost(doc: Document = document): RecordingHost {
    return {
        openRecordingText(text: string, label: string): void {
            const input = doc.getElementById("file-input");
            if (!(input instanceof HTMLInputElement)) {
                throw new Error("missing #file-input");
            }
            const transfer = new DataTransfer();
            transfer.items.add(new File([text], label, { type: "application/x-ndjson" }));
            input.files = transfer.files;
            input.dispatchEvent(new Event("change"));
        },
    };
}

/** Entry point used by src/renderer/main.ts. */
export function mountDesktopIntegration(host: RecordingHost = fileInputHost()): DesktopIntegration {
    const integration = new DesktopIntegration(host);
    void integration.mount();
    return integration;
}
