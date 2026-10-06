/**
 * Data model of the 3D Inference view (docs/integration/inference3d.md).
 *
 * Everything here is derived from protocol events at the replay cursor.
 * The depth axis is the request pipeline that producers actually report
 * (Runtime route, Inference queue, prefill, decode, output), not transformer
 * layers. Layer planes and operator activity exist only when a producer
 * sends the reserved `backend.layer.*` / `backend.operator.*` events; token
 * probabilities only when it sends them. Nothing is estimated or invented.
 */

/** Pipeline stages along the depth axis, in order. `layers` appears only with layer telemetry. */
export type StageId = "route" | "queue" | "prefill" | "layers" | "decode" | "output";

export interface StageDef {
    id: StageId;
    label: string;
    /** Which events place a request in this stage (shown in the legend and the stage rail). */
    evidence: string;
}

export const STAGES: readonly StageDef[] = [
    { id: "route", label: "Route", evidence: "Runtime request.started, route.selected, route.changed" },
    { id: "queue", label: "Queue", evidence: "request.queued, scheduler.enqueued, scheduler.preempted" },
    { id: "prefill", label: "Prefill", evidence: "request.started, scheduler.admitted, scheduler.prefill.*, kv.allocated, kv.reused" },
    { id: "layers", label: "Layers", evidence: "backend.layer.* (reserved; deep telemetry only)" },
    { id: "decode", label: "Decode", evidence: "inference.decode.started, inference.token.generated" },
    { id: "output", label: "Output", evidence: "request.completed, request.failed, request.cancelled" },
];

export const STAGE_ORDER: Record<StageId, number> = { route: 0, queue: 1, prefill: 2, layers: 3, decode: 4, output: 5 };

export type RequestState = "active" | "completed" | "failed" | "cancelled";

export interface StageSummary {
    id: StageId;
    label: string;
    /** Requests currently in this stage at the cursor (for `output`: finished requests). */
    requests: number;
    /** Events of this stage up to the cursor. */
    events: number;
    /** Events of this stage per second over the trailing window ending at the cursor. */
    ratePerSec: number;
    /** Most recent evidence event ids (newest last, bounded). */
    evidence: string[];
}

export interface Lane {
    key: string;
    nodeId: string;
    model: string;
    /** How the model name was found. */
    modelSource: "route.selected" | "requested_model" | "session.created" | "model.load" | "model_instance_id" | "unknown";
    producers: string[];
    roles: string[];
    deviceIds: string[];
    /** Stable order: by node, then model. */
    index: number;
    /** Index of the node group the lane belongs to. */
    nodeIndex: number;
    requests: number;
}

export interface RequestEntity {
    /** Opaque canonical identity of (producer stream, request_id). */
    id: string;
    requestId: string;
    stream: string;
    producer: string;
    role: string | null;
    laneKey: string;
    nodeId: string;
    model: string;
    stage: StageId;
    state: RequestState;
    kind: string | null;
    /** Backend-reported completion tokens (request.completed/decode.completed), null until reported. */
    completionTokens: number | null;
    /** Prompt tokens (inference.prefill.completed / scheduler.enqueued / request outcome), null until reported. */
    promptTokens: number | null;
    /** Sampled output events (unit chunk or token). */
    outputEvents: number;
    startNs: number;
    lastNs: number;
    endNs: number | null;
    parentRequestId: string | null;
    /** Stage-entry times (mono_ns) actually observed. */
    stageEntries: Partial<Record<StageId, number>>;
    evidence: string[];
    lastEventId: string;
    synthetic: boolean;
}

export interface ChunkEntity {
    /** Entity id: `chunk:<event_id>`. */
    id: string;
    eventId: string;
    requestEntityId: string | null;
    laneKey: string | null;
    index: number | null;
    bytes: number | null;
    elapsedMs: number | null;
    unit: string;
    /** Tokens in this event when `unit` is token (never for chunks). */
    tokens: number | null;
    probability: number | null;
    /** Text only when the event carries it and the session's capture policy allows it. */
    text: string | null;
    textWithheld: boolean;
    ns: number;
}

