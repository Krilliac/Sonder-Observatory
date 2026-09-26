import type { ObservatoryEvent } from "../protocol/events";
import { classifyEvent } from "../query/classify";
import { isSyntheticProducer } from "../recording/sobs";
import { h } from "../renderer/dom";
import { relatedEvents } from "./related";

export interface InspectorCallbacks {
    relativeTime(event: ObservatoryEvent): string;
    onSelect(event: ObservatoryEvent): void;
    onClose(): void;
}

const ENVELOPE_ROWS: (keyof ObservatoryEvent)[] = [
    "event_id",
    "event_type",
    "sequence",
    "wall_time",
    "mono_ns",
    "session_id",
    "run_id",
    "request_id",
    "agent_id",
    "task_id",
    "model_instance_id",
    "device_id",
];

/**
 * Evidence view for one event: envelope, producer, sampling and raw
 * attributes exactly as received. No values are interpreted or estimated.
 */
export function renderInspector(
    event: ObservatoryEvent | undefined,
    events: readonly ObservatoryEvent[],
    cb: InspectorCallbacks,
): Node[] {
    if (!event) {
        return [
            h("h2", { text: "Inspector" }),
            h("p", { class: "muted", text: "Select an event in the table or timeline to inspect its evidence." }),
        ];
    }
    const synthetic = isSyntheticProducer(event.producer);
    const provenance = synthetic
        ? `Synthetic event from ${event.producer.name} ${event.producer.version} (fixture, not measured).`
        : `Producer-reported event from ${event.producer.name} ${event.producer.version} on node ${event.producer.node_id}.`;

    const envelope = h("dl", { class: "kv" });
    for (const key of ENVELOPE_ROWS) {
        const value = event[key];
        envelope.append(
            h("dt", { text: key }),
            h("dd", { class: "mono", text: value === undefined ? "absent" : value === null ? "null" : String(value) }),
        );
    }
    envelope.append(
        h("dt", { text: "sampling" }),
        h("dd", { class: "mono", text: event.sampling ? JSON.stringify(event.sampling) : "absent" }),
        h("dt", { text: "class" }),
        h("dd", { text: classifyEvent(event) }),
    );

    const related = relatedEvents(event, events);
    const relatedList = related
        ? h(
              "div",
              {},
              h("h3", { text: `Related by ${related.by} = ${related.value}` }),
              h(
                  "ul",
                  { class: "related" },
                  ...related.events.map((e) => {
                      const btn = h("button", { type: "button", class: "link", text: `${cb.relativeTime(e)}  ${e.event_type}` });
                      btn.addEventListener("click", () => cb.onSelect(e));
                      return h("li", {}, btn);
                  }),
              ),
          )
        : null;

    const close = h("button", { type: "button", class: "close", "aria-label": "Close inspector", text: "×" });
    close.addEventListener("click", () => cb.onClose());
    const jump = h("button", { type: "button", text: "Move cursor here" });
    jump.addEventListener("click", () => cb.onSelect(event));

    return [
        h("div", { class: "panel-head" }, h("h2", { text: "Inspector" }), close),
        h("p", { class: `provenance${synthetic ? " synthetic" : ""}`, text: provenance }),
        h("p", { class: "mono big", text: event.event_type }),
        jump,
        envelope,
        h("h3", { text: "attributes (as received)" }),
        h("pre", { class: "json", text: JSON.stringify(event.attributes, null, 2) }),
        ...(relatedList ? [relatedList] : []),
    ];
}
