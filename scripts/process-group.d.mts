export function groupAlive(pgid: number, options?: {
    platform?: string;
    kill?: (pid: number, signal: number) => unknown;
    processes?: () => { pid?: number; group: number; state: string }[] | null;
}): boolean;
