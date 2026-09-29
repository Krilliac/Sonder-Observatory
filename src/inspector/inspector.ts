import type { ObservatoryEvent } from "../protocol/events";
import { classifyEvent } from "../query/classify";
import { producerInstance, samplerSettings } from "../query/attributes";
import type { RequestSpan } from "../query/metrics";
import { isSyntheticProducer } from "../recording/sobs";
import { h } from "../renderer/dom";
import { requestReuseRows } from "../renderer/reuseCards";
import { relatedGroups } from "./related";

export interface InspectorCallbacks {
    relativeTime(event: ObservatoryEvent): string;
    onSelect(event: ObservatoryEvent): void;
    onClose(): void;
    /** The request span of an event with a request_id (whole session), if known. */
    requestSpan?(event: ObservatoryEvent): RequestSpan | undefined;
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
 * No values are estimated. Two labelled readouts sit beside the raw
 * attributes when they apply: sampler settings (a null field reads "model
 * default") and the request's backend prompt-cache / speculation reports.
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

    // Sampler settings of session.created / request.started: a null
    // explicit-only field (or num_ctx 0) is the model's own default and a null
    // seed is "unset (backend chooses)"; never blank or zero.
    const sampler = samplerSettings(event);
    const samplerSection =
        sampler && sampler.length > 0
            ? h(
                  "section",
                  { "data-testid": "sampler-settings" },
                  h("h3", { text: event.attributes.sampling && (event.attributes.sampling as Record<string, unknown>).explicit_only === true ? "sampler settings (explicit only)" : "sampler settings" }),
                  h(
                      "dl",
                      { class: "kv" },
                      ...sampler.flatMap((row) => [
                          h("dt", { text: row.key }),
                          h("dd", { class: row.modelDefault ? "muted" : "mono", "data-model-default": row.modelDefault, text: row.text }),
                      ]),
                  ),
              )
            : null;

    // Backend prompt-cache and speculation reports of the event's request (derived).
    const span = event.request_id ? cb.requestSpan?.(event) : undefined;
    const reuse = span ? requestReuseRows(span) : [];
    const reuseSection =
        reuse.length > 0
            ? h(
                  "section",
                  { "data-testid": "request-reuse" },
                  h("h3", { text: "request backend reuse (derived)" }),
                  h("dl", { class: "kv" }, ...reuse.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { class: "mono", text: v })])),
              )
            : null;

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
        ...(reuseSection ? [reuseSection] : []),
        ...(samplerSection ? [samplerSection] : []),
        ...(related ? [related] : []),
        h("h3", { text: "attributes (as received)" }),
        h("pre", { class: "json", text: JSON.stringify(event.attributes, null, 2) }),
    ];
}
