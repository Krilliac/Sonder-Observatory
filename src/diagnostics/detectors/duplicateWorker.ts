import type { ObservatoryEvent } from "../../protocol/events";
import type { Detector, Finding } from "../types";
import { makeFinding, str } from "../util";

function taskKey(e: ObservatoryEvent, keys: readonly string[]): string | null {
    const attr = str(e, ...keys);
    if (attr) {
        return attr;
    }
    return e.task_id ?? null;
}

/**
 * Duplicate workers.
 *
 * - `guard.duplicate_work` events are restated as producer-reported findings.
 * - An `agent.spawned` whose task identity (first of
 *   `duplicateWorker.taskKeys` attributes, else envelope task_id) matches an
 *   agent that is still active (no agent.completed / agent.cancelled yet) is a
 *   duplicate. All spawns in one overlap cluster form one finding. Spawns
 *   without a task identity are never compared.
 */
export const detectDuplicateWorkers: Detector = (events, config) => {
    const findings: Finding[] = [];
    const keys = config.duplicateWorker.taskKeys;

    for (const e of events) {
        if (e.event_type === "guard.duplicate_work") {
            findings.push(makeFinding("duplicate-worker", "warning", [e], "Producer guard reported duplicate work.", {}, "producer-reported"));
        }
    }

    const active = new Map<string, Map<string, ObservatoryEvent>>(); // task -> agent -> spawn
    const agentTask = new Map<string, string>();
    const clusters = new Map<string, ObservatoryEvent[]>(); // task -> open cluster

    const close = (task: string) => {
        const cluster = clusters.get(task);
        if (cluster && cluster.length > 1) {
            const agents = [...new Set(cluster.filter((c) => c.event_type === "agent.spawned").map((c) => c.agent_id))];
            findings.push(
                makeFinding(
                    "duplicate-worker",
                    agents.length >= 3 ? "critical" : "warning",
                    cluster,
                    `${agents.length} agents were active concurrently for the same task "${task}": ${agents.join(", ")}.`,
                    { task, agents: agents.length },
                ),
            );
        }
        clusters.delete(task);
    };

    for (const e of events) {
        const agent = e.agent_id;
        if (!agent) {
            continue;
        }
        if (e.event_type === "agent.spawned") {
            const task = taskKey(e, keys);
            if (!task) {
                continue;
            }
            agentTask.set(agent, task);
            const running = active.get(task) ?? new Map<string, ObservatoryEvent>();
            if (running.size > 0 && !running.has(agent)) {
                const cluster = clusters.get(task) ?? [...running.values()];
                cluster.push(e);
                clusters.set(task, cluster);
            }
            running.set(agent, e);
            active.set(task, running);
        } else if (e.event_type === "agent.completed" || e.event_type === "agent.cancelled") {
            const task = agentTask.get(agent);
            if (!task) {
                continue;
            }
            const running = active.get(task);
            running?.delete(agent);
            const cluster = clusters.get(task);
            if (cluster) {
                cluster.push(e);
            }
            if (!running || running.size === 0) {
                close(task);
            }
        }
    }
    for (const task of [...clusters.keys()]) {
        close(task);
    }
    return findings;
};
