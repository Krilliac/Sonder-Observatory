import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { groupAlive } from "../scripts/process-group.mjs";

describe("ecosystem process-group cleanup", () => {
    const kill = () => undefined;

    it("does not report init-owned zombie-only groups as running", () => {
        expect(groupAlive(12, { platform: "linux", kill, processes: () => [{ group: 12, state: "Z" }] })).toBe(false);
    });

    it("still reports an active or stopped descendant beside a zombie", () => {
        for (const state of ["R", "S", "T"]) {
            expect(groupAlive(12, {
                platform: "linux", kill,
                processes: () => [{ group: 12, state: "Z" }, { group: 12, state }],
            })).toBe(true);
        }
    });

    it("preserves refusal when process visibility or permission is unknown", () => {
        expect(groupAlive(12, { platform: "linux", kill, processes: () => null })).toBe(true);
        expect(groupAlive(12, { kill: () => { throw Object.assign(new Error(), { code: "EPERM" }); } })).toBe(true);
        expect(groupAlive(12, { platform: "darwin", kill })).toBe(true);
        expect(groupAlive(12, { kill: () => { throw Object.assign(new Error(), { code: "ESRCH" }); } })).toBe(false);
    });

    it("does not infer zombie-only membership from a missing or changing census", () => {
        expect(groupAlive(12, { platform: "linux", kill, processes: () => [] })).toBe(true);
        expect(groupAlive(12, { platform: "linux", kill, processes: () => [{ group: 13, state: "Z" }] })).toBe(true);
        let reads = 0;
        expect(groupAlive(12, {
            platform: "linux", kill,
            processes: () => [{ pid: ++reads, group: 12, state: "Z" }],
        })).toBe(true);
        let signals = 0;
        expect(groupAlive(12, {
            platform: "linux", processes: () => [],
            kill: () => { if (++signals === 2) throw Object.assign(new Error(), { code: "ESRCH" }); },
        })).toBe(false);
    });

    it.skipIf(process.platform === "win32")("observes a real detached child until its exit", async () => {
        const child = spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], { detached: true });
        try {
            await new Promise<void>((resolve, reject) => {
                child.stdout!.once("data", () => resolve());
                child.once("error", reject);
            });
            expect(groupAlive(child.pid!)).toBe(true);
        } finally {
            const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
            process.kill(-child.pid!, "SIGTERM");
            await exited;
        }
        expect(groupAlive(child.pid!)).toBe(false);
    });
});