export interface KvPool {
    /** Opaque canonical producer-scoped KV identity. */
    id: string;
    stream: string;
    producer: string;
    nodeId: string;
    /** Logical blocks in use: kv.allocated blocks minus kv.freed blocks. */
    usedBlocks: number;
    /** From scheduler.configured kv_num_blocks or kv.pressure total_blocks. */
    totalBlocks: number | null;
    /** Latest kv.pressure occupancy (0..1), producer-reported. */
    occupancy: number | null;
    level: string | null;
    reusedTokens: number;
    evidence: string[];
}

export interface LayerEntity {
    /** Opaque canonical identity of (producer stream, layer index). */
    id: string;
    stream: string;
    layer: number;
    layerCount: number | null;
    events: number;
    lastDurationMs: number | null;
    totalDurationMs: number;
    activationRms: number | null;
    attentionEntropy: number | null;
    ratePerSec: number;
    evidence: string[];
}

export interface OperatorEntity {
    /** Opaque canonical identity of (producer stream, operator name, layer). */
    id: string;
    stream: string;
    operator: string;
    layer: number | null;
    events: number;
    totalDurationMs: number;
    ratePerSec: number;
    evidence: string[];
}

export interface Alternative {
    tokenId: number | null;
    probability: number;
    text: string | null;
}

export interface TokenCandidates {
    /** Entity id: `tok:<event_id>`. */
    id: string;
    /** The inference.token.generated event (or the candidates event when no token event carries a probability). */
    eventId: string;
    /** The inference.sampling.candidates event, if any. */
    candidatesEventId: string | null;
    requestEntityId: string | null;
    index: number | null;
    tokenId: number | null;
    probability: number | null;
    text: string | null;
    alternatives: Alternative[] | null;
    ns: number;
}

export interface RequestLink {
    /** Runtime turn entity id. */
    from: string;
    /** Inference request entity id. */
    to: string;
}

export type PanelId = "pipeline" | "layers" | "operators" | "probabilities" | "alternatives" | "kv" | "output-text";
export type Availability = "available" | "unavailable" | "waiting" | "not-applicable";

export const PANEL_LABELS: Record<PanelId, string> = {
    pipeline: "Stage pipeline",
    layers: "Layer internals",
    operators: "Operator activity",
    probabilities: "Token probabilities",
    alternatives: "Top alternatives",
    kv: "KV cache pool",
    "output-text": "Output text",
};

export const PANEL_ORDER: readonly PanelId[] = ["pipeline", "layers", "operators", "probabilities", "alternatives", "kv", "output-text"];

export interface PanelAvailability {
    panel: PanelId;
    label: string;
    status: Availability;
    reason: string;
}

export interface ProducerCapabilities {
    stream: string;
    producer: string;
    nodeId: string;
    role: string | null;
    synthetic: boolean;
    instanceId: string | null;
    /** Backends the producer's sessions or models use (ollama, llamacpp, mock, …). */
    backends: string[];
    /** Advertised capabilities per backend and where they came from. */
    backendCapabilities: Record<string, { capabilities: string[]; source: "backend.registered" | "health" }>;
    /** `request.started.sampler` values seen (`sonder` or `backend`). */
    samplers: string[];
    /** Highest `sampling.level` seen on this stream. */
    level: string | null;
    textCapture: string | null;
    panels: PanelAvailability[];
}

/** Backend facts from a producer's health document (`/v1/sonder/health`), keyed by producer instance. */
export type { HealthBackend } from "../ingest/live/health";

export interface PipelineModel {
    /** mono_ns the model describes (the replay cursor); null when there are no events. */
    nowNs: number | null;
    stages: StageSummary[];
    /** True when layer telemetry exists, so the `layers` stage is shown. */
    hasLayers: boolean;
    lanes: Lane[];
    nodes: string[];
    /** Active requests plus the most recent finished ones (see omittedFinished). */
    requests: RequestEntity[];
    /** Finished requests left out of `requests` to bound the scene (still counted in stages). */
    omittedFinished: number;
    chunks: ChunkEntity[];
    kvPools: KvPool[];
    layers: LayerEntity[];
    operators: OperatorEntity[];
    tokens: TokenCandidates[];
    links: RequestLink[];
    capabilities: ProducerCapabilities[];
    synthetic: boolean;
    /** Window used for rates (ms). */
    windowMs: number;
}
