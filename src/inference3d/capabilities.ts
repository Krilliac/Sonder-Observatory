/**
 * Which 3D Inference panels a producer can feed, and why not when it cannot.
 *
 * The answer comes only from what the producer declares or sends: the
 * backend its sessions and models name (`session.created.backend`,
 * `model.load.*.backend`), the capabilities that backend advertises
 * (`backend.registered.capabilities`, or `/v1/sonder/health`
 * `backends[].capabilities` when the live client fetched it), the sampler
 * (`request.started.sampler`), the telemetry level (the declared discovery
 * `sampling_level`, then health `telemetry.level`, else the highest
 * `sampling.level` seen on events) and the declared text capture policy. Sonder-Inference capability names are listed
 * in its docs/BACKENDS.md (`token_logits`, `logprobs`, `layer_telemetry`, …).
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
    /** Highest `sampling.level` seen on events (device samples are metrics-level, so this can understate the setting). */
    level: string | null;
    /** Level the producer declares (discovery `sampling_level` / health `telemetry.level`); wins over `level`. */
    declaredLevel: string | null;
    textCapture: string | null;
    requests: number;
    completedRequests: number;
    completedProbsWithoutAlts: number;
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
        declaredLevel: null,
        textCapture: null,
        requests: 0,
        completedRequests: 0,
        completedProbsWithoutAlts: 0,
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

/** The producer's declared level when it is a known level, else the highest level seen on events. */
export function effectiveLevel(f: Pick<StreamFacts, "level" | "declaredLevel">): string | null {
    return f.declaredLevel !== null && f.declaredLevel in LEVEL_RANK ? f.declaredLevel : f.level;
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

/** True when any backend in use advertises any of `capabilities`; false when all caps are known and none do; null when unknown. */
function anyHave(r: Resolved, capabilities: readonly string[]): boolean | null {
    if (r.backends.length === 0) {
        return null;
    }
    let unknown = false;
    for (const b of r.backends) {
        const info = r.caps[b];
        if (!info) {
            unknown = true;
            continue;
        }
        if (capabilities.some((c) => info.capabilities.includes(c))) {
            return true;
        }
    }
    return unknown ? null : false;
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
    const effLevel = effectiveLevel(f);
    const level = effLevel ?? "unknown";

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
                            `${who} does not expose layer telemetry (no ${code("layer_telemetry")} capability advertised)${effLevel === "deep" ? "" : ` and telemetry level is ${code(level)}, not ${code("deep")}`}; layer data needs a backend advertising ${code("layer_telemetry")}${effLevel === "deep" ? "" : ` at ${code("--telemetry-level deep")}`}; no Sonder Inference backend advertises it yet`,
                        ),
                    );
                } else if (has === true && effLevel !== "deep") {
                    panels.push(
                        panel(
                            id,
                            "unavailable",
                            `${who} advertises ${code("layer_telemetry")} but the telemetry level is ${code(level)}; restart with ${code("--telemetry-level deep")}`,
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
                const logits = anyHave(r, ["token_logits"]);
                const logprobs = anyHave(r, ["logprobs"]);
                const probCap = anyHave(r, ["token_logits", "logprobs"]);
                const declared = f.declaredLevel !== null && f.declaredLevel in LEVEL_RANK ? f.declaredLevel : null;
                const seenBelowStandard = effLevel !== null && LEVEL_RANK[effLevel]! < LEVEL_RANK.standard!;
                const noTokenEvents =
                    f.tokenUnitEvents === 0 && f.chunkEvents === 0 && f.probabilityEvents === 0 && f.alternativeEvents === 0;
                const belowStandard =
                    declared !== null
                        ? LEVEL_RANK[declared]! < LEVEL_RANK.standard!
                        : seenBelowStandard && f.completedRequests > 0 && noTokenEvents;
                const backendSampler = f.samplers.has("backend") && !f.samplers.has("sonder");
                if (id === "alternatives") {
                    if (logprobs === true) {
                        if (belowStandard) {
                            panels.push(
                                panel(
                                    id,
                                    "unavailable",
                                    `${who} advertises ${code("logprobs")} but the telemetry level is ${code(level)}; restart with ${code("--telemetry-level standard")} or higher`,
                                ),
                            );
                        } else if (f.completedProbsWithoutAlts > 0) {
                            panels.push(
                                panel(
                                    id,
                                    "unavailable",
                                    `no alternatives emitted for this request (${who} emitted token probabilities without ${code("inference.sampling.candidates")} events)`,
                                ),
                            );
                        } else {
                            panels.push(
                                panel(
                                    id,
                                    "waiting",
                                    `waiting for ${code("inference.sampling.candidates")} events (level ${code("standard")} or higher)`,
                                ),
                            );
                        }
                    } else if (f.probabilityEvents > 0 && logits !== true) {
                        panels.push(
                            panel(
                                id,
                                "unavailable",
                                `${who} emits token probabilities but no ${code("inference.sampling.candidates")} events${probCap === false ? ` (it does not advertise ${code("token_logits")} or ${code("logprobs")})` : ""}`,
                            ),
                        );
                    } else if (logits === true || f.samplers.has("sonder")) {
                        panels.push(
                            panel(
                                id,
                                "unavailable",
                                `Sonder's sampler (${code("token_logits")}) does not emit ${code("inference.sampling.candidates")} yet; backends advertising ${code("logprobs")} emit it at level ${code("standard")} or higher`,
                            ),
                        );
                    } else if (probCap === false || (probCap === null && backendSampler)) {
                        const sampler = backendSampler ? "; the backend samples, so output arrives as unit `chunk`" : "";
                        panels.push(panel(id, "unavailable", `${who} does not expose token logits or ${code("logprobs")}${sampler}`));
                    } else {
                        panels.push(
                            panel(
                                id,
                                "unavailable",
                                `not reported by this producer: ${capsUnknown}, and no ${code("inference.sampling.candidates")} events arrived`,
                            ),
                        );
                    }
                    break;
                }
                if (logprobs === true || logits === true || f.samplers.has("sonder")) {
                    const source =
                        logprobs === true && logits === true
                            ? `advertises ${code("token_logits")} / ${code("logprobs")}`
                            : logprobs === true
                              ? `advertises ${code("logprobs")}`
                              : logits === true
                                ? `advertises ${code("token_logits")}`
                                : "uses Sonder's sampler";
                    if (belowStandard) {
                        panels.push(
                            panel(
                                id,
                                "unavailable",
                                `${who} ${source} but the telemetry level is ${code(level)}; restart with ${code("--telemetry-level standard")} or higher`,
                            ),
                        );
                    } else {
                        panels.push(
                            panel(
                                id,
                                "waiting",
                                f.chunkEvents > 0
                                    ? `waiting for inference.token.generated with unit ${code("token")} and ${code("probability")} (level ${code("standard")} or higher); streamed chunks so far carried no probabilities`
                                    : `waiting for inference.token.generated with unit ${code("token")} (level ${code("standard")} or higher)`,
                            ),
                        );
                    }
                } else if (probCap === false || (probCap === null && backendSampler)) {
                    const sampler = backendSampler ? "; the backend samples, so output arrives as unit `chunk`" : "";
                    panels.push(panel(id, "unavailable", `${who} does not expose token logits or ${code("logprobs")}${sampler}`));
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
        level: effLevel,
        textCapture: f.textCapture,
        panels,
    };
}
