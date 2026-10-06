/**
 * Derives the 3D Inference pipeline model from protocol events (pure; no DOM,
 * no three.js). Called with the events visible at the replay cursor, so the
 * model is the state at the cursor; live mode passes every event.
 *
 * Readings (Sonder-Inference docs/TELEMETRY.md, Sonder Runtime vocabulary v1,
 * docs/telemetry-schema.md): see STAGES in ./model for the stage rules.
 * `inference.prefill.completed` and `inference.decode.completed` are emitted
 * at request end, so they add facts (prompt/completion tokens) and count as
 * stage activity but never move a request backwards. A request moves back to
 * the queue only on `scheduler.preempted`.
 */
import type { ObservatoryEvent } from "../protocol/events";
import { outputTokenCount, producerInstance } from "../query/attributes";
import { streamKey } from "../replay/order";
import { scopedRequestKey, scopedSessionKey, streamNameAndNode, tupleKey } from "../query/identity";
import { captureAllowsText, emptyFacts, higherLevel, isRuntime, producerCapabilities, type StreamFacts } from "./capabilities";
import {
    STAGE_ORDER,
    STAGES,
    type Alternative,
    type ChunkEntity,
    type HealthBackend,
    type KvPool,
    type Lane,
    type LayerEntity,
    type OperatorEntity,
    type PipelineModel,
    type RequestEntity,
    type RequestLink,
    type StageId,
    type StageSummary,
    type TokenCandidates,
} from "./model";

export const RATE_WINDOW_MS = 5000;
/** Most recent output events kept as chunk particles / live output rows. */
export const MAX_CHUNKS = 160;
/** Most recent token-candidate events kept for the probability panels. */
export const MAX_TOKENS = 40;
/** Finished requests kept in the scene; active ones are always kept. */
export const MAX_FINISHED = 120;
const MAX_EVIDENCE = 60;
const EVIDENCE_HEAD = 5;

export interface DeriveOptions {
    /** Replay cursor (mono_ns). Defaults to the last event. */
    nowNs?: number | null;
    /** Health backends per producer instance id (live client, `/v1/sonder/health`). */
    health?: ReadonlyMap<string, readonly HealthBackend[]>;
    /** Most recent finished requests to keep (default MAX_FINISHED). */
    maxFinished?: number;
}

