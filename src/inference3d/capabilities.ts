/**
 * Which 3D Inference panels a producer can feed, and why not when it cannot.
 *
 * The answer comes only from what the producer declares or sends: the
 * backend its sessions and models name (`session.created.backend`,
 * `model.load.*.backend`), the capabilities that backend advertises
 * (`backend.registered.capabilities`, or `/v1/sonder/health`
 * `backends[].capabilities` when the live client fetched it), the sampler
 * (`request.started.sampler`), the telemetry level (`sampling.level`) and the
 * declared text capture policy. Sonder-Inference capability names are listed
 * in its docs/BACKENDS.md (`token_logits`, `layer_telemetry`, …).
 */
import { PANEL_LABELS, PANEL_ORDER, type Availability, type PanelAvailability, type PanelId, type ProducerCapabilities } from "./model";

/** Facts about one producer stream collected while deriving the pipeline. */
export interface StreamFacts {
    stream: string;
    producer: string;
    nodeId: string;
    role: string | null;
    synthetic: boolean;
    instanceId: string | null;
    /** Backends named by sessions and model loads. */
    usedBackends: Set<string>;
    /** backend.registered: backend -> capabilities. */
    registered: Map<string, string[]>;
    samplers: Set<string>;
    level: string | null;
    textCapture: string | null;
    requests: number;
    layerEvents: number;
    operatorEvents: number;
    probabilityEvents: number;
    alternativeEvents: number;
    tokenUnitEvents: number;
    chunkEvents: number;
    kvEvents: number;
    schedulerConfigured: boolean;
    textEvents: number;
}

export function emptyFacts(stream: string, producer: string, nodeId: string): StreamFacts {
    return {
        stream,
        producer,
        nodeId,
        role: null,
        synthetic: false,
        instanceId: null,
        usedBackends: new Set(),
        registered: new Map(),
        samplers: new Set(),
        level: null,
        textCapture: null,
        requests: 0,
        layerEvents: 0,
        operatorEvents: 0,
        probabilityEvents: 0,
        alternativeEvents: 0,
        tokenUnitEvents: 0,
        chunkEvents: 0,
        kvEvents: 0,
        schedulerConfigured: false,
        textEvents: 0,
    };
}

const LEVEL_RANK: Record<string, number> = { off: 0, metrics: 1, standard: 2, deep: 3 };

/** Keeps the highest telemetry level seen. */
export function higherLevel(current: string | null, next: unknown): string | null {
    if (typeof next !== "string" || !(next in LEVEL_RANK)) {
        return current;
    }
    return current === null || LEVEL_RANK[next]! > LEVEL_RANK[current]! ? next : current;
}

/** `text_capture` values that mean plaintext is recorded (protocol "full", Sonder-Inference "on"). */
export function captureAllowsText(policy: string | null): boolean {
    return policy !== null && policy.split(",").some((p) => ["full", "on"].includes(p.trim().toLowerCase()));
}

export function isRuntime(role: string | null, producer: string): boolean {
    return role === "runtime" || producer === "sonder-runtime";
}

const code = (s: string) => `\`${s}\``;

function backendPhrase(backends: readonly string[]): string {
    return backends.length === 0 ? "" : `backend ${backends.map(code).join(" / ")}`;
}

interface Resolved {
    backends: string[];
    caps: Record<string, { capabilities: string[]; source: "backend.registered" | "health" }>;
}

function resolveBackends(f: StreamFacts, health: readonly { name: string; capabilities: string[] }[] | undefined): Resolved {
    const used = [...f.usedBackends].sort();
    const caps: Resolved["caps"] = {};
    for (const [name, list] of f.registered) {
        caps[name] = { capabilities: [...list].sort(), source: "backend.registered" };
    }
    for (const b of health ?? []) {
        if (!caps[b.name]) {
            caps[b.name] = { capabilities: [...b.capabilities].sort(), source: "health" };
        }
    }
    // When no session or model names a backend, a single advertised backend is the one in use.
    const advertised = Object.keys(caps).sort();
    const backends = used.length > 0 ? used : advertised.length === 1 ? advertised : [];
    return { backends, caps };
}

/** True / false when every backend in use advertises its capabilities; null when unknown. */
function allHave(r: Resolved, capability: string): boolean | null {
    if (r.backends.length === 0 || r.backends.some((b) => !r.caps[b])) {
        return null;
    }
    return r.backends.every((b) => r.caps[b]!.capabilities.includes(capability));
}

function panel(id: PanelId, status: Availability, reason: string): PanelAvailability {
    return { panel: id, label: PANEL_LABELS[id], status, reason };
}

