/**
 * three.js scene of the 3D Inference view. Only this module (and the panel
 * that lazy-loads it) imports three, so three stays out of the main bundle.
 *
 * World axes: x = pipeline depth (stage planes), y = lanes (node x model,
 * nodes as bands), z = spread of requests inside a lane. Encodings are the
 * ones the panel legend lists; `layoutScene` is pure and unit-tested.
 */
import {
    AmbientLight,
    BoxGeometry,
    BufferGeometry,
    Color,
    DirectionalLight,
    DoubleSide,
    EdgesGeometry,
    Group,
    Line,
    LineBasicMaterial,
    LineSegments,
    Mesh,
    MeshBasicMaterial,
    MeshStandardMaterial,
    PerspectiveCamera,
    PlaneGeometry,
    Raycaster,
    Scene,
    SphereGeometry,
    Vector2,
    Vector3,
    WebGLRenderer,
    type Material,
    type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { PipelineModel, RequestEntity, StageId } from "./model";

// ------------------------------------------------------------------ layout

export const PLANE_DEPTH = 7;
const STAGE_GAP = 5;
const LAYER_GAP = 0.9;
const LANE_HEIGHT = 2.2;
const NODE_GAP = 1.4;
/** Age after which output events are fully faded (ms). */
export const CHUNK_FADE_MS = 8000;
/** Age over which finished requests fade to their floor opacity (ms). */
export const REQUEST_FADE_MS = 60000;

export interface PlaneSlot {
    /** Entity id: `stage:<id>` or the layer entity id. */
    id: string;
    stage: StageId;
    x: number;
    label: string;
    layer: number | null;
}

export interface LaneSlot {
    key: string;
    y: number;
    label: string;
    nodeId: string;
}

export interface NodeBand {
    nodeId: string;
    yMin: number;
    yMax: number;
}

export interface SceneLayout {
    planes: PlaneSlot[];
    stageX: Partial<Record<StageId, number>>;
    lanes: LaneSlot[];
    bands: NodeBand[];
    height: number;
    xMin: number;
    xMax: number;
}

/** Positions of stage planes, layer planes, lanes and node bands. */
export function layoutScene(model: PipelineModel): SceneLayout {
    const planes: PlaneSlot[] = [];
    const stageX: SceneLayout["stageX"] = {};
    let x = 0;
    for (const s of model.stages) {
        if (s.id === "layers") {
            const layers = [...new Map(model.layers.map((l) => [l.layer, l])).values()].sort((a, b) => a.layer - b.layer);
            stageX.layers = x;
            layers.forEach((l, i) => {
                planes.push({ id: l.id, stage: "layers", x: x + i * LAYER_GAP, label: `L${l.layer}`, layer: l.layer });
            });
            x += Math.max(0, layers.length - 1) * LAYER_GAP + STAGE_GAP;
            continue;
        }
        stageX[s.id] = x;
        planes.push({ id: `stage:${s.id}`, stage: s.id, x, label: s.label, layer: null });
        x += STAGE_GAP;
    }
    const lanes: LaneSlot[] = [];
    const bands: NodeBand[] = [];
    let y = 0;
    let node: string | null = null;
    for (const lane of model.lanes) {
        if (node !== null && lane.nodeId !== node) {
            y -= NODE_GAP;
        }
        if (lane.nodeId !== node) {
            bands.push({ nodeId: lane.nodeId, yMin: y - LANE_HEIGHT, yMax: y });
            node = lane.nodeId;
        }
        const center = y - LANE_HEIGHT / 2;
        lanes.push({ key: lane.key, y: center, label: lane.model, nodeId: lane.nodeId });
        bands[bands.length - 1]!.yMin = y - LANE_HEIGHT;
        y -= LANE_HEIGHT;
    }
    const height = Math.max(LANE_HEIGHT, -y);
    // Center vertically around 0.
    const shift = height / 2;
    for (const l of lanes) {
        l.y += shift;
    }
    for (const b of bands) {
        b.yMin += shift;
        b.yMax += shift;
    }
    const xs = planes.map((p) => p.x);
    return { planes, stageX, lanes, bands, height, xMin: Math.min(0, ...xs), xMax: Math.max(0, ...xs) };
}

/** Particle radius from backend-reported tokens (completion, else prompt); base size when none reported. */
export function requestRadius(r: RequestEntity): number {
    const tokens = r.completionTokens ?? r.promptTokens ?? 0;
    return Math.min(0.62, 0.16 + 0.05 * Math.log2(1 + tokens));
}

/** Opacity from age: active requests are opaque; finished ones fade to a floor. */
export function ageOpacity(ageMs: number, fadeMs: number, floor: number): number {
    if (!(ageMs > 0)) {
        return 1;
    }
    return Math.max(floor, 1 - ageMs / fadeMs);
}

/** Pulse frequency (Hz) for an event rate (events/s): 0 when idle, capped for comfort. */
export function pulseHz(ratePerSec: number): number {
    return ratePerSec <= 0 ? 0 : Math.min(2.5, 0.35 + Math.log2(1 + ratePerSec) * 0.4);
}

// ------------------------------------------------------------------ palette

export interface ScenePalette {
    text: string;
    muted: string;
    border: string;
    surface: string;
    primary: string;
    cyan: string;
    purple: string;
    success: string;
    warning: string;
    error: string;
    selected: string;
}

export function readPalette(el: Element): ScenePalette {
    const css = getComputedStyle(el);
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    return {
        text: v("--color-text", "#E6EDF7"),
        muted: v("--color-muted", "#94A3B8"),
        border: v("--color-borderStrong", "#3A4D6B"),
        surface: v("--color-surface", "#0F1726"),
        primary: v("--semantic-token", "#3B82F6"),
        cyan: v("--semantic-activation", "#22D3EE"),
        purple: v("--semantic-attention", "#A855F7"),
        success: v("--semantic-healthy", "#10B981"),
        warning: v("--semantic-warning", "#F59E0B"),
        error: v("--semantic-error", "#EF4444"),
        selected: v("--color-markSelected", "#FFFFFF"),
    };
}

export function requestColor(r: RequestEntity, p: ScenePalette, runtime: boolean): string {
    switch (r.state) {
        case "completed":
            return p.success;
        case "failed":
            return p.error;
        case "cancelled":
            return p.warning;
        default:
            return runtime ? p.purple : p.primary;
    }
}

// ------------------------------------------------------------------ scene

export interface ProjectedLabel {
    id: string;
    text: string;
    kind: "stage" | "layer" | "lane" | "node";
    x: number;
    y: number;
    visible: boolean;
}

export interface SceneOptions {
    reducedMotion: boolean;
    onPick(entityId: string | null): void;
    onFrame?(labels: ProjectedLabel[]): void;
}

interface Pulsing {
    material: LineBasicMaterial;
    hz: number;
    base: number;
}

const tmp = new Vector3();

function disposeObject(obj: Object3D): void {
    obj.traverse((o) => {
        const mesh = o as Mesh;
        mesh.geometry?.dispose();
        const m = mesh.material as Material | Material[] | undefined;
        if (Array.isArray(m)) {
            m.forEach((x) => x.dispose());
        } else {
            m?.dispose();
        }
    });
}

/** Creates the WebGL renderer, or returns null when WebGL is unavailable. */
export function createRenderer(canvas: HTMLCanvasElement): WebGLRenderer | null {
    try {
        // three.js r163+ renders with WebGL 2 only.
        const context = canvas.getContext("webgl2", { antialias: true, alpha: true });
        if (!context) {
            return null;
        }
        return new WebGLRenderer({ canvas, context, antialias: true, alpha: true });
    } catch {
        return null;
    }
}

export class InferenceScene {
    private readonly renderer: WebGLRenderer;
    private readonly canvas: HTMLCanvasElement;
    private readonly scene = new Scene();
    private readonly camera = new PerspectiveCamera(42, 1, 0.1, 400);
    private readonly controls: OrbitControls;
    private readonly root = new Group();
    private readonly raycaster = new Raycaster();
    private readonly pickables: Object3D[] = [];
    private readonly positions = new Map<string, Vector3>();
    private pulsing: Pulsing[] = [];
    private labels: { id: string; text: string; kind: ProjectedLabel["kind"]; at: Vector3 }[] = [];
    private selectionMarker: LineSegments | null = null;
    private palette: ScenePalette;
    private readonly options: SceneOptions;
    private reducedMotion: boolean;
    private active = false;
    private frame = 0;
    private raf = 0;
    private layout: SceneLayout | null = null;
    private selected: string | null = null;
    private home = { position: new Vector3(), target: new Vector3() };
    private downAt: { x: number; y: number } | null = null;
    private userMoved = false;

    constructor(renderer: WebGLRenderer, palette: ScenePalette, options: SceneOptions) {
        this.renderer = renderer;
        this.canvas = renderer.domElement;
        this.palette = palette;
        this.options = options;
        this.reducedMotion = options.reducedMotion;
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        this.scene.add(this.root);
        this.scene.add(new AmbientLight(0xffffff, 0.75));
        const sun = new DirectionalLight(0xffffff, 0.9);
        sun.position.set(-6, 10, 12);
        this.scene.add(sun);
        this.controls = new OrbitControls(this.camera, this.canvas);
        this.controls.enableDamping = !this.reducedMotion;
        // The wheel scrolls the page; Ctrl/Cmd + wheel zooms (and the Zoom buttons), so the canvas never traps scrolling.
        this.controls.enableZoom = false;
        this.canvas.addEventListener(
            "wheel",
            (ev) => {
                if (ev.ctrlKey || ev.metaKey) {
                    ev.preventDefault();
                    this.nudge(ev.deltaY < 0 ? "in" : "out");
                }
            },
            { passive: false },
        );
        this.controls.addEventListener("change", () => this.requestRender());
        this.controls.addEventListener("start", () => {
            this.userMoved = true;
        });
        this.canvas.addEventListener("pointerdown", (ev) => {
            this.downAt = { x: ev.clientX, y: ev.clientY };
        });
        this.canvas.addEventListener("pointerup", (ev) => {
            // A drag orbits the camera; only a click (little movement) picks.
            const d = this.downAt;
            this.downAt = null;
            if (d && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < 5) {
                this.options.onPick(this.pickAt(ev.clientX, ev.clientY));
            }
        });
    }

    get webglVersion(): number {
        return this.renderer.capabilities.isWebGL2 ? 2 : 1;
    }

    setPalette(palette: ScenePalette): void {
        this.palette = palette;
    }

    setReducedMotion(reduced: boolean): void {
        this.reducedMotion = reduced;
        this.controls.enableDamping = !reduced;
        this.syncLoop();
        this.requestRender();
    }

    /** Starts or stops rendering (the view is hidden, or the page is in the background). */
    setActive(active: boolean): void {
        this.active = active;
        this.syncLoop();
        if (active) {
            this.resize();
            this.requestRender();
        }
    }

    /** Draw calls and triangles of the last rendered frame (renderer.info; tests use it to see that WebGL drew). */
    get frameStats(): { calls: number; triangles: number; frames: number } {
        const r = this.renderer.info.render;
        return { calls: r.calls, triangles: r.triangles, frames: r.frame };
    }

    get animating(): boolean {
        return this.raf !== 0;
    }

    resize(): void {
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        if (w === 0 || h === 0) {
            return;
        }
        const size = this.renderer.getSize(new Vector2());
        if (size.x !== w || size.y !== h) {
            this.renderer.setSize(w, h, false);
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
        }
    }

    /** Rebuilds the scene for a new model (cheap: the model is small and bounded). */
    update(model: PipelineModel, selected: string | null): void {
        const before = this.layout ? `${this.layout.planes.length}|${this.layout.lanes.length}` : "";
        this.selected = selected;
        disposeObject(this.root);
        this.root.clear();
        this.pickables.length = 0;
        this.positions.clear();
        this.pulsing = [];
        this.labels = [];
        this.selectionMarker = null;
        const layout = layoutScene(model);
        this.layout = layout;
        const p = this.palette;
        const now = model.nowNs ?? 0;
        const halfH = Math.max(4.5, layout.height + 1.2) / 2;

        // Node bands (behind the lanes).
        for (const b of layout.bands) {
            const w = layout.xMax - layout.xMin + 7.5;
            const band = new Mesh(
                new PlaneGeometry(w, b.yMax - b.yMin + 0.3),
                new MeshBasicMaterial({ color: p.border, transparent: true, opacity: 0.12, depthWrite: false }),
            );
            band.position.set((layout.xMin - 6 + layout.xMax + 1.5) / 2, (b.yMin + b.yMax) / 2, -PLANE_DEPTH / 2 - 0.05);
            this.root.add(band);
            this.labels.push({ id: `node:${b.nodeId}`, text: b.nodeId, kind: "node", at: new Vector3(layout.xMin - 5.5, b.yMax, 0) });
        }
        // Lane guides.
        for (const lane of layout.lanes) {
            const g = new BufferGeometry().setFromPoints([new Vector3(layout.xMin - 5.5, lane.y, 0), new Vector3(layout.xMax + 1, lane.y, 0)]);
            this.root.add(new Line(g, new LineBasicMaterial({ color: p.border, transparent: true, opacity: 0.55 })));
            this.labels.push({ id: `lane:${lane.key}`, text: lane.label, kind: "lane", at: new Vector3(layout.xMin - 5.5, lane.y, 0) });
        }

        // Stage and layer planes: fill + outline; the outline pulses at the stage event rate.
        const stageRate = new Map(model.stages.map((s) => [`stage:${s.id}`, s.ratePerSec]));
        const layerById = new Map(model.layers.map((l) => [l.id, l]));
        const maxRms = Math.max(0, ...model.layers.map((l) => l.activationRms ?? 0));
        for (const plane of layout.planes) {
            const layer = layerById.get(plane.id);
            const isLayer = plane.stage === "layers";
            const color = isLayer ? p.cyan : plane.stage === "route" ? p.purple : p.primary;
            const rms = layer?.activationRms ?? null;
            const fillOpacity = isLayer ? 0.05 + (rms !== null && maxRms > 0 ? 0.22 * (rms / maxRms) : 0.06) : 0.07;
            const geo = new PlaneGeometry(PLANE_DEPTH, Math.max(4.5, layout.height + 1.2));
            const fill = new Mesh(geo, new MeshBasicMaterial({ color, transparent: true, opacity: fillOpacity, side: DoubleSide, depthWrite: false }));
            fill.rotation.y = Math.PI / 2;
            fill.position.set(plane.x, 0, 0);
            fill.userData.entityId = plane.id;
            fill.userData.pickPriority = 0;
            this.root.add(fill);
            this.pickables.push(fill);
            const edgeMat = new LineBasicMaterial({ color, transparent: true, opacity: 0.5 });
            const edges = new LineSegments(new EdgesGeometry(geo), edgeMat);
            edges.rotation.y = Math.PI / 2;
            edges.position.copy(fill.position);
            this.root.add(edges);
            const rate = isLayer ? (layer?.ratePerSec ?? 0) : (stageRate.get(plane.id) ?? 0);
            this.pulsing.push({ material: edgeMat, hz: pulseHz(rate), base: rate > 0 ? 0.75 : 0.4 });
            this.positions.set(plane.id, new Vector3(plane.x, halfH, 0));
            this.labels.push({ id: plane.id, text: plane.label, kind: isLayer ? "layer" : "stage", at: new Vector3(plane.x, halfH + 0.3, PLANE_DEPTH / 2) });
        }

        // Operators: small boxes above their layer plane (only when reported).
        const planeX = new Map(layout.planes.map((pl) => [pl.layer ?? -1, pl.x]));
        const opsByLayer = new Map<number, number>();
        for (const op of model.operators) {
            const x = op.layer !== null ? planeX.get(op.layer) : layout.stageX.layers;
            if (x === undefined) {
                continue;
            }
            const k = opsByLayer.get(op.layer ?? -1) ?? 0;
            opsByLayer.set(op.layer ?? -1, k + 1);
            const color = /attention/i.test(op.operator) ? p.purple : /mlp|ffn|feed/i.test(op.operator) ? p.cyan : p.muted;
            const box = new Mesh(new BoxGeometry(0.35, 0.35, 0.35), new MeshStandardMaterial({ color, emissive: new Color(color), emissiveIntensity: 0.35 }));
            box.position.set(x, halfH - 0.4, -PLANE_DEPTH / 2 + 0.6 + k * 0.55);
            box.userData.entityId = op.id;
            box.userData.pickPriority = 2;
            this.root.add(box);
            this.pickables.push(box);
            this.positions.set(op.id, box.position.clone());
        }

        // KV pools: a wire volume per producer instance, filled to logical blocks in use.
        const kvX = (layout.stageX.prefill ?? 0) + STAGE_GAP / 2;
        const bandOf = new Map(layout.bands.map((b) => [b.nodeId, b]));
        const poolsPerNode = new Map<string, number>();
        for (const pool of model.kvPools) {
            const band = bandOf.get(pool.nodeId) ?? { yMin: -layout.height / 2, yMax: layout.height / 2 };
            const k = poolsPerNode.get(pool.nodeId) ?? 0;
            poolsPerNode.set(pool.nodeId, k + 1);
            const h = Math.max(0.8, band.yMax - band.yMin - 0.3);
            const frac = pool.totalBlocks && pool.totalBlocks > 0 ? Math.min(1, pool.usedBlocks / pool.totalBlocks) : (pool.occupancy ?? 0);
            const tone = pool.level === "critical" ? p.error : pool.level === "high" ? p.warning : p.primary;
            const cx = kvX + k * 1.4;
            const cz = -PLANE_DEPTH / 2 + 0.8;
            const shell = new LineSegments(
                new EdgesGeometry(new BoxGeometry(1, h, 1)),
                new LineBasicMaterial({ color: tone, transparent: true, opacity: 0.8 }),
            );
            shell.position.set(cx, (band.yMin + band.yMax) / 2, cz);
            this.root.add(shell);
            const fillH = Math.max(0.02, h * frac);
            const fill = new Mesh(new BoxGeometry(0.96, fillH, 0.96), new MeshStandardMaterial({ color: tone, transparent: true, opacity: 0.55 }));
            fill.position.set(cx, band.yMin + 0.15 + fillH / 2, cz);
            // The whole volume is the pick target.
            const hit = new Mesh(new BoxGeometry(1, h, 1), new MeshBasicMaterial({ visible: false }));
            hit.position.copy(shell.position);
            hit.userData.entityId = pool.id;
            hit.userData.pickPriority = 2;
            this.root.add(fill, hit);
            this.pickables.push(hit);
            this.positions.set(pool.id, shell.position.clone());
        }

        // Requests.
        const laneY = new Map(layout.lanes.map((l) => [l.key, l.y]));
        const cellCount = new Map<string, number>();
        const cellIndex = new Map<string, number>();
        for (const r of model.requests) {
            const cell = `${r.laneKey}|${r.stage}`;
            cellCount.set(cell, (cellCount.get(cell) ?? 0) + 1);
        }
        const sphere = new SphereGeometry(1, 20, 14);
        for (const r of model.requests) {
            const cell = `${r.laneKey}|${r.stage}`;
            const n = cellCount.get(cell)!;
            const i = cellIndex.get(cell) ?? 0;
            cellIndex.set(cell, i + 1);
            const spread = Math.min(0.7, (PLANE_DEPTH - 1.2) / Math.max(1, n));
            const z = (i - (n - 1) / 2) * spread;
            const x = (layout.stageX[r.stage] ?? layout.stageX.decode ?? 0) + (r.stage === "output" ? 0 : 0.6);
            const y = (laneY.get(r.laneKey) ?? 0) + ((i % 3) - 1) * 0.18;
            const runtime = r.role === "runtime" || r.producer === "sonder-runtime";
            const color = requestColor(r, p, runtime);
            const opacity = r.state === "active" ? 1 : ageOpacity((now - (r.endNs ?? r.lastNs)) / 1e6, REQUEST_FADE_MS, 0.3);
            const mesh = new Mesh(
                sphere,
                new MeshStandardMaterial({
                    color,
                    emissive: new Color(color),
                    emissiveIntensity: r.state === "active" ? 0.45 : 0.2,
                    transparent: opacity < 1,
                    opacity,
                }),
            );
            const radius = requestRadius(r);
            mesh.scale.setScalar(radius);
            mesh.position.set(x, y, z);
            mesh.userData.entityId = r.id;
            mesh.userData.pickPriority = 3;
            mesh.userData.shared = true;
            this.root.add(mesh);
            this.pickables.push(mesh);
            this.positions.set(r.id, mesh.position.clone());
        }

        // Runtime turn -> Inference request links.
        for (const link of model.links) {
            const a = this.positions.get(link.from);
            const b = this.positions.get(link.to);
            if (a && b) {
                const g = new BufferGeometry().setFromPoints([a, b]);
                this.root.add(new Line(g, new LineBasicMaterial({ color: p.purple, transparent: true, opacity: 0.55 })));
            }
        }

        // Output events (chunks/tokens): drift from decode toward output as they age, fading out.
        const decodeX = layout.stageX.decode ?? 0;
        const outputX = layout.stageX.output ?? decodeX + STAGE_GAP;
        const chunkGeo = new SphereGeometry(1, 10, 8);
        model.chunks.forEach((c, i) => {
            const ageMs = (now - c.ns) / 1e6;
            if (ageMs > CHUNK_FADE_MS) {
                return;
            }
            const t = Math.min(1, Math.max(0, ageMs / CHUNK_FADE_MS));
            const y = (c.laneKey ? laneY.get(c.laneKey) : undefined) ?? 0;
            const m = new Mesh(chunkGeo, new MeshBasicMaterial({ color: p.cyan, transparent: true, opacity: ageOpacity(ageMs, CHUNK_FADE_MS, 0.12) }));
            m.scale.setScalar(Math.min(0.2, 0.05 + 0.012 * Math.sqrt(c.bytes ?? 1)));
            m.position.set(decodeX + 0.9 + (outputX - decodeX - 1.4) * t, y + (((i * 37) % 9) - 4) * 0.08, (((i * 53) % 11) - 5) * 0.28);
            m.userData.entityId = c.id;
            m.userData.pickPriority = 1;
            m.userData.shared = true;
            this.root.add(m);
            this.pickables.push(m);
            this.positions.set(c.id, m.position.clone());
        });

        // Output distribution: probability bars of the latest token with alternatives (only when reported).
        const latest = [...model.tokens].reverse().find((t) => t.alternatives && t.alternatives.length > 0) ?? null;
        if (latest?.alternatives) {
            latest.alternatives.slice(0, 5).forEach((a, i) => {
                const len = Math.max(0.05, a.probability * 3);
                const bar = new Mesh(
                    new BoxGeometry(len, 0.28, 0.28),
                    new MeshStandardMaterial({ color: p.warning, emissive: new Color(p.warning), emissiveIntensity: 0.3 }),
                );
                bar.position.set(outputX + 1.2 + len / 2, halfH - 0.6 - i * 0.45, PLANE_DEPTH / 2 - 0.6);
                bar.userData.entityId = latest.id;
                bar.userData.pickPriority = 2;
                this.root.add(bar);
                this.pickables.push(bar);
            });
            this.positions.set(latest.id, new Vector3(outputX + 1.8, halfH - 0.6, PLANE_DEPTH / 2 - 0.6));
        }

        this.drawSelection();
        // Re-frame when the pipeline's shape changes (new lanes or layer planes), unless the user moved the camera.
        if (before !== `${layout.planes.length}|${layout.lanes.length}` && !this.userMoved) {
            this.frameCamera();
        }
        this.requestRender();
    }

    setSelected(id: string | null): void {
        this.selected = id;
        this.drawSelection();
        this.requestRender();
    }

    private drawSelection(): void {
        if (this.selectionMarker) {
            this.root.remove(this.selectionMarker);
            disposeObject(this.selectionMarker);
            this.selectionMarker = null;
        }
        const at = this.selected ? this.positions.get(this.selected) : undefined;
        if (!at) {
            return;
        }
        const marker = new LineSegments(new EdgesGeometry(new BoxGeometry(1.1, 1.1, 1.1)), new LineBasicMaterial({ color: this.palette.selected }));
        marker.position.copy(at);
        this.selectionMarker = marker;
        this.root.add(marker);
    }

    /** Frames the whole pipeline from a front-left, slightly raised viewpoint. */
    frameCamera(): void {
        this.resize();
        const l = this.layout;
        // Bounds: planes plus the lane labels on the left and the probability bars on the right.
        const x0 = (l?.xMin ?? 0) - 6;
        const x1 = (l?.xMax ?? 20) + 4.5;
        const h = (l?.height ?? 4) + 2;
        const cx = (x0 + x1) / 2;
        const vFov = (this.camera.fov * Math.PI) / 180;
        const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
        // Fit the pipeline's width and height (plus the plane depth seen at an angle).
        const distance = Math.max((x1 - x0) / 2 / Math.tan(hFov / 2), (h + PLANE_DEPTH * 0.3) / 2 / Math.tan(vFov / 2)) + PLANE_DEPTH / 2;
        const dir = new Vector3(-0.32, 0.3, 1).normalize();
        this.home.target.set(cx, 0, 0);
        this.home.position.copy(this.home.target).addScaledVector(dir, distance);
        this.resetView();
    }

    /** Back to the framed view; the camera follows the pipeline's shape again. */
    reset(): void {
        this.userMoved = false;
        this.frameCamera();
    }

    resetView(): void {
        this.camera.position.copy(this.home.position);
        this.controls.target.copy(this.home.target);
        this.controls.update();
        this.requestRender();
    }

    /** Keyboard camera controls (buttons): rotate around the target or dolly. */
    nudge(action: "left" | "right" | "up" | "down" | "in" | "out"): void {
        this.userMoved = true;
        const offset = this.camera.position.clone().sub(this.controls.target);
        if (action === "in" || action === "out") {
            offset.multiplyScalar(action === "in" ? 0.85 : 1 / 0.85);
        } else {
            const axis = action === "left" || action === "right" ? new Vector3(0, 1, 0) : new Vector3().crossVectors(offset, new Vector3(0, 1, 0)).normalize();
            const angle = (action === "left" || action === "up" ? 1 : -1) * (Math.PI / 12);
            offset.applyAxisAngle(axis, angle);
        }
        this.camera.position.copy(this.controls.target).add(offset);
        this.controls.update();
        this.requestRender();
    }

    /** Topmost pickable entity under a client point. */
    pickAt(clientX: number, clientY: number): string | null {
        const rect = this.canvas.getBoundingClientRect();
        const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
        this.raycaster.setFromCamera(ndc, this.camera);
        const hits = this.raycaster.intersectObjects(this.pickables, false);
        if (hits.length === 0) {
            return null;
        }
        // Prefer particles over the planes they sit in; then the nearest.
        hits.sort((a, b) => (b.object.userData.pickPriority as number) - (a.object.userData.pickPriority as number) || a.distance - b.distance);
        return (hits[0]!.object.userData.entityId as string) ?? null;
    }

    /** Client coordinates of an entity (tests and label placement). */
    screenPoint(id: string): { x: number; y: number } | null {
        const at = this.positions.get(id);
        if (!at) {
            return null;
        }
        return this.project(at);
    }

    private project(at: Vector3): { x: number; y: number } | null {
        const rect = this.canvas.getBoundingClientRect();
        tmp.copy(at).project(this.camera);
        if (tmp.z > 1) {
            return null;
        }
        return { x: rect.left + ((tmp.x + 1) / 2) * rect.width, y: rect.top + ((1 - tmp.y) / 2) * rect.height };
    }

    requestRender(): void {
        if (this.frame !== 0 || !this.active) {
            return;
        }
        this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            this.draw(performance.now());
        });
    }

    private syncLoop(): void {
        const want = this.active && !this.reducedMotion;
        if (want && this.raf === 0) {
            const loop = (t: number) => {
                this.raf = requestAnimationFrame(loop);
                this.draw(t);
            };
            this.raf = requestAnimationFrame(loop);
        } else if (!want && this.raf !== 0) {
            cancelAnimationFrame(this.raf);
            this.raf = 0;
        }
    }

    private draw(t: number): void {
        this.resize();
        if (!this.reducedMotion) {
            this.controls.update();
        }
        for (const pulse of this.pulsing) {
            pulse.material.opacity =
                this.reducedMotion || pulse.hz === 0 ? pulse.base : pulse.base * (0.65 + 0.35 * Math.sin((t / 1000) * pulse.hz * Math.PI * 2));
        }
        this.renderer.render(this.scene, this.camera);
        if (this.options.onFrame) {
            this.options.onFrame(
                this.labels.map((l) => {
                    const at = this.project(l.at);
                    const rect = this.canvas.getBoundingClientRect();
                    return {
                        id: l.id,
                        text: l.text,
                        kind: l.kind,
                        x: at ? at.x - rect.left : 0,
                        y: at ? at.y - rect.top : 0,
                        visible: at !== null && at.x >= rect.left && at.x <= rect.right && at.y >= rect.top && at.y <= rect.bottom,
                    };
                }),
            );
        }
    }

    dispose(): void {
        this.setActive(false);
        if (this.frame !== 0) {
            cancelAnimationFrame(this.frame);
            this.frame = 0;
        }
        this.controls.dispose();
        disposeObject(this.root);
        this.renderer.dispose();
    }
}
