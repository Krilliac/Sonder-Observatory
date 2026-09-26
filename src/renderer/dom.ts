type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Record<string, string | number | boolean | undefined> = {},
    ...children: Child[]
): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === false) {
            continue;
        }
        if (key === "class") {
            el.className = String(value);
        } else if (key === "text") {
            el.textContent = String(value);
        } else {
            el.setAttribute(key, value === true ? "" : String(value));
        }
    }
    for (const child of children) {
        if (child === null || child === undefined || child === false) {
            continue;
        }
        el.append(child);
    }
    return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function svg(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
        el.setAttribute(key, String(value));
    }
    return el;
}

export function byId<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) {
        throw new Error(`missing #${id}`);
    }
    return el as T;
}