function num(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function int(v: unknown): number | null {
    return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function str(v: unknown): string | null {
    return typeof v === "string" && v !== "" ? v : null;
}

/** Bounded evidence list: the first few ids (how it started) plus the most recent ones. */
function pushEvidence(list: string[], id: string): void {
    list.push(id);
    if (list.length > MAX_EVIDENCE) {
        list.splice(EVIDENCE_HEAD, 1);
    }
}

const TERMINAL: Record<string, RequestEntity["state"]> = {
    "request.completed": "completed",
    "request.failed": "failed",
    "request.cancelled": "cancelled",
};

/**
 * Stage an event belongs to, for request placement and stage activity.
 * `move` is false for facts reported at request end (they count as stage
 * activity but do not move the request).
 */
export function stageOfEvent(e: ObservatoryEvent, runtime: boolean): { stage: StageId; move: boolean } | null {
    const t = e.event_type;
    if (t in TERMINAL) {
        return { stage: "output", move: true };
    }
    if (runtime) {
        return t === "request.started" || t.startsWith("route.") ? { stage: "route", move: true } : null;
    }
    if (t.startsWith("route.")) {
        return { stage: "route", move: true };
    }
    if (t.startsWith("backend.layer.") || t.startsWith("backend.operator.")) {
        return { stage: "layers", move: false };
    }
    switch (t) {
        case "request.queued":
        case "scheduler.enqueued":
        case "scheduler.preempted":
            return { stage: "queue", move: true };
        case "request.started":
            return { stage: e.attributes.scheduled === true ? "queue" : "prefill", move: true };
        case "scheduler.admitted":
        case "scheduler.prefill.chunk":
        case "scheduler.prefill.completed":
        case "inference.prefill.started":
        case "kv.allocated":
        case "kv.reused":
            return { stage: "prefill", move: true };
        case "inference.prefill.completed":
            return { stage: "prefill", move: false };
        case "inference.decode.started":
        case "inference.token.generated":
            return { stage: "decode", move: true };
        case "inference.decode.completed":
            return { stage: "decode", move: false };
        default:
            return null;
    }
}

interface RequestWork {
    entity: RequestEntity;
    routeModel: string | null;
    requestedModel: string | null;
    outcomeModel: string | null;
    sessionId: string;
    modelInstanceId: string | null;
    deviceId: string | null;
    /** Original request-pipeline evidence; conflicts withhold derived links. */
    parentConflict: boolean;
    runId: string | null;
    runConflict: boolean;
}

function modelFor(
    w: RequestWork,
    sessionModel: ReadonlyMap<string, string>,
    instanceModel: ReadonlyMap<string, string>,
): { model: string; source: Lane["modelSource"] } {
    if (w.routeModel) {
        return { model: w.routeModel, source: "route.selected" };
    }
    if (w.outcomeModel) {
        return { model: w.outcomeModel, source: "route.selected" };
    }
    if (w.requestedModel) {
        return { model: w.requestedModel, source: "requested_model" };
    }
    const s = sessionModel.get(w.sessionId);
    if (s) {
        return { model: s, source: "session.created" };
    }
    if (w.modelInstanceId) {
        const m = instanceModel.get(w.modelInstanceId);
        return m ? { model: m, source: "model.load" } : { model: w.modelInstanceId, source: "model_instance_id" };
    }
    return { model: "unknown model", source: "unknown" };
}

export function derivePipeline(events: readonly ObservatoryEvent[], options: DeriveOptions = {}): PipelineModel {
    const last = events[events.length - 1];
    const nowNs = options.nowNs ?? last?.mono_ns ?? null;
    const windowStart = nowNs === null ? 0 : nowNs - RATE_WINDOW_MS * 1e6;

    const facts = new Map<string, StreamFacts>();
    const requests = new Map<string, RequestWork>();
    const sessionModel = new Map<string, string>();
    const instanceModel = new Map<string, string>();
    /** Text capture policy per producer stream and session (a policy never crosses streams). */
    const streamPolicy = new Map<string, string>();
    const stageEvents = new Map<StageId, { count: number; recent: number; evidence: string[] }>();
    const kv = new Map<string, KvPool>();
    const layers = new Map<string, LayerEntity>();
    const operators = new Map<string, OperatorEntity>();
    const chunks: ChunkEntity[] = [];
    const tokens: TokenCandidates[] = [];
    let synthetic = false;
    /** Token candidates by request and generated-token index, so a token event and its candidates event meet. */
    const tokenByKey = new Map<string, TokenCandidates>();
    const tokenFor = (e: ObservatoryEvent, reqKey: string | null, requestEntityId: string | null): TokenCandidates => {
        const index = int(e.attributes.index);
        // Keep legacy requestless session/suffix equivalence, in a disjoint
        // domain. A request-present tuple can never capture that evidence.
        const suffix = String(index ?? e.event_id);
        const key = reqKey !== null
            ? tupleKey("token-request", reqKey, suffix)
            : tupleKey("token-legacy", `${e.session_id}|${suffix}`);
        let token = tokenByKey.get(key);
        if (!token) {
            token = {
                id: `tok:${e.event_id}`,
                eventId: e.event_id,
                candidatesEventId: null,
                requestEntityId,
                index,
                tokenId: null,
                probability: null,
                text: null,
                alternatives: null,
                ns: e.mono_ns,
            };
            tokenByKey.set(key, token);
            tokens.push(token);
            if (tokens.length > MAX_TOKENS * 2) {
                for (const old of tokens.splice(0, tokens.length - MAX_TOKENS)) {
                    for (const [k, v] of tokenByKey) {
                        if (v === old) {
                            tokenByKey.delete(k);
                        }
                    }
                }
            }
        }
        return token;
    };

    for (const s of STAGES) {
        stageEvents.set(s.id, { count: 0, recent: 0, evidence: [] });
    }

    const factsFor = (e: ObservatoryEvent, stream: string): StreamFacts => {
        let f = facts.get(stream);
        if (!f) {
            f = emptyFacts(stream, e.producer.name, e.producer.node_id);
            f.instanceId = producerInstance(e);
            facts.set(stream, f);
        }
        if (typeof e.producer.role === "string") {
            f.role = e.producer.role;
        }
        if (e.producer.synthetic === true || e.attributes.synthetic === true) {
            f.synthetic = true;
        }
        return f;
    };

    for (const e of events) {
        if (nowNs !== null && e.mono_ns > nowNs) {
            break;
        }
        const t = e.event_type;
        const stream = streamKey(e);
        const f = factsFor(e, stream);
        synthetic ||= f.synthetic;
        f.level = higherLevel(f.level, e.sampling?.level);
        const runtime = isRuntime(f.role, f.producer);
        const recent = e.mono_ns > windowStart;

        const policy = str(e.attributes.text_capture);
        if (policy && (t === "session.created" || t === "session.started" || t === "engine.started")) {
            streamPolicy.set(scopedSessionKey(stream, e.session_id), policy);
            f.textCapture = f.textCapture && f.textCapture !== policy ? `${f.textCapture},${policy}` : policy;
        }
        if (t === "session.created") {
            const m = str(e.attributes.model);
            if (m) {
                sessionModel.set(e.session_id, m);
            }
            const b = str(e.attributes.backend);
            if (b) {
                f.usedBackends.add(b);
            }
        } else if (t.startsWith("model.load.") || t === "model.unload") {
            const m = str(e.attributes.model);
            if (m && e.model_instance_id) {
                instanceModel.set(e.model_instance_id, m);
            }
            const b = str(e.attributes.backend);
            if (b) {
                f.usedBackends.add(b);
            }
        } else if (t === "backend.registered") {
            const b = str(e.attributes.backend);
            const caps = e.attributes.capabilities;
            if (b && Array.isArray(caps)) {
                f.registered.set(
                    b,
                    caps.filter((c): c is string => typeof c === "string"),
                );
            }
        } else if (t === "scheduler.configured") {
            f.schedulerConfigured = true;
            const total = int(e.attributes.kv_num_blocks);
            if (total !== null) {
                kvFor(kv, stream, e).totalBlocks = total;
            }
        }

        // ----- KV pool (logical blocks)
        if (t.startsWith("kv.")) {
            f.kvEvents += 1;
            const pool = kvFor(kv, stream, e);
            const blocks = int(e.attributes.blocks) ?? 0;
            if (t === "kv.allocated") {
                pool.usedBlocks += blocks;
            } else if (t === "kv.freed") {
                pool.usedBlocks = Math.max(0, pool.usedBlocks - blocks);
            } else if (t === "kv.reused") {
                pool.reusedTokens += int(e.attributes.tokens) ?? 0;
            } else if (t === "kv.pressure") {
                pool.occupancy = num(e.attributes.occupancy) ?? num(e.attributes.utilization) ?? pool.occupancy;
                pool.level = str(e.attributes.level) ?? pool.level;
                pool.totalBlocks = int(e.attributes.total_blocks) ?? pool.totalBlocks;
            }
            pushEvidence(pool.evidence, e.event_id);
        }

        // ----- layers and operators (reserved event families, proposed shapes)
        if (t.startsWith("backend.layer.")) {
            f.layerEvents += 1;
            const index = int(e.attributes.layer);
            if (index !== null && index >= 0) {
                const id = tupleKey("layer", stream, String(index));
                let l = layers.get(id);
                if (!l) {
                    l = {
                        id,
                        stream,
                        layer: index,
                        layerCount: null,
                        events: 0,
                        lastDurationMs: null,
                        totalDurationMs: 0,
                        activationRms: null,
                        attentionEntropy: null,
                        ratePerSec: 0,
                        evidence: [],
                    };
                    layers.set(id, l);
                }
                l.events += 1;
                l.layerCount = int(e.attributes.layer_count) ?? l.layerCount;
                const d = num(e.attributes.duration_ms);
                if (d !== null) {
                    l.lastDurationMs = d;
                    l.totalDurationMs += d;
                }
                l.activationRms = num(e.attributes.activation_rms) ?? l.activationRms;
                l.attentionEntropy = num(e.attributes.attention_entropy) ?? l.attentionEntropy;
                if (recent) {
                    l.ratePerSec += 1;
                }
                pushEvidence(l.evidence, e.event_id);
            }
        } else if (t.startsWith("backend.operator.")) {
            f.operatorEvents += 1;
            const name = str(e.attributes.operator);
            if (name) {
                const layer = int(e.attributes.layer);
                const id = tupleKey("operator", stream, name, String(layer ?? "-"));
                let o = operators.get(id);
                if (!o) {
                    o = { id, stream, operator: name, layer, events: 0, totalDurationMs: 0, ratePerSec: 0, evidence: [] };
                    operators.set(id, o);
                }
                o.events += 1;
                o.totalDurationMs += num(e.attributes.duration_ms) ?? 0;
                if (recent) {
                    o.ratePerSec += 1;
                }
                pushEvidence(o.evidence, e.event_id);
            }
        }

        // ----- stage activity
        const staged = stageOfEvent(e, runtime);
        if (staged) {
            const s = stageEvents.get(staged.stage)!;
            s.count += 1;
            if (recent) {
                s.recent += 1;
            }
            pushEvidence(s.evidence, e.event_id);
        }

        // ----- requests
        const rid = e.request_id ?? null;
        const relevant = rid !== null && (staged !== null || t.startsWith("request.") || t.startsWith("kv.") || t.startsWith("scheduler."));
        if (relevant) {
            const key = scopedRequestKey(stream, rid);
            let w = requests.get(key);
            // A request is born by a stage-moving event; facts and KV events alone do not create one.
            if (!w && staged?.move) {
                f.requests += 1;
                w = {
                    entity: {
                        id: key,
                        requestId: rid,
                        stream,
                        producer: e.producer.name,
                        role: f.role,
                        laneKey: "",
                        nodeId: e.producer.node_id,
                        model: "",
                        stage: staged.stage,
                        state: "active",
                        kind: null,
                        completionTokens: null,
                        promptTokens: null,
                        outputEvents: 0,
                        startNs: e.mono_ns,
                        lastNs: e.mono_ns,
                        endNs: null,
                        parentRequestId: null,
                        stageEntries: { [staged.stage]: e.mono_ns },
                        evidence: [],
                        lastEventId: e.event_id,
                        synthetic: f.synthetic,
                    },
                    routeModel: null,
                    requestedModel: null,
                    outcomeModel: null,
                    sessionId: e.session_id,
                    modelInstanceId: e.model_instance_id ?? null,
                    deviceId: e.device_id ?? null,
                    parentConflict: false,
                    runId: null,
                    runConflict: false,
                };
                requests.set(key, w);
            }
        }
        const rw = relevant ? requests.get(scopedRequestKey(stream, rid!)) : undefined;
        if (rw) {
            const w = rw;
            const r = w.entity;
            r.lastNs = e.mono_ns;
            r.lastEventId = e.event_id;
            pushEvidence(r.evidence, e.event_id);
            w.modelInstanceId ??= e.model_instance_id ?? null;
            w.deviceId ??= e.device_id ?? null;
            const parentId = str(e.attributes.parent_request_id);
            if (parentId && !w.parentConflict) {
                if (r.parentRequestId && r.parentRequestId !== parentId) {
                    w.parentConflict = true;
                    r.parentRequestId = null;
                } else {
                    r.parentRequestId = parentId;
                }
            }
            if (e.run_id) {
                if (w.runId && w.runId !== e.run_id) {
                    w.runConflict = true;
                }
                w.runId ??= e.run_id;
            }
            r.kind ??= str(e.attributes.kind);
            if (t === "route.selected") {
                w.routeModel = str(e.attributes.model) ?? w.routeModel;
            } else if (t === "request.started") {
                w.requestedModel = str(e.attributes.requested_model) ?? w.requestedModel;
                const sampler = str(e.attributes.sampler);
                if (sampler) {
                    f.samplers.add(sampler);
                }
            }
            const prompt = int(e.attributes.prompt_tokens);
            if (prompt !== null) {
                r.promptTokens = prompt;
            }
            const completion = int(e.attributes.completion_tokens);
            if (completion !== null && (t === "inference.decode.completed" || e.attributes.token_counts_from_backend === true || runtime)) {
                r.completionTokens = completion;
            }
            if (t in TERMINAL) {
                r.state = TERMINAL[t]!;
                r.endNs = e.mono_ns;
                w.outcomeModel = str(e.attributes.model) ?? w.outcomeModel;
            }
            if (staged && staged.move && r.stage !== "output") {
                if (STAGE_ORDER[staged.stage] >= STAGE_ORDER[r.stage] || t === "scheduler.preempted") {
                    if (r.stage !== staged.stage) {
                        r.stageEntries[staged.stage] = e.mono_ns;
                    }
                    r.stage = staged.stage;
                }
            }
        }

        // ----- output events (chunks / tokens)
        if (t === "inference.token.generated") {
            const unit = str(e.attributes.unit) ?? "token";
            const n = outputTokenCount(e);
            if (n === null) {
                f.chunkEvents += 1;
            } else {
                f.tokenUnitEvents += 1;
            }
            const reqKey = rid ? scopedRequestKey(stream, rid!) : null;
            const req = reqKey ? requests.get(reqKey) : undefined;
            if (req) {
                req.entity.outputEvents += 1;
            }
            const rawText = typeof e.attributes.text === "string" ? e.attributes.text : null;
            const policy = streamPolicy.get(scopedSessionKey(stream, e.session_id)) ?? f.textCapture;
            const allowed = rawText !== null && captureAllowsText(policy);
            if (allowed) {
                f.textEvents += 1;
            }
            chunks.push({
                id: `chunk:${e.event_id}`,
                eventId: e.event_id,
                requestEntityId: req ? req.entity.id : null,
                laneKey: null,
                index: int(e.attributes.index),
                bytes: int(e.attributes.bytes),
                elapsedMs: num(e.attributes.elapsed_ms),
                unit,
                tokens: n,
                probability: num(e.attributes.probability),
                text: allowed ? rawText : null,
                textWithheld: rawText !== null && !allowed,
                ns: e.mono_ns,
            });
            if (chunks.length > MAX_CHUNKS * 2) {
                chunks.splice(0, chunks.length - MAX_CHUNKS);
            }
            const probability = num(e.attributes.probability);
            if (probability !== null) {
                f.probabilityEvents += 1;
                const token = tokenFor(e, reqKey, req?.entity.id ?? null);
                token.eventId = e.event_id;
                token.id = `tok:${e.event_id}`;
                token.tokenId = int(e.attributes.token_id);
                token.probability = probability;
                token.text = allowed ? rawText : null;
                token.ns = e.mono_ns;
            }
        } else if (t === "inference.sampling.candidates") {
            // Reserved in the Observatory taxonomy; attribute shape proposed in docs/TELEMETRY_PROTOCOL.md.
            const policy = streamPolicy.get(scopedSessionKey(stream, e.session_id)) ?? f.textCapture;
            const alternatives = readAlternatives(e.attributes.candidates, captureAllowsText(policy));
            if (alternatives !== null) {
                f.alternativeEvents += 1;
                const reqKey = rid ? scopedRequestKey(stream, rid!) : null;
                const token = tokenFor(e, reqKey, (reqKey ? requests.get(reqKey)?.entity.id : undefined) ?? null);
                token.alternatives = alternatives;
                token.candidatesEventId = e.event_id;
            }
        }
    }

    // ----- lanes (node x model), resolved after the pass so late route/model facts apply
    const laneMap = new Map<string, Lane>();
    for (const w of requests.values()) {
        const { model, source } = modelFor(w, sessionModel, instanceModel);
        const node = w.entity.nodeId;
        const key = `${node}\u0000${model}`;
        let lane = laneMap.get(key);
        if (!lane) {
            lane = { key, nodeId: node, model, modelSource: source, producers: [], roles: [], deviceIds: [], index: 0, nodeIndex: 0, requests: 0 };
            laneMap.set(key, lane);
        }
        if (lane.modelSource === "unknown" || lane.modelSource === "model_instance_id") {
            lane.modelSource = source;
        }
        lane.requests += 1;
        if (!lane.producers.includes(w.entity.producer)) {
            lane.producers.push(w.entity.producer);
        }
        const role = w.entity.role ?? "unstated";
        if (!lane.roles.includes(role)) {
            lane.roles.push(role);
        }
        if (w.deviceId && !lane.deviceIds.includes(w.deviceId)) {
            lane.deviceIds.push(w.deviceId);
        }
        w.entity.laneKey = key;
        w.entity.model = model;
    }
    const lanes = [...laneMap.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.model.localeCompare(b.model));
    const nodes = [...new Set(lanes.map((l) => l.nodeId))];
    lanes.forEach((l, i) => {
        l.index = i;
        l.nodeIndex = nodes.indexOf(l.nodeId);
    });

    const allRequests = [...requests.values()].map((w) => w.entity).sort((a, b) => a.startNs - b.startNs || a.id.localeCompare(b.id));
    const finished = allRequests.filter((r) => r.state !== "active").sort((a, b) => (b.endNs ?? b.lastNs) - (a.endNs ?? a.lastNs));
    const keepFinished = new Set(finished.slice(0, options.maxFinished ?? MAX_FINISHED));
    const requestList = allRequests.filter((r) => r.state === "active" || keepFinished.has(r));
    for (const c of chunks) {
        if (c.requestEntityId) {
            c.laneKey = requests.get(c.requestEntityId)?.entity.laneKey ?? null;
        }
    }

    // ----- Runtime turn -> Inference request (parent_request_id = Runtime request_id)
    const runtimeByRequestId = new Map<string, RequestEntity[]>();
    for (const r of requestList) {
        if (isRuntime(r.role, r.producer)) {
            const candidates = runtimeByRequestId.get(r.requestId) ?? [];
            candidates.push(r);
            runtimeByRequestId.set(r.requestId, candidates);
        }
    }
    const links: RequestLink[] = [];
    for (const r of requestList) {
        const child = requests.get(r.id)!;
        const candidates = r.parentRequestId && !child.runConflict
            ? (runtimeByRequestId.get(r.parentRequestId) ?? []).filter((p) => {
                const parent = requests.get(p.id)!;
                return p !== r && !parent.runConflict && (!child.runId || !parent.runId || child.runId === parent.runId);
            })
            : [];
        // A bare parent id cannot distinguish compatible Runtime instances.
        // Keep ambiguous evidence inspectable instead of picking the last one.
        const parent = candidates.length === 1 ? candidates[0] : undefined;
        if (parent) {
            links.push({ from: parent.id, to: r.id });
        }
    }

    // ----- stage summaries
    const inStage = new Map<StageId, number>();
    for (const r of allRequests) {
        inStage.set(r.stage, (inStage.get(r.stage) ?? 0) + 1);
    }
    const hasLayers = layers.size > 0;
    const stages: StageSummary[] = STAGES.filter((s) => s.id !== "layers" || hasLayers).map((s) => {
        const ev = stageEvents.get(s.id)!;
        return {
            id: s.id,
            label: s.label,
            requests: inStage.get(s.id) ?? 0,
            events: ev.count,
            ratePerSec: ev.recent / (RATE_WINDOW_MS / 1000),
            evidence: ev.evidence,
        };
    });
    for (const l of layers.values()) {
        l.ratePerSec /= RATE_WINDOW_MS / 1000;
    }
    for (const o of operators.values()) {
        o.ratePerSec /= RATE_WINDOW_MS / 1000;
    }

    const capabilities = [...facts.values()]
        .sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.producer.localeCompare(b.producer) || a.stream.localeCompare(b.stream))
        .map((f) => producerCapabilities(f, f.instanceId ? options.health?.get(f.instanceId) : undefined));

    return {
        nowNs,
        stages,
        hasLayers,
        lanes,
        nodes,
        requests: requestList,
        omittedFinished: allRequests.length - requestList.length,
        chunks: chunks.slice(-MAX_CHUNKS),
        kvPools: [...kv.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.stream.localeCompare(b.stream)),
        layers: [...layers.values()].sort((a, b) => a.stream.localeCompare(b.stream) || a.layer - b.layer),
        operators: [...operators.values()].sort(
            (a, b) => a.stream.localeCompare(b.stream) || (a.layer ?? -1) - (b.layer ?? -1) || a.operator.localeCompare(b.operator),
        ),
        tokens: tokens.slice(-MAX_TOKENS),
        links,
        capabilities,
        synthetic,
        windowMs: RATE_WINDOW_MS,
    };
}

function kvFor(kv: Map<string, KvPool>, stream: string, e: ObservatoryEvent): KvPool {
    let pool = kv.get(stream);
    if (!pool) {
        pool = {
            id: tupleKey("kv", stream),
            stream,
            producer: e.producer.name,
            nodeId: e.producer.node_id,
            usedBlocks: 0,
            totalBlocks: null,
            occupancy: null,
            level: null,
            reusedTokens: 0,
            evidence: [],
        };
        kv.set(stream, pool);
    }
    return pool;
}

/** Proposed `inference.sampling.candidates` `candidates`: [{token_id, probability, text?}]; sorted most probable first. */
function readAlternatives(value: unknown, textAllowed: boolean): Alternative[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    const out: Alternative[] = [];
    for (const item of value) {
        if (typeof item !== "object" || item === null) {
            continue;
        }
        const o = item as Record<string, unknown>;
        const p = num(o.probability);
        if (p === null) {
            continue;
        }
        out.push({ tokenId: int(o.token_id), probability: p, text: textAllowed && typeof o.text === "string" ? o.text : null });
    }
    return out.length > 0 ? out.sort((a, b) => b.probability - a.probability) : null;
}

/** Human label of a producer stream key (name @ node). */
export function streamLabel(stream: string): string {
    const source = streamNameAndNode(stream);
    return source ? `${source.name} @ ${source.nodeId}` : "unknown producer stream";
}
