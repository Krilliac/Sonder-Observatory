import { readFileSync, readdirSync } from "node:fs";

/** Read Linux process states; an unreadable census remains unknown. */
function linuxProcesses() {
    try {
        const entries = [];
        for (const pid of readdirSync("/proc")) {
            if (!/^\d+$/.test(pid)) {
                continue;
            }
            try {
                const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
                // comm may contain spaces/parentheses; fields follow its last ')'.
                const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
                const group = Number(fields[2]);
                if (!Number.isSafeInteger(group) || !fields[0]) {
                    return null;
                }
                entries.push({ pid: Number(pid), group, state: fields[0] });
            } catch (error) {
                if (error.code !== "ENOENT" && error.code !== "ESRCH") {
                    return null;
                }
            }
        }
        return entries;
    } catch {
        return null;
    }
}

/** Zombies await their parent/init reaper and cannot run or receive signals.
 * Live/stopped members, permissions errors and unknown censuses remain alive.
 * Other POSIX platforms retain the conservative kill(0) observation.
 */
export function groupAlive(pgid, {
    platform = process.platform,
    kill = process.kill.bind(process),
    processes = linuxProcesses,
} = {}) {
    try {
        kill(-pgid, 0);
    } catch (error) {
        return error.code !== "ESRCH";
    }
    if (platform !== "linux") {
        return true;
    }
    const census = processes();
    if (census === null) {
        return true;
    }
    const members = census.filter((entry) => entry.group === pgid);
    if (members.length === 0) {
        // Absence from a census is not evidence of zombie-only membership.
        try {
            kill(-pgid, 0);
            return true;
        } catch (error) {
            return error.code !== "ESRCH";
        }
    }
    if (members.some((entry) => entry.state !== "Z" && entry.state !== "X")) {
        return true;
    }
    const repeated = processes();
    // Confirm the same zombie membership twice after the supervised leader
    // exited. /proc is observational, not an atomic census during spawning.
    return repeated === null || JSON.stringify(members) !== JSON.stringify(repeated.filter((entry) => entry.group === pgid));
}
