import type { ObservatoryEvent } from "../../protocol/events";
import { createIdentityKeys } from "../../query/identity";
import type { Detector, Finding } from "../types";
import { makeFinding, str } from "../util";

function taskKey(e: ObservatoryEvent, keys: readonly string[]): string | null {
    const attr = str(e, ...keys);
    if (attr && attr.trim().length > 0) {
        return attr;
    }
    return e.task_id && e.task_id.trim().length > 0 ? e.task_id : null;
}

const TERMINAL_AGENT_EVENTS = new Set(["agent.completed", "agent.cancelled", "agent.failed"]);

/**
 * Duplicate workers.
 *
 * - `guard.duplicate_work` events are restated as producer-reported findings.
 * - An `agent.spawned` whose task identity (first of
 *   `duplicateWorker.taskKeys` attributes, else envelope task_id) matches an
 *   agent that is still active (no agent.completed / agent.cancelled /
 *   agent.failed yet) in the same producer stream & session is a duplicate.
 *   All spawns in one overlap cluster form one finding. Spawns without a task
 *   identity are never compared.
 */
export const detectDuplicateWorkers: Detector = (events, config) => {
    const findings: Finding[] = [];
    const keys = config.duplicateWorker.taskKeys;
    const idKeys = createIdentityKeys();

    for (const e of events) {
        if (e.event_type === "guard.duplicate_work") {
            findings.push(makeFinding("duplicate-worker", "warning", [e], "Producer guard reported duplicate work.", {}, "producer-reported"));
        }
    }

    const active = new Map<string, Map<string, ObservatoryEvent>>(); // scopedTask -> agent -> spawn
    const taskLabel = new Map<string, string>(); // scopedTask -> raw task string
    const agentTask = new Map<string, string>(); // scopedAgent -> scopedTask
    const clusters = new Map<string, ObservatoryEvent[]>(); // scopedTask -> open cluster

    const close = (scopedTask: string) => {
        const cluster = clusters.get(scopedTask);
        if (cluster && cluster.length > 1) {
            const task = taskLabel.get(scopedTask) ?? scopedTask;
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
        clusters.delete(scopedTask);
    };

    const detachAgentFromTask = (scopedTask: string, agent: string, terminalEvent?: ObservatoryEvent) => {
        const running = active.get(scopedTask);
        running?.delete(agent);
        const cluster = clusters.get(scopedTask);
        if (cluster && terminalEvent) {
            cluster.push(terminalEvent);
        }
        if (!running || running.size === 0) {
            active.delete(scopedTask);
            close(scopedTask);
        }
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
            const scope = `${idKeys.stream(e)}\0${e.session_id}`;
            const scopedAgent = `${scope}\0${agent}`;
            const scopedTask = `${scope}\0${task}`;
            const prevTask = agentTask.get(scopedAgent);
            if (prevTask && prevTask !== scopedTask) {
                detachAgentFromTask(prevTask, agent);
            }
            agentTask.set(scopedAgent, scopedTask);
            taskLabel.set(scopedTask, task);
            const running = active.get(scopedTask) ?? new Map<string, ObservatoryEvent>();
            if (running.size > 0 && !running.has(agent)) {
                const cluster = clusters.get(scopedTask) ?? [...running.values()];
                cluster.push(e);
                clusters.set(scopedTask, cluster);
            }
            running.set(agent, e);
            active.set(scopedTask, running);
        } else if (TERMINAL_AGENT_EVENTS.has(e.event_type)) {
            const scope = `${idKeys.stream(e)}\0${e.session_id}`;
            const scopedAgent = `${scope}\0${agent}`;
            const scopedTask = agentTask.get(scopedAgent);
            if (!scopedTask) {
                continue;
            }
            agentTask.delete(scopedAgent);
            detachAgentFromTask(scopedTask, agent, e);
        }
    }
    for (const scopedTask of [...clusters.keys()]) {
        close(scopedTask);
    }
    return findings;
};
