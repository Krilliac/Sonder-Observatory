/**
 * Browser entry for the compare e2e harness (e2e/compare.spec.ts). Bundled
 * on the fly with Vite's build API and injected into the built app page, so
 * the Compare panel can be exercised before the host wires it into app.ts /
 * main.ts. The harness plays the host: it mounts the panel into #extra-panels
 * the way ObservatoryApp mounts extra panels and feeds it a PanelContext. The
 * app hides #extra-panels until a session is loaded and outside the Overview
 * view, so the spec loads the fixture on Overview before mounting.
 */
import { ComparePanel } from "../src/compare/panel";
import type { ObservatoryEvent } from "../src/protocol/events";
import { parseNdjson } from "../src/recording/ndjson";
import type { PanelContext } from "../src/renderer/panels";

export interface CompareHarness {
    /** Mounts the panel with `currentText` (NDJSON) as the viewer's current session. */
    mount(currentText: string, label: string): void;
    /** Appends NDJSON events to the current session (simulates live ingest) and re-renders. */
    append(text: string): void;
    currentEvents(): number;
}

declare global {
    interface Window {
        __compareHarness?: CompareHarness;
    }
}

let panel: ComparePanel | null = null;
let container: HTMLElement | null = null;
let label = "current session";
const current: ObservatoryEvent[] = [];

function ctx(): PanelContext {
    return {
        visible: current,
        all: current,
        selectedId: null,
        select: () => undefined,
        synthetic: current.some((e) => e.producer.synthetic === true),
    };
}

window.__compareHarness = {
    mount(currentText, currentLabel) {
        label = currentLabel;
        current.splice(0, current.length, ...parseNdjson(currentText).events);
        panel = new ComparePanel({ liveThrottleMs: 0, describeCurrent: () => label });
        const host = document.getElementById("extra-panels") ?? document.body;
        const section = document.createElement("section");
        section.className = "panel";
        section.setAttribute("aria-label", panel.title);
        const head = document.createElement("div");
        head.className = "panel-head";
        const h2 = document.createElement("h2");
        h2.textContent = panel.title;
        head.append(h2);
        container = document.createElement("div");
        container.id = `panel-${panel.id}`;
        container.className = "panel-body";
        section.append(head, container);
        host.append(section);
        panel.render(container, ctx());
    },
    append(text) {
        current.push(...parseNdjson(text).events);
        if (panel && container) {
            panel.render(container, ctx());
        }
    },
    currentEvents: () => current.length,
};
