import { describe, expect, it } from "vitest";
import { buildReport, renderExport, renderHtml, REPORT_CSP, resolveColor } from "../../src/export";
import type { ObservatoryEvent } from "../../src/protocol/events";
import { at } from "../helpers";
import { fixtureEvents, GENERATED_AT } from "./fixture";

const events = fixtureEvents();
const html = renderExport("html", { events, generatedAt: GENERATED_AT }).content;

const VOID = new Set(["meta", "br", "hr", "img", "input", "link", "wbr"]);

/** Minimal well-formedness check: every non-void element is closed in order. */
function assertBalanced(doc: string): void {
    const body = doc.replace(/<style>[\s\S]*?<\/style>/g, "<style></style>").replace(/<!doctype html>/i, "");
    const stack: string[] = [];
    for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g)) {
        const [, closing, rawName, selfClosing] = m;
        const name = rawName!.toLowerCase();
        if (VOID.has(name) || selfClosing) {
            continue;
        }
        if (closing) {
            const open = stack.pop();
            expect(open, `</${name}> closes <${open}>`).toBe(name);
        } else {
            stack.push(name);
        }
    }
    expect(stack).toEqual([]);
}

/** Every construct that could make the browser fetch something. Attribute checks look inside tags only. */
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
            found.push(`${label}: ${hay.slice(Math.max(0, m.index - 30), m.index + 40)}`);
        }
    }
    return found;
}

describe("self-contained HTML report (fixture)", () => {
    it("is a complete, well-formed document", () => {
        expect(html.startsWith("<!doctype html>\n<html lang=\"en\">")).toBe(true);
        expect(html.trimEnd().endsWith("</html>")).toBe(true);
        expect(html).toContain('<meta charset="utf-8">');
        assertBalanced(html);
    });

    it("makes no external requests and ships only inline CSS", () => {
        expect(externalReferences(html)).toEqual([]);
        expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`);
        expect(REPORT_CSP).toContain("default-src 'none'");
        expect(html.match(/<style>/g)).toHaveLength(1);
        expect(html).not.toMatch(/<script/i);
        expect(html).not.toMatch(/\son[a-z]+\s*=/i); // no inline event handlers
        expect(html).not.toMatch(/var\(--/); // theme variables resolved to literals
    });

    it("contains the summary metrics, findings with evidence, topology SVG and timeline snapshot", () => {
        const report = buildReport({ events, generatedAt: GENERATED_AT });
        expect(html).toContain("Summary metrics");
        expect(html).toContain("Request latency p50 / p95 / max");
        for (const f of report.findings) {
            expect(html).toContain(`id="finding-${f.id}"`);
            for (const id of f.evidenceEventIds) {
                expect(html).toContain(id);
            }
        }
        expect(html).toMatch(/<svg class="topology"[^>]*role="img"/);
        expect(html.match(/<g opacity=/g)!.length).toBe(report.topology.nodes.length + report.topology.edges.length);
        expect(html).toMatch(/<svg class="timeline"[^>]*role="img"/);
        expect(html).toContain(`Timeline snapshot: ${events.length} events`);
        expect(html).not.toContain("xmlns"); // inline SVG in HTML5 needs no namespace URL
    });

    it("escapes producer-controlled text and neutralises URLs in it", () => {
        const hostile: ObservatoryEvent[] = [
            at(0, "session.started"),
            at(10, "agent.spawned", { agent_id: '<script>alert(1)</script>', attributes: { role: 'x" onload="y', label: "http://evil.example/a.png" } }),
            at(20, "tool.failed", { agent_id: "a", attributes: { tool: "<img src=https://evil.example/x>", error_type: "http://evil" } }),
            at(30, "request.failed", { request_id: "r1", attributes: { error_type: "javascript:alert(1)" } }),
            at(40, "request.failed", { request_id: "r2", attributes: { error_type: "e" } }),
            at(50, "request.failed", { request_id: "r3", attributes: { error_type: "url(https://evil.example)" } }),
        ];
        const doc = renderHtml(buildReport({ events: hostile, generatedAt: GENERATED_AT, title: "<b>t</b> https://x.example" }));
        expect(externalReferences(doc)).toEqual([]);
        expect(doc).not.toContain("<script>");
        expect(doc).not.toContain('" onload="');
        expect(doc).toContain("&lt;b&gt;t&lt;/b&gt;");
        assertBalanced(doc);
    });

    it("resolves theme colours to literal fallbacks", () => {
        expect(resolveColor("var(--color-primary, #3B82F6)")).toBe("#3B82F6");
        expect(resolveColor("#123456")).toBe("#123456");
    });

    it("renders an empty range without a topology graph", () => {
        const doc = renderHtml(buildReport({ events: [], generatedAt: GENERATED_AT }));
        expect(doc).toContain("No findings.");
        expect(doc).toContain("No orchestration events");
        expect(externalReferences(doc)).toEqual([]);
        assertBalanced(doc);
    });
});
