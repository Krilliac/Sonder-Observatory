/**
 * Keyboard- and pointer-resizable splitter between the view content and the
 * inspector (WAI-ARIA window splitter: role=separator with aria-valuenow).
 * Left/Right move it by 5 points, Home/End jump to the limits. The position
 * is a per-viewer convenience kept in localStorage (try/catch; it still works
 * without storage).
 */
export const SPLIT_MIN = 35;
export const SPLIT_MAX = 80;
export const SPLIT_DEFAULT = 64;
export const SPLIT_STEP = 5;
export const SPLIT_STORAGE_KEY = "sonder-observatory.split";

export function clampSplit(value: number): number {
    if (!Number.isFinite(value)) {
        return SPLIT_DEFAULT;
    }
    return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Math.round(value)));
}

/** New position for a key press, or null when the key does not move the splitter. */
export function splitForKey(key: string, current: number): number | null {
    switch (key) {
        case "ArrowLeft":
        case "ArrowDown":
            return clampSplit(current - SPLIT_STEP);
        case "ArrowRight":
        case "ArrowUp":
            return clampSplit(current + SPLIT_STEP);
        case "Home":
            return SPLIT_MIN;
        case "End":
            return SPLIT_MAX;
        default:
            return null;
    }
}

export function readSplit(storage: Storage | null): number {
    try {
        const raw = storage?.getItem(SPLIT_STORAGE_KEY);
        return raw ? clampSplit(Number(raw)) : SPLIT_DEFAULT;
    } catch {
        return SPLIT_DEFAULT;
    }
}

export function writeSplit(storage: Storage | null, value: number): void {
    try {
        storage?.setItem(SPLIT_STORAGE_KEY, String(value));
    } catch {
        // Not persisted; the position still applies to this page.
    }
}

/**
 * Wires `handle` (the separator) to set `--split` (percent of the main
 * column) on `container`.
 */
export function mountSplitter(container: HTMLElement, handle: HTMLElement, storage: Storage | null): void {
    let value = readSplit(storage);
    const apply = (next: number, persist: boolean) => {
        value = clampSplit(next);
        container.style.setProperty("--split", `${value}%`);
        handle.setAttribute("aria-valuenow", String(value));
        handle.setAttribute("aria-valuetext", `event views ${value}%, inspector ${100 - value}%`);
        if (persist) {
            writeSplit(storage, value);
        }
    };
    handle.setAttribute("aria-valuemin", String(SPLIT_MIN));
    handle.setAttribute("aria-valuemax", String(SPLIT_MAX));
    apply(value, false);
    handle.addEventListener("keydown", (ev) => {
        const next = splitForKey(ev.key, value);
        if (next !== null) {
            ev.preventDefault();
            apply(next, true);
        }
    });
    handle.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        handle.setPointerCapture(ev.pointerId);
        const move = (e: PointerEvent) => {
            const rect = container.getBoundingClientRect();
            if (rect.width > 0) {
                apply(((e.clientX - rect.left) / rect.width) * 100, false);
            }
        };
        const up = () => {
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", up);
            handle.removeEventListener("pointercancel", up);
            writeSplit(storage, value);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
    });
}
