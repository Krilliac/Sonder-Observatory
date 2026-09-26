/**
 * Resolves design/tokens.json (Design Tokens Community Group format) into
 * CSS custom properties. Aliases such as "{color.primary}" are followed.
 */
export interface TokenLeaf {
    $value: string;
    $type?: string;
}

type TokenTree = { [key: string]: TokenTree | TokenLeaf | string };

function isLeaf(node: unknown): node is TokenLeaf {
    return typeof node === "object" && node !== null && "$value" in node;
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

/** Flattens token groups into `--group-name: value` pairs. */
export function tokensToCssVariables(input: object): Record<string, string> {
    const tree = input as TokenTree;
    const out: Record<string, string> = {};
    const walk = (node: TokenTree, prefix: string[]): void => {
        for (const [key, child] of Object.entries(node)) {
            if (key.startsWith("$") || typeof child === "string") {
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
