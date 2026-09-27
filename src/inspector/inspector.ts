import type { ObservatoryEvent } from "../protocol/events";
import { classifyEvent } from "../query/classify";
import { producerInstance } from "../query/attributes";
import { isSyntheticProducer } from "../recording/sobs";
import { h } from "../renderer/dom";
import { relatedGroups } from "./related";

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

function producerRole(event: ObservatoryEvent): string {
    return typeof event.producer.role === "string" ? event.producer.role : "not reported";
}

/**
 * Evidence view for one event: envelope, producer, sampling and raw
 * attributes exactly as received, plus correlated events across producers
 * (request, parent and child requests, run, agent, tool call; contract 8.4).
 * No values are interpreted or estimated.
 */
export function renderInspector(
    event: ObservatoryEvent | undefined,
    events: readonly ObservatoryEvent[],
    cb: InspectorCallbacks,
): Node[] {
    if (!event) {
        return [
            h("div", { class: "panel-head" }, h("h2", { text: "Inspector" })),
            h("p", { class: "muted", text: "Select an event in the table or timeline to inspect its evidence." }),
        ];
    }
    const synthetic = isSyntheticProducer(event.producer);
    const provenance = synthetic
        ? `Synthetic event from ${event.producer.name} ${event.producer.version} (fixture, fake producer or mock backend; not measured).`
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
        h("dt", { text: "producer" }),
        h("dd", { class: "mono", "data-testid": "inspector-producer", text: `${event.producer.name} ${event.producer.version}` }),
        h("dt", { text: "role" }),
        h("dd", { text: producerRole(event) }),
        h("dt", { text: "instance" }),
        h("dd", { class: "mono", text: producerInstance(event) ?? "not reported" }),
        h("dt", { text: "node" }),
        h("dd", { class: "mono", text: event.producer.node_id }),
        h("dt", { text: "sampling" }),
        h("dd", { class: "mono", text: event.sampling ? JSON.stringify(event.sampling) : "absent" }),
        h("dt", { text: "class" }),
        h("dd", { text: classifyEvent(event) }),
    );

    const groups = relatedGroups(event, events);
    const related =
        groups.length > 0
            ? h(
                  "div",
                  { class: "related-groups", "data-testid": "related-events" },
                  h("h3", { text: "Related events" }),
                  ...groups.map((g) =>
                      h(
                          "section",
                          { class: "related-group", "data-group": g.kind, "aria-label": `${g.title} ${g.value}` },
                          h(
                              "h4",
                              {},
                              `${g.title} `,
                              h("span", { class: "mono", text: g.value }),
                              h("span", { class: "muted", text: g.total > g.events.length ? ` (first ${g.events.length} of ${g.total})` : ` (${g.total})` }),
                          ),
                          h(
                              "ul",
                              { class: "related" },
                              ...g.events.map((e) => {
                                  const btn = h("button", { type: "button", class: "link" });
                                  btn.append(
                                      `${cb.relativeTime(e)}  ${e.event_type}`,
                                      h("span", { class: "related-producer", text: ` · ${e.producer.name}` }),
                                  );
                                  btn.addEventListener("click", () => cb.onSelect(e));
                                  return h("li", { "data-testid": "related-event", "data-producer": e.producer.name, "data-event-type": e.event_type }, btn);
                              }),
                          ),
                      ),
                  ),
              )
            : null;

    const close = h("button", { type: "button", class: "close", "aria-label": "Close inspector", text: "×" });
    close.addEventListener("click", () => cb.onClose());
    const jump = h("button", { type: "button", class: "small", text: "Move cursor here" });
    jump.addEventListener("click", () => cb.onSelect(event));

    return [
        h("div", { class: "panel-head" }, h("h2", { text: "Inspector" }), close),
        h("p", { class: `provenance${synthetic ? " synthetic" : ""}`, text: provenance }),
        h("p", { class: "mono big", text: event.event_type }),
        jump,
        envelope,
        ...(related ? [related] : []),
        h("h3", { text: "attributes (as received)" }),
        h("pre", { class: "json", text: JSON.stringify(event.attributes, null, 2) }),
    ];
}