/** Availability of each concept panel for one producer stream. */
export function producerCapabilities(f: StreamFacts, health?: readonly { name: string; capabilities: string[] }[]): ProducerCapabilities {
    const r = resolveBackends(f, health);
    const who = backendPhrase(r.backends) || `producer ${code(f.producer)}`;
    const noBackend = r.backends.length === 0;
    const capsUnknown = noBackend
        ? `${code(f.producer)} names no backend on this stream`
        : `${who} capabilities are not advertised on this stream (no backend.registered event or health data)`;
    const panels: PanelAvailability[] = [];
    const runtime = isRuntime(f.role, f.producer);
    const level = f.level ?? "unknown";

    for (const id of PANEL_ORDER) {
        if (id === "pipeline") {
            panels.push(
                f.requests > 0
                    ? panel(id, "available", `${f.requests} request(s) with lifecycle events`)
                    : panel(id, "waiting", "waiting for request lifecycle events"),
            );
            continue;
        }
        if (runtime && id !== "output-text") {
            panels.push(panel(id, "not-applicable", "Sonder Runtime routes requests; model internals come from the inference producer"));
            continue;
        }
        switch (id) {
            case "layers":
            case "operators": {
                const seen = id === "layers" ? f.layerEvents : f.operatorEvents;
                const family = id === "layers" ? "backend.layer.*" : "backend.operator.*";
                if (seen > 0) {
                    panels.push(panel(id, "available", `${seen} ${family} event(s) at level ${code(level)}`));
                    break;
                }
                const has = allHave(r, "layer_telemetry");
                if (has === false) {
                    panels.push(
                        panel(
                            id,
                            "unavailable",
                            `${who} does not expose layer telemetry (needs a backend advertising ${code("layer_telemetry")} and ${code("--telemetry-level deep")}; no Sonder Inference backend advertises it yet)`,
                        ),
                    );
                } else if (has === true && f.level !== "deep") {
                    panels.push(
                        panel(
                            id,
                            "unavailable",
                            `${who} advertises ${code("layer_telemetry")} but events arrive at level ${code(level)}; restart with ${code("--telemetry-level deep")}`,
                        ),
                    );
                } else if (has === true) {
                    panels.push(panel(id, "waiting", `waiting for ${family} events`));
                } else {
                    panels.push(panel(id, "unavailable", `not reported by this producer: ${capsUnknown}, and no ${family} events arrived`));
                }
                break;
            }
            case "probabilities":
            case "alternatives": {
                const seen = id === "probabilities" ? f.probabilityEvents : f.alternativeEvents;
                if (seen > 0) {
                    panels.push(
                        panel(
                            id,
                            "available",
                            id === "probabilities" ? `${seen} token event(s) with ${code("probability")}` : `${seen} inference.sampling.candidates event(s)`,
                        ),
                    );
                    break;
                }
                const logits = allHave(r, "token_logits");
                const backendSampler = f.samplers.has("backend") && !f.samplers.has("sonder");
                if (logits === false || (logits === null && backendSampler)) {
                    const sampler = backendSampler ? "; the backend samples, so output arrives as unit `chunk`" : "";
                    panels.push(panel(id, "unavailable", `${who} does not expose token logits${sampler}`));
                } else if (id === "alternatives" && (logits === true || f.samplers.has("sonder"))) {
                    panels.push(
                        panel(
                            id,
                            "unavailable",
                            `Sonder Inference does not emit ${code("inference.sampling.candidates")} yet (reserved; shape proposed in docs/TELEMETRY_PROTOCOL.md)`,
                        ),
                    );
                } else if (logits === true || f.samplers.has("sonder")) {
                    panels.push(panel(id, "waiting", "waiting for inference.token.generated with unit `token` (level `standard` or higher)"));
                } else {
                    panels.push(panel(id, "unavailable", `not reported by this producer: ${capsUnknown}, and no token event carries a probability`));
                }
                break;
            }
            case "kv":
                if (f.kvEvents > 0) {
                    panels.push(panel(id, "available", `${f.kvEvents} kv.* event(s) (logical blocks, not device memory)`));
                } else if (f.schedulerConfigured) {
                    panels.push(panel(id, "waiting", "scheduler configured; waiting for kv.* events"));
                } else {
                    panels.push(panel(id, "unavailable", "scheduler not active on this producer (no scheduler.configured or kv.* events)"));
                }
                break;
            case "output-text":
                if (f.textEvents > 0 && captureAllowsText(f.textCapture)) {
                    panels.push(panel(id, "available", `text capture ${code(f.textCapture ?? "")}`));
                } else if (f.textCapture === null) {
                    panels.push(panel(id, "unavailable", "no text capture policy declared; output text is withheld"));
                } else if (!captureAllowsText(f.textCapture)) {
                    panels.push(panel(id, "unavailable", `text capture is ${code(f.textCapture)}; only sizes and timing are shown`));
                } else {
                    panels.push(panel(id, "waiting", "text capture on; waiting for output events with text"));
                }
                break;
        }
    }
    return {
        stream: f.stream,
        producer: f.producer,
        nodeId: f.nodeId,
        role: f.role,
        synthetic: f.synthetic,
        instanceId: f.instanceId,
        backends: r.backends,
        backendCapabilities: r.caps,
        samplers: [...f.samplers].sort(),
        level: f.level,
        textCapture: f.textCapture,
        panels,
    };
}
