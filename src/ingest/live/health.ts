/**
 * Optional producer health and node documents (Sonder-Inference
 * `GET /v1/sonder/health` and `GET /v1/sonder/node`, named by discovery
 * `links.health` and `links.node`).
 *
 * Reads backend capabilities, model lists, telemetry level, per-GPU inventory
 * (`gpus[]`), hybrid GPU pool summaries (`gpu_pool`, `combined_gpu_vram_mib`),
 * and node capabilities. Everything else is ignored.
 *
 * Security rules:
 * - Same-origin against the discovery URL (cross-origin links are refused).
 * - Endpoint policy enforced (no credentials or token query params; plain
 *   http:// only on loopback).
 * - `/v1/sonder/node` additionally enforces a strict loopback / private-host
 *   SSRF guard (allowing loopback, RFC 1918 private IPv4, RFC 4193 IPv6 ULA,
 *   and `.local` / `.home.arpa` LAN names; rejecting cloud metadata
 *   `169.254.0.0/16`, link-local `fe80::/10`, IPv4-mapped IPv6 bypasses, and
 *   public IPs/domains).
 * - Redirects are refused, credentials are omitted, bodies are byte-capped,
 *   and failures are silent.
 */
import { readBoundedText } from "./discovery";
import { endpointPolicyViolation } from "./endpoint";
import { NO_CREDENTIALS, NO_REDIRECTS, isRedirect, type FetchLike } from "./transports";

export interface HealthBackend {
    name: string;
    available: boolean | null;
    capabilities: string[];
}

export interface HealthGpuDevice {
    id: string;
    name: string;
    vendor: string | null;
    vendorId: number | null;
    deviceId: number | null;
    dedicatedTotalMib: number | null;
    dedicatedFreeMib: number | null;
    sharedTotalMib: number | null;
    effectiveVramMib: number | null;
    effectiveFreeVramMib: number | null;
    isIntegratedUma: boolean | null;
    backendHint: string | null;
    source: string | null;
}

export interface HealthGpuPool {
    discreteVramMib: number | null;
    integratedUmaVramMib: number | null;
    combinedGpuVramMib: number | null;
    discreteFreeVramMib: number | null;
    integratedUmaFreeVramMib: number | null;
    combinedFreeGpuVramMib: number | null;
    discreteGpuCount: number | null;
    integratedUmaGpuCount: number | null;
    hybridVulkanPoolAvailable: boolean | null;
    recommendedDevices: string[];
    llamaArgDevice: string | null;
}

export interface ProducerHealth {
    backends: HealthBackend[];
    models: { id: string; backend: string | null }[];
    telemetryLevel: string | null;
    /** Optional GPU inventory reported on `/v1/sonder/health` (`gpus[]`). */
    gpus?: HealthGpuDevice[];
    /** Optional GPU pool summary when reported alongside health. */
    gpuPool?: HealthGpuPool | null;
    /** Optional combined discrete + integrated UMA VRAM (MiB) when reported. */
    combinedGpuVramMib?: number | null;
}

export interface ProducerNode {
    schema: string | null;
    nodeId: string | null;
    instanceId: string | null;
    platform: string | null;
    version: string | null;
    synthetic: boolean;
    gpus: HealthGpuDevice[];
    combinedGpuVramMib: number | null;
    gpuPool: HealthGpuPool | null;
    capabilities: Record<string, boolean>;
    backends: HealthBackend[];
    models: { id: string; backend: string | null }[];
}

export const MAX_HEALTH_BYTES = 64 * 1024;
export const MAX_NODE_BYTES = 128 * 1024;
const HEALTH_TIMEOUT_MS = 4000;
const MAX_GPUS = 64;
const MAX_RECOMMENDED_DEVICES = 32;
const MAX_CAPABILITIES = 64;
const MAX_TEXT_LEN = 256;

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function boundedText(v: unknown): string | null {
    if (typeof v !== "string") {
        return null;
    }
    const trimmed = v.trim();
    if (trimmed.length === 0) {
        return null;
    }
    return trimmed.length > MAX_TEXT_LEN ? trimmed.slice(0, MAX_TEXT_LEN) : trimmed;
}

