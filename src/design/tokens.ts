/**
 * Resolves design/tokens.json (Design Tokens Community Group format) into
 * CSS custom properties. Aliases such as "{color.primary}" are followed.
 *
 * The base groups are the dark theme. `themes.<name>` holds per-theme
 * overrides (colours only today); `themeTokens` merges them over the base
 * so aliases resolve against the theme's own values. `tokensToCss` emits
 * both palettes as one stylesheet keyed on `<html data-theme>`: it is
 * injected as a `<style>` element (main.ts), not as inline styles, because
 * inline custom properties on <html> would beat every `[data-theme]` rule.
 */
export interface TokenLeaf {
    $value: string;
    $type?: string;
}

type TokenTree = { [key: string]: TokenTree | TokenLeaf | string };

/** Group holding per-theme overrides; never emitted as variables itself. */
export const THEMES_GROUP = "themes";
export const THEME_NAMES = ["dark", "light"] as const;
export type ThemeName = (typeof THEME_NAMES)[number];
/** The theme the base token groups describe. */
export const BASE_THEME: ThemeName = "dark";

function isLeaf(node: unknown): node is TokenLeaf {
    return typeof node === "object" && node !== null && "$value" in node;
}

function isGroup(node: unknown): node is TokenTree {
    return typeof node === "object" && node !== null && !isLeaf(node);
}

function lookup(tree: TokenTree, path: string): unknown {
    let node: unknown = tree;
    for (const part of path.split(".")) {
        if (typeof node !== "object" || node === null) {
            return undefined;
        }
        node = (node as Record<string, unknown>)[part];
    }
    return node;
}

export function resolveTokenValue(tree: TokenTree, value: string, depth = 0): string {
    const alias = /^\{([^}]+)\}$/.exec(value);
    if (!alias) {
        return value;
    }
    if (depth > 16) {
        throw new Error(`token alias cycle at ${value}`);
    }
    const target = lookup(tree, alias[1]!);
    if (!isLeaf(target)) {
        throw new Error(`unresolved token alias ${value}`);
    }
    return resolveTokenValue(tree, target.$value, depth + 1);
}

/** Flattens token groups into `--group-name: value` pairs (theme overrides excluded). */
export function tokensToCssVariables(input: object): Record<string, string> {
    const tree = input as TokenTree;
    const out: Record<string, string> = {};
    const walk = (node: TokenTree, prefix: string[]): void => {
        for (const [key, child] of Object.entries(node)) {
            if (key.startsWith("$") || typeof child === "string") {
                continue;
            }
            if (prefix.length === 0 && key === THEMES_GROUP) {
                continue;
            }
            if (isLeaf(child)) {
                out[`--${[...prefix, key].join("-")}`] = resolveTokenValue(tree, child.$value);
            } else {
                walk(child, [...prefix, key]);
            }
        }
    };
    walk(tree, []);
    return out;
}

function mergeTrees(base: TokenTree, override: TokenTree): TokenTree {
    const out: TokenTree = { ...base };
    for (const [key, value] of Object.entries(override)) {
        const current = out[key];
        out[key] = isGroup(current) && isGroup(value) ? mergeTrees(current, value) : value;
    }
    return out;
}

/** The token tree for one theme: the base groups with that theme's overrides applied. */
export function themeTokens(input: object, theme: ThemeName): TokenTree {
    const tree = input as TokenTree;
    const base: TokenTree = { ...tree };
    const themes = base[THEMES_GROUP];
    delete base[THEMES_GROUP];
    if (theme === BASE_THEME) {
        return base;
    }
    const override = isGroup(themes) ? themes[theme] : undefined;
    if (!isGroup(override)) {
        throw new Error(`design tokens have no "${THEMES_GROUP}.${theme}" group`);
    }
    return mergeTrees(base, override);
}

/** CSS custom properties of one theme (aliases resolved against that theme). */
export function themeVariables(input: object, theme: ThemeName): Record<string, string> {
    return tokensToCssVariables(themeTokens(input, theme));
}

function block(selector: string, scheme: ThemeName, vars: Record<string, string>): string {
    const lines = Object.entries(vars).map(([name, value]) => `    ${name}: ${value};`);
    return `${selector} {\n    color-scheme: ${scheme};\n${lines.join("\n")}${lines.length > 0 ? "\n" : ""}}`;
}

/**
 * One stylesheet with every theme: `:root` carries the base (dark) theme,
 * `:root[data-theme="<name>"]` the variables that differ for each other
 * theme. Only values from design/tokens.json are emitted.
 */
export function tokensToCss(input: object): string {
    const base = themeVariables(input, BASE_THEME);
    const parts = [block(":root", BASE_THEME, base), block(`:root[data-theme="${BASE_THEME}"]`, BASE_THEME, {})];
    for (const theme of THEME_NAMES) {
        if (theme === BASE_THEME) {
            continue;
        }
        const vars = themeVariables(input, theme);
        const changed = Object.fromEntries(Object.entries(vars).filter(([name, value]) => base[name] !== value));
        parts.push(block(`:root[data-theme="${theme}"]`, theme, changed));
    }
    return `${parts.join("\n")}\n`;
}

function channel(hex: string, offset: number): number {
    const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of a #RRGGBB colour. */
export function relativeLuminance(hex: string): number {
    const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) {
        throw new Error(`not a #RRGGBB colour: ${hex}`);
    }
    const h = m[1]!;
    return 0.2126 * channel(h, 0) + 0.7152 * channel(h, 2) + 0.0722 * channel(h, 4);
}

/** WCAG 2.x contrast ratio between two #RRGGBB colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
