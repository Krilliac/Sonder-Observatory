/**
 * Header status badges, connection/mode chips, synthetic data banner,
 * action button labels, and the #warnings polite live region.
 */
import type { ProducerConnection } from "../ingest/live/manager";
import { RECORDING_EXTENSION } from "../recording/sobs";
import type { SessionStore } from "../replay/session";
import { byId, h } from "./dom";
import { producersInSession, syntheticBannerText } from "./navigation";
import { producerCardModel } from "./producersPanel";

export interface HeaderStatusInput {
    store: SessionStore;
    connections: readonly ProducerConnection[];
    closedCount: number;
    follow: boolean;
    playing: boolean;
    speed: number;
}

export interface WarningsInput {
    store: SessionStore;
    connections: readonly ProducerConnection[];
    launchNotices: readonly string[];
    notices: readonly string[];
    navNotice: string | null;
    exportNotice: string | null;
}

export function liveSummary(connections: readonly ProducerConnection[], closedCount: number): { label: string; tone: string } {
    if (connections.length === 0) {
        return closedCount > 0 ? { label: "disconnected", tone: "idle" } : { label: "not connected", tone: "idle" };
    }
    const counts = new Map<string, number>();
    for (const c of connections) {
        const word = producerCardModel(c).state;
        counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    const label = [...counts.entries()].map(([word, n]) => `${n} ${word}`).join(" · ");
    const tone = counts.has("failed") ? "error" : counts.has("connecting") || counts.has("reconnecting") ? "warn" : "ok";
    return { label, tone };
}

/**
 * Header status chips (design board "Status indicators"): the connection
 * and whether the view follows live data or replays. Words carry the
 * state; the dot colour only repeats it.
 */
function renderChips(input: HeaderStatusInput, liveTone: string): void {
    const conn = byId("conn-chip");
    const mode = byId("mode-chip");
    const n = input.connections.length;
    let connText = "";
    let connTone = "idle";
    if (n > 0) {
        connTone = liveTone === "ok" ? "ok" : liveTone;
        connText = liveTone === "ok" ? `Connected · ${n} producer${n === 1 ? "" : "s"}` : liveTone === "error" ? "Connection failed" : "Connecting";
    } else if (input.closedCount > 0) {
        connText = "Disconnected";
    } else if (input.store.source === "file" || input.store.source === "fixture") {
        connText = "Offline · recording";
    }
    let modeText = "";
    let modeTone = "idle";
    if (input.store.events.length > 0) {
        if (input.store.source === "live" && input.follow) {
            modeText = "Live";
            modeTone = "live";
        } else if (input.playing) {
            modeText = `Replaying · ${input.speed}×`;
            modeTone = "live";
        } else {
            modeText = input.follow ? "Replay · at end" : "Replay · paused at cursor";
        }
    }
    if (conn.textContent !== connText || conn.dataset.tone !== connTone) {
        conn.textContent = connText;
        conn.dataset.tone = connTone;
    }
    if (mode.textContent !== modeText || mode.dataset.tone !== modeTone) {
        mode.textContent = modeText;
        mode.dataset.tone = modeTone;
    }
}

export function renderHeaderStatus(input: HeaderStatusInput): void {
    const s = input.store;
    const liveCount = input.connections.length + input.closedCount;
    const sourceText =
        s.source === "none"
            ? liveCount > 0
                ? "connecting…"
                : "no data"
            : s.source === "live"
              ? `live · ${liveCount} producer${liveCount === 1 ? "" : "s"}`
              : `${s.source === "file" ? "recording" : "fixture"}${s.truncatedRecording ? " (partial)" : ""} · ${s.sourceLabel}`;
    byId("source-badge").textContent = sourceText;
    const producers = producersInSession(s.events);
    const syntheticNames = producers.filter((p) => p.synthetic).map((p) => p.name);
    const synthetic = s.manifest?.synthetic === true || syntheticNames.length > 0;
    byId("synthetic-badge").hidden = !synthetic;
    const banner = byId("synthetic-banner");
    banner.hidden = !synthetic;
    const bannerText = syntheticBannerText(syntheticNames);
    if (banner.textContent !== bannerText) {
        banner.textContent = bannerText;
    }
    byId("capture-badge").textContent = `text capture: ${s.capturePolicy}`;
    const status = byId("live-status");
    const live = liveSummary(input.connections, input.closedCount);
    status.textContent = `live: ${live.label}`;
    status.dataset.tone = live.tone;
    renderChips(input, live.tone);
    const save = byId<HTMLButtonElement>("save-btn");
    save.disabled = s.events.length === 0;
    byId<HTMLButtonElement>("export-btn").disabled = s.events.length === 0;
    save.textContent =
        s.source === "live"
            ? `Save live session (${s.events.length} events${s.droppedByRetention > 0 ? `, ${s.droppedByRetention} older dropped` : ""})`
            : `Save (${RECORDING_EXTENSION})`;
    byId<HTMLButtonElement>("play-btn").textContent = input.playing ? "Pause" : "Play";
}

/** #warnings is a polite live region: it is rewritten only when its text changes. */
export function renderWarningsRegion(input: WarningsInput, previousText: string): string {
    const s = input.store;
    const items: string[] = [
        ...input.launchNotices,
        ...input.notices,
        ...(input.navNotice ? [input.navNotice] : []),
        ...(input.exportNotice ? [input.exportNotice] : []),
    ];
    const retention = s.retentionNotice;
    if (retention !== null) {
        items.push(retention);
    }
    const partial = s.partialRecordingNotice;
    if (partial !== null) {
        items.push(partial);
    }
    if (s.rejectedCount > 0) {
        const first = s.rejected[0]!;
        items.push(`${s.rejectedCount} line(s) rejected by the schema validator (first: line ${first.line}: ${first.reason})`);
    }
    if (s.gaps.length > 0) {
        const missing = s.gaps.reduce((n, g) => n + (g.to - g.from + 1), 0);
        items.push(`${missing} sequence number(s) missing across ${s.gaps.length} gap(s): possible dropped telemetry`);
    }
    if (s.duplicates > 0) {
        items.push(`${s.duplicates} duplicate event id(s) ignored`);
    }
    if (s.manifest && !s.manifest.complete) {
        items.push("recording manifest marks this session as incomplete");
    }
    for (const c of input.connections) {
        if (c.status.warning) {
            items.push(`${c.identity?.name ?? c.url}: ${c.status.warning}`);
        }
    }
    const text = items.join("\n");
    if (text === previousText) {
        return previousText;
    }
    byId("warnings").replaceChildren(...items.map((t) => h("div", { class: "warning", text: `⚠ ${t}` })));
    return text;
}
