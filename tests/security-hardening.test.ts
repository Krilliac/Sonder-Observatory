import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import viteConfig, { BROWSER_CSP_HEADER, BROWSER_CSP_META } from "../vite.config";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("CI workflow action pinning (F3)", () => {
    it("pins every GitHub Action in .github/workflows to a 40-char commit SHA", () => {
        const workflowsDir = fileURLToPath(new URL("../.github/workflows", import.meta.url));
        const files = readdirSync(workflowsDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
        expect(files.length).toBeGreaterThanOrEqual(4);
        const unpinned: string[] = [];
        let checked = 0;
        for (const file of files) {
            const lines = read(`../.github/workflows/${file}`).split(/\r?\n/);
            lines.forEach((line, idx) => {
                const match = /^\s*-?\s*uses:\s*([^\s#]+)/.exec(line);
                if (!match) {
                    return;
                }
                const ref = match[1]!;
                if (ref.startsWith("./")) {
                    return; // local action
                }
                checked += 1;
                if (!/^[^@\s]+@[0-9a-f]{40}$/.test(ref)) {
                    unpinned.push(`${file}:${idx + 1} ${ref}`);
                }
            });
        }
        expect(checked).toBeGreaterThan(0);
        expect(unpinned).toEqual([]);
    });
});

describe("browser Content-Security-Policy (F5)", () => {
    it("sets HTTP Content-Security-Policy headers on both Vite server and preview", () => {
        const cfg = viteConfig as {
            server?: { headers?: Record<string, string> };
            preview?: { headers?: Record<string, string> };
        };
        const serverCsp = cfg.server?.headers?.["Content-Security-Policy"];
        const previewCsp = cfg.preview?.headers?.["Content-Security-Policy"];
        expect(serverCsp).toBe(BROWSER_CSP_HEADER);
        expect(previewCsp).toBe(BROWSER_CSP_HEADER);
        for (const required of [
            "default-src 'self'",
            "script-src 'self'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
            "http://127.0.0.1:*",
            "ws://127.0.0.1:*",
        ]) {
            expect(BROWSER_CSP_HEADER).toContain(required);
        }
        expect(BROWSER_CSP_HEADER).not.toMatch(/script-src[^;]*'unsafe-/);
    });

    it("ships a matching defense-in-depth meta CSP in index.html without frame-ancestors", () => {
        const html = read("../index.html");
        const match = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/>/i.exec(html);
        expect(match, "meta Content-Security-Policy in index.html").not.toBeNull();
        const metaCsp = match![1]!;
        expect(metaCsp).toBe(BROWSER_CSP_META);
        expect(metaCsp).not.toContain("frame-ancestors");
        expect(metaCsp).toContain("object-src 'none'");
        expect(metaCsp).toContain("base-uri 'none'");
        expect(metaCsp).toContain("form-action 'none'");
    });
});
