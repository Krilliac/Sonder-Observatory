import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio, resolveTokenValue, themeVariables, THEME_NAMES, tokensToCss, tokensToCssVariables } from "../src/design/tokens";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const tokens = JSON.parse(read("../design/tokens.json"));
const HEX = /^#[0-9A-F]{6}$/i;

describe("design tokens", () => {
    it("flattens design/tokens.json into CSS variables with aliases resolved", () => {
        const vars = tokensToCssVariables(tokens);
        expect(vars["--color-background"]).toBe("#070B14");
        expect(vars["--semantic-token"]).toBe(vars["--color-primary"]);
        expect(vars["--semantic-error"]).toBe("#EF4444");
        const colours = Object.entries(vars).filter(([k]) => k.startsWith("--color-") || k.startsWith("--semantic-"));
        expect(colours.length).toBeGreaterThan(20);
        expect(colours.every(([, v]) => HEX.test(v))).toBe(true);
        // Type, spacing and radius scales are emitted too; theme overrides are not variables.
        expect(vars["--font-size-md"]).toBe("14px");
        expect(vars["--space-4"]).toBe("8px");
        expect(vars["--radius-md"]).toBe("6px");
        expect(vars["--font-family-mono"]).toMatch(/monospace/);
        expect(Object.keys(vars).some((k) => k.startsWith("--themes"))).toBe(false);
    });

    it("throws on unresolved or cyclic aliases", () => {
        expect(() => resolveTokenValue({}, "{color.nope}")).toThrow(/unresolved/);
        const cyclic = { a: { $value: "{b}" }, b: { $value: "{a}" } };
        expect(() => resolveTokenValue(cyclic, "{a}")).toThrow(/cycle/);
    });

    it("the light theme overrides every colour and resolves aliases against itself", () => {
        const dark = themeVariables(tokens, "dark");
        const light = themeVariables(tokens, "light");
        expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
        const colourKeys = Object.keys(dark).filter((k) => k.startsWith("--color-"));
        for (const key of colourKeys) {
            expect(HEX.test(light[key]!), key).toBe(true);
            expect(tokens.themes.light.color[key.slice("--color-".length)], `themes.light.color overrides ${key}`).toBeDefined();
        }
        expect(light["--color-background"]).not.toBe(dark["--color-background"]);
        expect(light["--semantic-token"]).toBe(light["--color-primary"]);
        expect(light["--space-4"]).toBe(dark["--space-4"]);
    });

    it("emits one stylesheet keyed on data-theme", () => {
        const css = tokensToCss(tokens);
        expect(css.startsWith(":root {\n    color-scheme: dark;")).toBe(true);
        expect(css).toContain(':root[data-theme="dark"] {\n    color-scheme: dark;\n}');
        expect(css).toContain(':root[data-theme="light"] {\n    color-scheme: light;');
        expect(css).toContain("--color-background: #F4F6FA;");
        expect(css).toContain("--color-background: #070B14;");
        // Unchanged scales are not repeated in the light block.
        const lightBlock = css.slice(css.indexOf(':root[data-theme="light"]'));
        expect(lightBlock).not.toContain("--space-4");
        expect(() => themeVariables({ color: {} }, "light")).toThrow(/themes\.light/);
    });

    it.each(THEME_NAMES)("%s theme: text roles meet WCAG AA on every surface", (theme) => {
        const v = themeVariables(tokens, theme);
        const surfaces = ["--color-background", "--color-surface", "--color-elevated"].map((k) => v[k]!);
        for (const role of ["text", "muted", "link", "textError", "textWarning", "textSuccess"]) {
            for (const bg of surfaces) {
                expect(contrastRatio(v[`--color-${role}`]!, bg), `${theme} ${role} on ${bg}`).toBeGreaterThanOrEqual(4.5);
            }
        }
        expect(contrastRatio(v["--color-onAccent"]!, v["--color-accent"]!)).toBeGreaterThanOrEqual(4.5);
        // Focus ring and the selected-event mark are graphics: 3:1 (WCAG 1.4.11).
        expect(contrastRatio(v["--color-focus"]!, v["--color-surface"]!)).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(v["--color-markSelected"]!, v["--color-background"]!)).toBeGreaterThanOrEqual(3);
    });

    it("computes WCAG contrast ratios", () => {
        expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
        expect(contrastRatio("#777777", "#777777")).toBe(1);
        expect(() => contrastRatio("red", "#FFFFFF")).toThrow(/RRGGBB/);
    });

    it("renderer CSS uses tokens, not hardcoded colours", () => {
        for (const file of ["../src/renderer/styles.css", "../src/renderer/views.css", "../src/renderer/eventTable.css", "../src/inference3d/inference3d.css"]) {
            const css = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
            expect(css.match(/#[0-9a-f]{3,8}\b/gi) ?? [], file).toEqual([]);
            expect(css.match(/\b(?:rgba?|hsla?)\(/gi) ?? [], file).toEqual([]);
        }
    });

    it("button.link meets the WCAG 2.2 24x24 CSS px target size (2.5.8)", () => {
        const css = read("../src/renderer/styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
        const rule = /(?:^|\n)button\.link\s*\{([^}]*)\}/.exec(css);
        expect(rule, "button.link rule").not.toBeNull();
        const vars = tokensToCssVariables(tokens);
        const px = (decl: string) => {
            const m = new RegExp(`(?:^|;|\\s)${decl}:\\s*var\\((--[\\w-]+)\\)`).exec(rule![1]!);
            expect(m, `${decl} uses a token`).not.toBeNull();
            return parseFloat(vars[m![1]!]!);
        };
        expect(px("min-height")).toBeGreaterThanOrEqual(24);
        expect(px("min-width")).toBeGreaterThanOrEqual(24);
    });

    it("the favicon in index.html is the app icon (no /favicon.ico request)", () => {
        const html = read("../index.html");
        const m = /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,([^"]+)"/.exec(html);
        expect(m, "inline SVG favicon link").not.toBeNull();
        const squash = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").replace(/>\s+</g, "><").trim();
        expect(squash(decodeURIComponent(m![1]!))).toBe(squash(read("../src-tauri/icons/app-icon.svg")));
    });
});
