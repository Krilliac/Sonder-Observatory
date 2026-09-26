export function fmtMs(ms: number | null): string {
    if (ms === null) {
        return "—";
    }
    if (ms >= 1000) {
        return `${(ms / 1000).toFixed(2)} s`;
    }
    return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`;
}

export function fmtRate(rate: number | null): string {
    return rate === null ? "—" : `${rate.toFixed(1)}`;
}

export function fmtBytes(bytes: number): string {
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let v = bytes;
    let u = 0;
    while (v >= 1024 && u < units.length - 1) {
        v /= 1024;
        u += 1;
    }
    return `${v.toFixed(u === 0 ? 0 : 1)} ${units[u]}`;
}

export function fmtPct(fraction: number | null): string {
    return fraction === null ? "—" : `${(fraction * 100).toFixed(0)}%`;
}

export function fmtRelNs(ns: number): string {
    return `${(ns / 1e9).toFixed(3)} s`;
}

/** Short one-line summary of an event's attributes for the table. */
export function summarizeAttributes(attributes: Record<string, unknown>, max = 80): string {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(attributes)) {
        if (v === null || typeof v === "object") {
            continue;
        }
        parts.push(`${k}=${String(v)}`);
    }
    const s = parts.join(" ");
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
