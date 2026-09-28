/**
 * Optional producer health document (Sonder-Inference `GET /v1/sonder/health`,
 * named by discovery `links.health`). Observatory reads only the backend
 * list (`backends[].name`, `available`, `capabilities`), the model list and
 * the telemetry level, to explain which 3D Inference panels a producer can
 * feed. Everything else is ignored.
 *
 * Same rules as discovery: the bearer token goes only to the discovery
 * URL's origin (a health link on another origin is not fetched), redirects
 * are refused, the body is capped, and a failure is silent (the view then
 * relies on in-stream `backend.registered` events).
 */
import { readBoundedText } from "./discovery";
import { NO_REDIRECTS, isRedirect, type FetchLike } from "./transports";

export interface HealthBackend {
    name: string;
    available: boolean | null;
    capabilities: string[];
}

export interface ProducerHealth {
    backends: HealthBackend[];
    models: { id: string; backend: string | null }[];
    telemetryLevel: string | null;
}

export const MAX_HEALTH_BYTES = 64 * 1024;
const HEALTH_TIMEOUT_MS = 4000;

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reads the fields Observatory uses; null when the document has no backend list. */
export function parseHealth(value: unknown): ProducerHealth | null {
    if (!isObject(value) || !Array.isArray(value.backends)) {
        return null;
    }
    const backends: HealthBackend[] = [];
    for (const b of value.backends) {
        if (!isObject(b) || typeof b.name !== "string" || b.name === "") {
            continue;
        }
        backends.push({
            name: b.name,
            available: typeof b.available === "boolean" ? b.available : null,
            capabilities: Array.isArray(b.capabilities) ? b.capabilities.filter((c): c is string => typeof c === "string") : [],
        });
    }
    const models = Array.isArray(value.models)
        ? value.models
              .filter(isObject)
              .flatMap((m) => (typeof m.id === "string" ? [{ id: m.id, backend: typeof m.backend === "string" ? m.backend : null }] : []))
        : [];
    const telemetry = isObject(value.telemetry) ? value.telemetry : null;
    return { backends, models, telemetryLevel: telemetry && typeof telemetry.level === "string" ? telemetry.level : null };
}

/** Resolves a discovery `links.health` against the discovery URL; null unless it stays on the same origin. */
export function healthUrl(discoveryUrl: string, link: unknown): string | null {
    if (typeof link !== "string" || link === "") {
        return null;
    }
    try {
        const base = new URL(discoveryUrl);
        const url = new URL(link, base);
        return url.origin === base.origin ? url.href : null;
    } catch {
        return null;
    }
}

export async function fetchProducerHealth(
    url: string,
    options: { token?: string; fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<ProducerHealth | null> {
    const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? HEALTH_TIMEOUT_MS);
    const headers: Record<string, string> = { Accept: "application/json", "Cache-Control": "no-store" };
    if (options.token !== undefined) {
        headers.Authorization = `Bearer ${options.token}`;
    }
    try {
        const response = await fetchImpl(url, { headers, signal: controller.signal, cache: "no-store", redirect: NO_REDIRECTS });
        // Health answers 503 while starting or draining but still describes the backends.
        if (isRedirect(response) || (!response.ok && response.status !== 503)) {
            await response.body?.cancel().catch(() => undefined);
            return null;
        }
        const read = await readBoundedText(response, MAX_HEALTH_BYTES);
        return read.ok ? parseHealth(JSON.parse(read.text)) : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}