function nonNegInt(v: unknown): number | null {
    return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function parseBackends(value: unknown): HealthBackend[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const backends: HealthBackend[] = [];
    for (const b of value) {
        if (!isObject(b) || typeof b.name !== "string" || b.name === "") {
            continue;
        }
        backends.push({
            name: b.name,
            available: typeof b.available === "boolean" ? b.available : null,
            capabilities: Array.isArray(b.capabilities) ? b.capabilities.filter((c): c is string => typeof c === "string") : [],
        });
    }
    return backends;
}

function parseModels(value: unknown): { id: string; backend: string | null }[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .filter(isObject)
        .flatMap((m) => (typeof m.id === "string" ? [{ id: m.id, backend: typeof m.backend === "string" ? m.backend : null }] : []));
}

/** Parses `gpus[]` from `/v1/sonder/health` or `/v1/sonder/node` (`gpu_inventory_json`). */
export function parseGpuInventory(value: unknown): HealthGpuDevice[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const gpus: HealthGpuDevice[] = [];
    for (const raw of value) {
        if (gpus.length >= MAX_GPUS) {
            break;
        }
        if (!isObject(raw)) {
            continue;
        }
        const id = boundedText(raw.id);
        const name = boundedText(raw.name) ?? id;
        if (id === null && name === null) {
            continue;
        }
        gpus.push({
            id: id ?? `gpu:${gpus.length}`,
            name: name ?? id!,
            vendor: boundedText(raw.vendor),
            vendorId: nonNegInt(raw.vendor_id),
            deviceId: nonNegInt(raw.device_id),
            dedicatedTotalMib: nonNegInt(raw.dedicated_total_mib),
            dedicatedFreeMib: nonNegInt(raw.dedicated_free_mib),
            sharedTotalMib: nonNegInt(raw.shared_total_mib),
            effectiveVramMib: nonNegInt(raw.effective_vram_mib),
            effectiveFreeVramMib: nonNegInt(raw.effective_free_vram_mib),
            isIntegratedUma: typeof raw.is_integrated_uma === "boolean" ? raw.is_integrated_uma : null,
            backendHint: boundedText(raw.backend_hint),
            source: boundedText(raw.source),
        });
    }
    return gpus;
}

/** Parses `gpu_pool` from `/v1/sonder/node` or `/v1/sonder/health` (`gpu_pool_summary_to_json`). */
export function parseGpuPool(value: unknown): HealthGpuPool | null {
    if (!isObject(value)) {
        return null;
    }
    const recommendedDevices: string[] = [];
    if (Array.isArray(value.recommended_devices)) {
        for (const item of value.recommended_devices) {
            if (recommendedDevices.length >= MAX_RECOMMENDED_DEVICES) {
                break;
            }
            const t = boundedText(item);
            if (t !== null) {
                recommendedDevices.push(t);
            }
        }
    }
    const parsed: HealthGpuPool = {
        discreteVramMib: nonNegInt(value.discrete_vram_mib),
        integratedUmaVramMib: nonNegInt(value.integrated_uma_vram_mib),
        combinedGpuVramMib: nonNegInt(value.combined_gpu_vram_mib),
        discreteFreeVramMib: nonNegInt(value.discrete_free_vram_mib),
        integratedUmaFreeVramMib: nonNegInt(value.integrated_uma_free_vram_mib),
        combinedFreeGpuVramMib: nonNegInt(value.combined_free_gpu_vram_mib),
        discreteGpuCount: nonNegInt(value.discrete_gpu_count),
        integratedUmaGpuCount: nonNegInt(value.integrated_uma_gpu_count),
        hybridVulkanPoolAvailable:
            typeof value.hybrid_vulkan_pool_available === "boolean" ? value.hybrid_vulkan_pool_available : null,
        recommendedDevices,
        llamaArgDevice: boundedText(value.llama_arg_device),
    };
    const hasAnyField =
        parsed.discreteVramMib !== null ||
        parsed.integratedUmaVramMib !== null ||
        parsed.combinedGpuVramMib !== null ||
        parsed.discreteFreeVramMib !== null ||
        parsed.integratedUmaFreeVramMib !== null ||
        parsed.combinedFreeGpuVramMib !== null ||
        parsed.discreteGpuCount !== null ||
        parsed.integratedUmaGpuCount !== null ||
        parsed.hybridVulkanPoolAvailable !== null ||
        parsed.recommendedDevices.length > 0 ||
        parsed.llamaArgDevice !== null;
    return hasAnyField ? parsed : null;
}

/** Reads the fields Observatory uses from `/v1/sonder/health`; null when the document has no backend list. */
export function parseHealth(value: unknown): ProducerHealth | null {
    if (!isObject(value) || !Array.isArray(value.backends)) {
        return null;
    }
    const backends = parseBackends(value.backends);
    const models = parseModels(value.models);
    const telemetry = isObject(value.telemetry) ? value.telemetry : null;
    const out: ProducerHealth = {
        backends,
        models,
        telemetryLevel: telemetry && typeof telemetry.level === "string" ? telemetry.level : null,
    };
    if (Array.isArray(value.gpus)) {
        out.gpus = parseGpuInventory(value.gpus);
    }
    const gpuPool = parseGpuPool(value.gpu_pool);
    if (gpuPool !== null) {
        out.gpuPool = gpuPool;
    }
    const combined = nonNegInt(value.combined_gpu_vram_mib) ?? gpuPool?.combinedGpuVramMib ?? null;
    if (combined !== null) {
        out.combinedGpuVramMib = combined;
    }
    return out;
}

/** Parses `/v1/sonder/node` (`sonder.inference.node/1`); null when the payload is not a valid node object. */
export function parseNode(value: unknown): ProducerNode | null {
    if (!isObject(value)) {
        return null;
    }
    const schema = boundedText(value.schema);
    if (schema !== null && !schema.startsWith("sonder.inference.node/")) {
        return null;
    }
    const hasNodeShape =
        schema !== null ||
        Array.isArray(value.gpus) ||
        isObject(value.gpu_pool) ||
        nonNegInt(value.combined_gpu_vram_mib) !== null;
    if (!hasNodeShape) {
        return null;
    }
    const gpus = parseGpuInventory(value.gpus);
    const gpuPool = parseGpuPool(value.gpu_pool);
    const combinedGpuVramMib = nonNegInt(value.combined_gpu_vram_mib) ?? gpuPool?.combinedGpuVramMib ?? null;
    const capabilities: Record<string, boolean> = {};
    if (isObject(value.capabilities)) {
        let count = 0;
        for (const [k, v] of Object.entries(value.capabilities)) {
            if (count >= MAX_CAPABILITIES) {
                break;
            }
            if (typeof v === "boolean" && k.length > 0 && k.length <= MAX_TEXT_LEN) {
                capabilities[k] = v;
                count += 1;
            }
        }
    }
    return {
        schema,
        nodeId: boundedText(value.node_id),
        instanceId: boundedText(value.instance_id),
        platform: boundedText(value.platform),
        version: boundedText(value.version),
        synthetic: value.synthetic === true,
        gpus,
        combinedGpuVramMib,
        gpuPool,
        capabilities,
        backends: parseBackends(value.backends),
        models: parseModels(value.models),
    };
}

// ---------------------------------------------------------------------------
// Strict SSRF host & URL guards for discovery links (`links.health` / `links.node`)
// ---------------------------------------------------------------------------

const BLOCKED_METADATA_HOSTS = new Set(["metadata.google.internal", "metadata", "instance-data"]);
const LOCAL_DOMAIN_RE =
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.(?:local|home\.arpa)$/;

function parseIpv4Octets(host: string): [number, number, number, number] | null {
    const parts = host.split(".");
    if (parts.length !== 4) {
        return null;
    }
    const nums: number[] = [];
    for (const part of parts) {
        if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) {
            return null;
        }
        const n = Number(part);
        if (!Number.isInteger(n) || n < 0 || n > 255) {
            return null;
        }
        nums.push(n);
    }
    return nums as [number, number, number, number];
}

