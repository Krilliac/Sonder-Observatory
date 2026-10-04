/** Presentation bounds only: graph derivation and evidence remain complete. */
export const TOPOLOGY_PAGE_SIZE = 50;

export function topologyPage(index: number, total: number): { index: number; pages: number; start: number; end: number } {
    const pages = Math.ceil(total / TOPOLOGY_PAGE_SIZE);
    const current = Math.max(0, Math.min(Math.max(0, pages - 1), Number.isFinite(index) ? Math.trunc(index) : 0));
    const start = current * TOPOLOGY_PAGE_SIZE;
    return { index: current, pages, start, end: Math.min(total, start + TOPOLOGY_PAGE_SIZE) };
}
