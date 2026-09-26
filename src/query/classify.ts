import type { ObservatoryEvent } from "../protocol/events";

/** Timeline track / colour class for an event. Unknown types stay visible as "other". */
export type EventClass =
    | "session"
    | "request"
    | "inference"
    | "agent"
    | "tool"
    | "resource"
    | "error"
    | "telemetry"
    | "other";

export const EVENT_CLASSES: readonly EventClass[] = [
    "session",
    "request",
    "inference",
    "agent",
    "tool",
    "resource",
    "error",
    "telemetry",
    "other",
];

export function isErrorEvent(event: ObservatoryEvent): boolean {
    const t = event.event_type;
    return (
        t.endsWith(".failed") ||
        t.endsWith(".error") ||
        t === "retry.scheduled" ||
        t === "recovery.action" ||
        t.startsWith("guard.")
    );
}

export function classifyEvent(event: ObservatoryEvent): EventClass {
    if (isErrorEvent(event)) {
        return "error";
    }
    const prefix = event.event_type.split(".")[0];
    switch (prefix) {
        case "session":
        case "engine":
            return "session";
        case "request":
            return "request";
        case "inference":
        case "model":
        case "backend":
        case "context":
            return "inference";
        case "agent":
        case "route":
        case "memory":
            return "agent";
        case "tool":
            return "tool";
        case "device":
        case "kv":
        case "scheduler":
            return "resource";
        case "telemetry":
        case "recording":
            return "telemetry";
        default:
            return "other";
    }
}