function isPrivateOrLoopbackIpv4(octets: readonly [number, number, number, number]): boolean {
    const [a, b] = octets;
    if (a === 127) {
        return true; // 127.0.0.0/8 loopback
    }
    if (a === 10) {
        return true; // 10.0.0.0/8 RFC 1918
    }
    if (a === 172 && b >= 16 && b <= 31) {
        return true; // 172.16.0.0/12 RFC 1918
    }
    if (a === 192 && b === 168) {
        return true; // 192.168.0.0/16 RFC 1918
    }
    // Explicitly rejects 0.0.0.0/8, 169.254.0.0/16 (link-local / cloud IMDS), multicast, and all public IPv4.
    return false;
}

function extractMappedIpv4FromIpv6(ip6: string): [number, number, number, number] | null {
    // Dotted form: ::ffff:a.b.c.d
    const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ip6);
    if (dotted) {
        return parseIpv4Octets(dotted[1]!);
    }
    // Canonical WHATWG URL hex-pair form: ::ffff:xxxx:yyyy
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip6);
    if (hex) {
        const hi = parseInt(hex[1]!, 16);
        const lo = parseInt(hex[2]!, 16);
        return [(hi >>> 8) & 0xff, hi & 0xff, (lo >>> 8) & 0xff, lo & 0xff];
    }
    return null;
}

/**
 * Strict SSRF host allowlist for `/v1/sonder/node` fetches:
 * - Loopback (`localhost`, `127.0.0.0/8`, `[::1]`)
 * - Private RFC 1918 IPv4 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)
 * - Private RFC 4193 IPv6 ULA (`fc00::/7`, excluding link-local `fe80::/10` and unspecified `::`)
 * - Local LAN domains (`.local`, `.home.arpa`)
 *
 * Explicitly rejects cloud metadata endpoints (`169.254.169.254`,
 * `metadata.google.internal`), IPv4-mapped IPv6 bypasses (`[::ffff:169.254.169.254]`,
 * `[::ffff:8.8.8.8]`), link-local addresses, and public hosts.
 */
