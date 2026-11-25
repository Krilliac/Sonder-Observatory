/**
 * Wave 3 export hardening regression tests:
 *  - HTML/SVG XSS, CSS injection, protocol-relative URLs, control/bidi chars, NaN/bounds
 *  - Markdown injection (code() newline/table/</details> breakout, generatedAt/format, prototype severity, budget edge cases)
 *  - Sensitivity & secret redaction gaps (redacted/sha256 prefix spoofing, nested attributes, secret keys & patterns, fixture non-regression)
 *  - Filter / save / sobs edge cases (NaN bounds, invalid Date, Blob URL revocation on error)
 *  - Wave 2 fields (execution_route, orchestration, embed requests, hybrid discrete+UMA GPU summaries) across HTML/Markdown/JSON
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    assessExportSensitivity,
    buildReport,
    describeRange,
    filterEvents,
    mdEscape,
    metricRows,
    renderExport,
    renderHtml,
    renderJson,
    renderMarkdown,
    renderSobs,
    resolveColor,
    sensitiveExportWarning,
    suggestedFileName,
    type JsonExport,
} from "../../src/export";
import { clip } from "../../src/export/markdown";
import { downloadText, type DownloadHost } from "../../src/export/save";
import { isUnsafeControlCode } from "../../src/export/svg";

function hasUnsafeControl(text: string): boolean {
    for (let i = 0; i < text.length; i += 1) {
        if (isUnsafeControlCode(text.charCodeAt(i))) {
            return true;
        }
    }
    return false;
}
import type { ObservatoryEvent } from "../../src/protocol/events";
import { loadRecording } from "../../src/recording/sobs";
import { at } from "../helpers";
import { fixtureEvents, GENERATED_AT } from "./fixture";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function readJsonlFixture(name: string): ObservatoryEvent[] {
    const text = readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
    return text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as ObservatoryEvent);
}

function externalReferences(doc: string): string[] {
    const found: string[] = [];
    const tags = [...doc.matchAll(/<[a-zA-Z][^>]*>/g)].map((m) => m[0]).join("\n");
    const checks: [string, RegExp][] = [
        ["absolute URL", /\b(?:https?|ftp|wss?):\/\//i],
        ["protocol-relative URL", /["'(=\s]\/\/[a-z0-9-]+\.[a-z0-9.-]+/i],
        ["src/href/action attribute", /\s(?:src|srcset|href|xlink:href|action|poster|data|formaction)\s*=/i],
        ["fetching element", /<(?:script|link|iframe|frame|object|embed|img|video|audio|source|base|form)\b/i],
        ["@import", /@import/i],
        ["non-fragment url()", /url\(\s*(?!['"]?#)/i],
    ];
    for (const [label, re] of checks) {
        const hay = label === "src/href/action attribute" ? tags : doc;
        const m = re.exec(hay);
        if (m) {
            found.push(`${label}: ${hay.slice(Math.max(0, m.index - 20), m.index + 40)}`);
        }
    }
    return found;
}

describe("HTML & SVG export hardening", () => {
    it("neutralises protocol-relative URLs, CSS url(), @import, and strips control/bidi chars", () => {
        const hostile: ObservatoryEvent[] = [
            at(0, "session.started", { session_id: "ses_\u0000\u202E//evil.example/a.png" }),
            at(10, "agent.spawned", {
                agent_id: "url(https://evil.example/bg.png) @import 'x'",
                attributes: { role: "see //evil.example/track.gif", task_hash: "url(//evil.example/t)" },
            }),
            at(20, "agent.spawned", {
                agent_id: "agt_2",
                attributes: { parent: "url(https://evil.example/bg.png) @import 'x'", task_hash: "url(//evil.example/t)" },
            }),
            at(30, "tool.called", {
                agent_id: "agt_2",
                attributes: { tool: "search", args: "[redacted]" },
            }),
        ];
        const report = buildReport({
            events: hostile,
            generatedAt: GENERATED_AT,
            title: "Report //evil.example/x url(https://evil.example/y) @import \u0000\u0007\u202E",
        });
        const html = renderHtml(report);
        expect(externalReferences(html)).toEqual([]);
        expect(hasUnsafeControl(html)).toBe(false);
        // Local fragment arrow marker stays intact.
        expect(html).toContain('marker-end="url(#topo-arrow)"');
    });

    it("rejects CSS injection in resolveColor while preserving valid colors", () => {
        expect(resolveColor("var(--color-primary, #3B82F6)")).toBe("#3B82F6");
        expect(resolveColor("var(--x, rgb(10, 20, 30))")).toBe("rgb(10, 20, 30)");
        expect(resolveColor("rgba(255, 0, 128, 0.5)")).toBe("rgba(255, 0, 128, 0.5)");
        expect(resolveColor("var(--x, red; background-image: url(https://evil.example))")).toBe("#94A3B8");
        expect(resolveColor("red; position:fixed")).toBe("#94A3B8");
        expect(resolveColor("url(https://evil.example/x.png)")).toBe("#94A3B8");
        expect(resolveColor("expression(alert(1))")).toBe("#94A3B8");
        expect(resolveColor("rgb(1 // 2)")).toBe("#94A3B8");
    });

    it("bounds timelineColumns, maxFindings, NaN values, and invalid severity/cls cleanly", () => {
        const events = fixtureEvents();
        const report = buildReport({ events, generatedAt: new Date(NaN), timelineColumns: 1e9 });
        expect(report.timeline.width).toBe(2048);
        expect(() => Date.parse(report.generatedAt)).not.toThrow();
        expect(Number.isNaN(Date.parse(report.generatedAt))).toBe(false);

        report.source.durationS = Number.NaN;
        report.timeline.durationS = Number.POSITIVE_INFINITY;
        report.findings[0]!.startRelS = Number.NaN;
        (report.findings[0] as { severity: string }).severity = 'critical" onclick="alert(1)';

        const html = renderHtml(report, { maxFindings: 1, maxEvidencePerFinding: Number.NaN });
        expect(html).not.toContain("NaN s");
        expect(html).not.toContain("Infinity s");
        expect(html).not.toContain('onclick="');
        expect(html).toContain('class="finding info"');
        expect(html).toContain(`…and ${report.findings.length - 1} more findings`);
    });
});

describe("Markdown export hardening", () => {
    it("prevents table breakout, </details> injection, autolinks, and control chars in code() and mdEscape()", () => {
        const report = buildReport({ events: fixtureEvents(), generatedAt: GENERATED_AT });
        report.title = "Report <script>alert(1)</script>";
        report.source.sessionIds = ["ses\n</details>\nfake_line\u202E"];
        report.generatedAt = "2026-09-26T12:00:00Z</sub><img src=x>";
        (report.findings[0] as { kind: string }).kind = "kind|break\n|row|";
        (report.findings[0] as { severity: string }).severity = "toString";
        report.findings[0]!.id = "f1\n</details>\ninjected";
        report.findings[0]!.evidence[0]!.eventId = "evt\r\n</details>\rbad";

        const md = renderMarkdown(report);
        // Prototype key "toString" must not render native function source.
        expect(md).not.toContain("[native code]");
        expect(md).toContain("| toString |");
        // Pipe inside table code span is escaped; no raw newlines inside table cells or code spans.
        expect(md).toContain("`kind\\|break \\|row\\|`");
        expect(md).toContain("**Session** `ses </details> fake_line`");
        // No unescaped HTML tags in non-code contexts or injected </details> block lines.
        expect(md).not.toContain("<script>");
        expect(md).not.toContain("<img src=x>");
        const detailsOpens = (md.match(/^<details\b/gm) ?? []).length;
        const detailsCloses = (md.match(/^<\/details>/gm) ?? []).length;
        expect(detailsOpens).toBe(1);
        expect(detailsCloses).toBe(1);
        expect(hasUnsafeControl(md)).toBe(false);
    });

    it("breaks bare URL autolinks, escapes strikethrough, flattens bare CR, and handles edge budgets", () => {
        expect(mdEscape("https://evil.example ~~strike~~\rnext\u0000\u202E")).toBe("https\\://evil.example \\~\\~strike\\~\\~ next");
        expect(clip("hello", 0)).toBe("");
        expect(clip("hello", -5)).toBe("");
        expect(clip("hello", Number.NaN)).toBe("");

        const report = buildReport({ events: fixtureEvents(), generatedAt: GENERATED_AT });
        expect(renderMarkdown(report, { maxChars: 0 })).toBe("");
        const nanBudget = renderMarkdown(report, { maxChars: Number.NaN });
        expect(nanBudget.length).toBeGreaterThan(0);
        expect(nanBudget.length).toBeLessThanOrEqual(65_536);
    });
});

describe("sensitivity & secret redaction hardening", () => {
    it("catches spoofed [redacted] and sha256: prefixes while accepting genuine markers", () => {
        expect(assessExportSensitivity([at(1, "tool.called", { attributes: { args: "[redacted]" } })]).sensitive).toBe(false);
        expect(assessExportSensitivity([at(1, "tool.called", { attributes: { args: "[redacted: pii]" } })]).sensitive).toBe(false);
        expect(
            assessExportSensitivity([
                at(1, "tool.called", { attributes: { args: "sha256:0123456789abcdef0123456789abcdef" } }),
            ]).sensitive,
        ).toBe(false);

        // Prefix spoofing with trailing payload must be flagged!
        expect(assessExportSensitivity([at(1, "tool.called", { attributes: { args: "[redacted] cat ~/.ssh/id_rsa" } })]).toolPayloads).toBe(true);
        expect(assessExportSensitivity([at(1, "tool.called", { attributes: { args: "[redacted" } })]).toolPayloads).toBe(true);
        expect(assessExportSensitivity([at(1, "request.started", { attributes: { prompt: "sha256: not a real hash secret" } })]).fullText).toBe(true);
        expect(assessExportSensitivity([at(1, "request.started", { attributes: { prompt: "sha256:short" } })]).fullText).toBe(true);
    });

    it("detects nested plaintext, nested tool payloads, tool_calls arrays, and boolean text_capture", () => {
        expect(
            assessExportSensitivity([at(1, "request.started", { attributes: { request: { system_prompt: "secret instructions" } } })]).fullText,
        ).toBe(true);
        expect(
            assessExportSensitivity([at(1, "tool.called", { attributes: { call: { arguments: "{\"path\":\"/etc/passwd\"}" } } })]).toolPayloads,
        ).toBe(true);
        expect(
            assessExportSensitivity([
                at(1, "request.completed", { attributes: { tool_calls: [{ name: "bash", arguments: "id" }] } }),
            ]).toolPayloads,
        ).toBe(true);
        // Numeric tool_calls counter is structural, not a payload.
        expect(assessExportSensitivity([at(1, "request.completed", { attributes: { tool_calls: 2 } })]).sensitive).toBe(false);
        expect(assessExportSensitivity([at(0, "session.started", { attributes: { text_capture: true } })]).fullText).toBe(true);
        expect(assessExportSensitivity([at(0, "session.started", { attributes: { capture_policy: "full" } })]).fullText).toBe(true);
    });

    it("detects secret keys and credential patterns anywhere in attributes and reports them in warnings", () => {
        const secretCases: Record<string, unknown>[] = [
            { headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456" } },
            { api_key: "secret-key-value" },
            { nested: { "x-api-key": "top-secret" } },
            { error: "upstream rejected Bearer real_bearer_token_987654321" },
            { note: "leaked key sk-proj-abcdefghijklmnopqrstuvwxyz123456" },
            { detail: "token ghp_1234567890abcdefghijklmnopqrstuv" },
            { pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIE..." },
            { url: "https://alice:s3cr3tpass@internal.example/api" },
        ];
        for (const attrs of secretCases) {
            const res = assessExportSensitivity([at(1, "backend.error", { attributes: attrs })]);
            expect(res.secrets, JSON.stringify(attrs)).toBe(true);
            expect(res.sensitive, JSON.stringify(attrs)).toBe(true);
            expect(res.secretEvents).toBe(1);
            const warn = sensitiveExportWarning(res);
            expect(warn.items.some((item) => /credential|token|secret/i.test(item))).toBe(true);
        }
        // Redacted secret keys stay non-sensitive.
        expect(assessExportSensitivity([at(1, "backend.error", { attributes: { api_key: "[redacted]" } })]).sensitive).toBe(false);
    });

    it("produces zero false positives on clean synthetic and real Sonder-Inference fixtures", () => {
        expect(assessExportSensitivity(fixtureEvents()).sensitive).toBe(false);
        for (const name of [
            "sonder-inference-912503a.jsonl",
            "sonder-inference-b2170c0.jsonl",
            "sonder-inference-cache-spec.jsonl",
            "sonder-inference-gpu.jsonl",
        ]) {
            expect(assessExportSensitivity(readJsonlFixture(name)).sensitive, name).toBe(false);
        }
    });
});

describe("filter, save, and sobs edge cases", () => {
    it("treats NaN time bounds as unbounded instead of dropping all events or emitting NaN", () => {
        const events = fixtureEvents();
        expect(filterEvents(events, { fromNs: Number.NaN, toNs: Number.NaN })).toBe(events);
        expect(describeRange({ fromNs: Number.NaN, toNs: Number.POSITIVE_INFINITY }, Number.NaN)).toBe("full session");
        expect(describeRange({ cls: "error", fromNs: Number.NaN }, 0)).toBe("class=error");
    });

    it("sanitizes punctuation-only session ids, invalid dates, and revokes blob URL on click failure", () => {
        expect(suggestedFileName("html", "   ", GENERATED_AT)).toBe("observatory-session-2026-09-26T12-00-00Z-report.html");
        expect(suggestedFileName("json", "///...", GENERATED_AT)).toBe("observatory-session-2026-09-26T12-00-00Z-findings.json");
        expect(() => suggestedFileName("sobs", "ses_1", new Date(NaN))).not.toThrow();

        const revoked: string[] = [];
        const host: DownloadHost = {
            createObjectURL: () => "blob:test/99",
            revokeObjectURL: (u) => revoked.push(u),
            clickDownload: () => {
                throw new Error("blocked popup");
            },
            setTimeout: () => undefined,
        };
        expect(() => downloadText("a.html", "<p/>", "html", host)).toThrow("blocked popup");
        expect(revoked).toEqual(["blob:test/99"]);

        const sobs = renderSobs(fixtureEvents().slice(0, 5), {}, new Date(NaN));
        expect(loadRecording(sobs).rejected).toEqual([]);
    });
});

describe("Wave 2 fields in HTML, Markdown, and JSON exports", () => {
    function wave2Events(): ObservatoryEvent[] {
        const rt = { name: "sonder-runtime", version: "0.9.0", node_id: "workstation", instance_id: "rt-1", role: "runtime", synthetic: true };
        const inf = { name: "sonder-inference", version: "0.4.0", node_id: "node1", instance_id: "inf-1", role: "inference", synthetic: true };
        return [
            at(0, "session.started", { producer: rt, attributes: { text_capture: "none" } }),
            // Execution route + chat request
            at(10, "route.selected", {
                producer: rt,
                request_id: "req-ens",
                attributes: {
                    execution_route: {
                        mode: "ensemble",
                        band: "hard",
                        difficulty_score: 0.82,
                        recommended_tiers: ["code", "reasoning"],
                        auto_selected: true,
                    },
                },
            }),
            at(20, "request.started", { producer: rt, request_id: "req-ens", attributes: { kind: "chat" } }),
            at(220, "request.completed", { producer: rt, request_id: "req-ens", attributes: { total_ms: 200 } }),
            // Orchestration (fanout)
            at(300, "fanout.started", { producer: rt, request_id: "req-fan", attributes: { fanout_scope: "local", worker_count: 2 } }),
            at(350, "fanout.worker.completed", { producer: rt, request_id: "req-fan" }),
            at(500, "fanout.completed", { producer: rt, request_id: "req-fan", attributes: { total_ms: 200 } }),
            // Embedding request (queued -> completed without request.started)
            at(600, "request.queued", { producer: inf, request_id: "req-emb", attributes: { kind: "embed" } }),
            at(640, "request.completed", { producer: inf, request_id: "req-emb", attributes: { kind: "embed", total_ms: 40 } }),
            // Hybrid discrete + integrated UMA GPU samples on node1
            at(700, "device.memory.sample", {
                producer: inf,
                device_id: "gpu:0",
                attributes: {
                    kind: "gpu",
                    name: "AMD Radeon RX 9060 XT",
                    vendor: "AMD",
                    is_integrated_uma: false,
                    dedicated_total_bytes: 16 * GIB,
                    dedicated_free_bytes: 4 * GIB,
                    carrying_model_weights: true,
                },
            }),
            at(705, "device.memory.sample", {
                producer: inf,
                device_id: "gpu:1",
                attributes: {
                    kind: "gpu",
                    name: "AMD Radeon 780M Graphics",
                    vendor: "AMD",
                    is_integrated_uma: true,
                    dedicated_total_bytes: 512 * MIB,
                    shared_total_bytes: 16 * GIB,
                    effective_vram_mib: 16_384,
                    effective_free_vram_mib: 8_192,
                    carrying_model_weights: true,
                },
            }),
            at(710, "backend.gpu_memory.sample", {
                producer: inf,
                attributes: {
                    backend: "llamaserver",
                    status: "ok",
                    samples: 5,
                    dedicated_bytes: 12 * GIB,
                    shared_bytes: 8 * GIB,
                    spill_threshold_bytes: 256 * MIB,
                    shared_baseline_bytes: 64 * MIB,
                    spilled: false,
                    fitted_ctx: 65536,
                },
            }),
        ];
    }

    it("surfaces execution_route, orchestration, embedding, and hybrid UMA GPU summaries in JSON, HTML, and Markdown", () => {
        const report = buildReport({ events: wave2Events(), generatedAt: GENERATED_AT });
        expect(report.gpu).toBeDefined();
        expect(report.gpu!.nodes).toHaveLength(1);
        expect(report.gpu!.nodes[0]!.devices).toHaveLength(2);
        expect(report.gpu!.nodes[0]!.combinedPool?.isHybridDiscreteUma).toBe(true);
        expect(report.gpu!.backends).toHaveLength(1);
        expect(report.gpu!.backends[0]!.fittedCtx).toBe(65536);

        // JSON export carries Wave 2 metrics + bounded GPU summary (no raw sample arrays).
        const parsed = JSON.parse(renderJson(report)) as JsonExport;
        expect(parsed.metrics.executionRoutes.total).toBeGreaterThanOrEqual(2);
        expect(parsed.metrics.orchestration.fanout.completed).toBe(1);
        expect(parsed.gpu?.nodes[0]?.combinedPool?.isHybridDiscreteUma).toBe(true);
        expect("samples" in (parsed.gpu!.nodes[0]!.devices[0] as unknown as Record<string, unknown>)).toBe(false);

        // Metric rows include all Wave 2 rows.
        const rows = metricRows(report.metrics, report.gpu);
        const labels = rows.map((r) => r.label);
        expect(labels).toContain("Embedding requests");
        expect(labels).toContain("Execution routes");
        expect(labels).toContain("Orchestration");
        expect(labels).toContain("GPU / UMA memory");

        // HTML report renders GPU & UMA section cleanly with no external refs.
        const html = renderHtml(report);
        expect(html).toContain("GPU &amp; UMA memory");
        expect(html).toContain("AMD Radeon RX 9060 XT");
        expect(html).toContain("AMD Radeon 780M Graphics");
        expect(html).toContain("integrated UMA");
        expect(html).toContain("hybrid discrete + UMA pool");
        expect(html).toContain("Execution routes");
        expect(html).toContain("Orchestration");
        expect(externalReferences(html)).toEqual([]);

        // Markdown report renders Wave 2 rows and GPU & UMA table cleanly.
        const md = renderMarkdown(report);
        expect(md).toContain("### GPU & UMA memory");
        expect(md).toContain("AMD Radeon 780M Graphics");
        expect(md).toContain("hybrid discrete + UMA pool");
        expect(md).toContain("| Execution routes |");
        expect(md).toContain("| Orchestration |");
        expect(md).toContain("| Embedding requests |");
    });

    it("omits gpu key on legacy JSON exports without GPU/UMA telemetry", () => {
        const parsed = JSON.parse(renderExport("json", { events: fixtureEvents(), generatedAt: GENERATED_AT }).content) as JsonExport;
        expect("gpu" in parsed).toBe(false);
    });
});
