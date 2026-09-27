/**
 * Header brand mark: the app icon (src-tauri/icons/app-icon.svg, also the
 * inline favicon in index.html) as inline SVG. Gradient ids are prefixed so
 * they cannot clash with other inline SVGs on the page.
 */
import iconSource from "../../src-tauri/icons/app-icon.svg?raw";

export function brandSvgMarkup(source: string = iconSource): string {
    return source
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/id="([^"]+)"/g, 'id="brand-$1"')
        .replace(/url\(#([^)]+)\)/g, "url(#brand-$1)")
        .replace(/width="1024" height="1024"/, 'width="28" height="28" aria-hidden="true" focusable="false"')
        .trim();
}

export function brandMark(doc: Document = document): HTMLElement {
    const span = doc.createElement("span");
    span.className = "brand-mark";
    span.innerHTML = brandSvgMarkup();
    return span;
}