export function isAllowedNodeHost(hostname: string): boolean {
    const raw = hostname.trim().toLowerCase();
    if (raw.length === 0 || raw.endsWith(".")) {
        return false;
    }
    const bare = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
    if (bare.length === 0 || BLOCKED_METADATA_HOSTS.has(bare)) {
        return false;
    }
    if (bare === "localhost" || bare === "::1") {
        return true;
    }
    if (bare.includes(":")) {
        const mapped = extractMappedIpv4FromIpv6(bare);
        if (mapped !== null) {
            return isPrivateOrLoopbackIpv4(mapped);
        }
        // Strict IPv6 hex/colon syntax only (no zone IDs `%eth0` or non-hex suffixes).
        if (!/^[0-9a-f:]+$/.test(bare) || bare.includes(":::")) {
            return false;
        }
        // RFC 4193 Unique Local Address fc00::/7 (first 16-bit group fc00..fdff), never fe80::/10 link-local or ::.
        const firstGroup = bare.split(":")[0] ?? "";
        if (/^[0-9a-f]{1,4}$/.test(firstGroup)) {
            const val = parseInt(firstGroup, 16);
            if (val >= 0xfc00 && val <= 0xfdff) {
                return true;
            }
        }
        return false;
    }
    const ipv4 = parseIpv4Octets(bare);
    if (ipv4 !== null) {
        return isPrivateOrLoopbackIpv4(ipv4);
    }
    // Only explicit RFC-valid mDNS/LAN suffixes; never `.internal` or public domains.
    return LOCAL_DOMAIN_RE.test(bare);
}

function isHttpUrl(url: URL): boolean {
    return url.protocol === "http:" || url.protocol === "https:";
}

function validateNodeFetchUrl(rawUrl: string): URL | null {
    try {
        const url = new URL(rawUrl);
        if (!isHttpUrl(url)) {
            return null;
        }
        if (endpointPolicyViolation(url) !== null) {
            return null;
        }
        if (!isAllowedNodeHost(url.hostname)) {
            return null;
        }
        return url;
    } catch {
        return null;
    }
}

/** Resolves a discovery `links.health` against the discovery URL; null unless same-origin and policy-valid. */
export function healthUrl(discoveryUrl: string, link: unknown): string | null {
    if (typeof link !== "string" || link === "") {
        return null;
    }
    try {
        const base = new URL(discoveryUrl);
        const url = new URL(link, base);
        if (!isHttpUrl(url) || url.origin !== base.origin) {
            return null;
        }
        if (endpointPolicyViolation(url) !== null) {
            return null;
        }
        return url.href;
    } catch {
        return null;
    }
}

/**
 * Resolves a discovery `links.node` (`/v1/sonder/node`) against the discovery URL;
 * null unless it stays strictly on the same origin, passes endpoint policy (no
 * credentials/secret query params; HTTPS for non-loopback), and targets an
 * allowlisted loopback or private-network host.
 */
export function nodeUrl(discoveryUrl: string, link: unknown): string | null {
    if (typeof link !== "string" || link === "") {
        return null;
    }
    try {
        const base = new URL(discoveryUrl);
        const url = new URL(link, base);
        if (!isHttpUrl(url) || url.origin !== base.origin) {
            return null;
        }
        if (endpointPolicyViolation(url) !== null) {
            return null;
        }
        if (!isAllowedNodeHost(url.hostname)) {
            return null;
        }
        return url.href;
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
        const response = await fetchImpl(url, {
            headers,
            signal: controller.signal,
            cache: "no-store",
            credentials: NO_CREDENTIALS,
            redirect: NO_REDIRECTS,
        });
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

/**
 * Fetches `links.node` (`/v1/sonder/node`) with defense-in-depth SSRF validation,
 * no redirects, no credentials, bounded response size, and silent failure.
 */
export async function fetchProducerNode(
    url: string,
    options: { token?: string; fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<ProducerNode | null> {
    const validated = validateNodeFetchUrl(url);
    if (validated === null) {
        return null;
    }
    const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? HEALTH_TIMEOUT_MS);
    const headers: Record<string, string> = { Accept: "application/json", "Cache-Control": "no-store" };
    if (options.token !== undefined) {
        headers.Authorization = `Bearer ${options.token}`;
    }
    try {
        const response = await fetchImpl(validated.href, {
            headers,
            signal: controller.signal,
            cache: "no-store",
            credentials: NO_CREDENTIALS,
            redirect: NO_REDIRECTS,
        });
        if (isRedirect(response) || !response.ok) {
            await response.body?.cancel().catch(() => undefined);
            return null;
        }
        const read = await readBoundedText(response, MAX_NODE_BYTES);
        return read.ok ? parseNode(JSON.parse(read.text)) : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}
