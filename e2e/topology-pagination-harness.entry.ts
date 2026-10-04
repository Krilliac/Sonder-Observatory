/** Browser control using the real SessionStore append and TopologyPanel APIs. */
import type { ObservatoryEvent } from "../src/protocol/events";
import { SessionStore } from "../src/replay/session";
import { TopologyPanel } from "../src/topology/view";

declare global {
    interface Window {
        __topologyPagination?: {
            mount(events: ObservatoryEvent[]): void;
            append(events: ObservatoryEvent[]): void;
            replace(events: ObservatoryEvent[]): void;
            selectionEvidence(): string[];
        };
    }
}

const store = new SessionStore({ maxLiveEvents: 200 });
let panel: TopologyPanel;
let evidence: string[] = [];
window.__topologyPagination = {
    mount(events) {
        store.reset("live", "synthetic append control");
        store.append(events);
        panel = new TopologyPanel({ onSelectEvent: () => undefined,
            onSelectionChange: (_selection, ids) => { evidence = ids; } });
        const host = document.createElement("section");
        host.id = "topology-append-harness";
        host.append(panel.element);
        document.body.append(host);
        panel.setEvents(store.events);
    },
    append(events) { store.append(events); panel.setEvents(store.events); },
    replace(events) { store.reset("file", "synthetic replacement control"); store.append(events); panel.setEvents(store.events); },
    selectionEvidence: () => evidence,
};
