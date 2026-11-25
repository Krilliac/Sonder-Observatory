/**
 * Overview metric cards (#cards): latency, TTFT (with steady-prefill vs reload
 * separation), token rate (with prefill vs decode separation), prompt-cache &
 * speculation reuse, execution routing badges, multi-GPU per-node VRAM &
 * spill-guard GPU cards, errors, agents/tools, resources, and telemetry.
 */
import type { ObservatoryEvent } from "../protocol/events";
import { executionRouteAt } from "../query/executionRouteIndex";
import { gpuMemoryAt, nodeGpuMemoryAt } from "../query/gpuMemoryIndex";
import type { Metrics } from "../query/metrics";
import { prefillDecodeAt } from "../query/prefillDecodeIndex";
import type { SessionStore } from "../replay/session";
import { byId, h } from "./dom";
import { fmtBytes, fmtMs, fmtPct } from "./format";
import { renderGpuCards, renderNodeGpuCards } from "./gpuCards";
import { renderPrefillDecodeSplit, renderTtftBreakdown } from "./prefillDecodeCard";
import { promptCacheCardModel, speculationCardModel, type ReuseCardModel } from "./reuseCards";
import { renderRouteCards } from "./routeBadges";
import { tokenCardModel } from "./tokenCard";

function card(title: string, value: string, sub: string, evidence: string, tone = "", extra: Node | null = null): HTMLElement {
    return h(
        "article",
        { class: `card ${tone}` },
        h("h3", { text: title }),
        h("div", { class: "value", text: value }),
        h("div", { class: "sub", text: sub }),
        extra,
        h("div", { class: "evidence", text: evidence }),
    );
}

function renderReuseCard(model: ReuseCardModel | null): HTMLElement | null {
    if (!model) {
        return null;
    }
    return card(
        model.title,
        model.value,
        model.sub,
        model.evidence,
        "",
        h(
            "div",
            { class: "reuse-breakdown" },
            model.rows.length > 0
                ? h(
                      "ul",
                      { class: "per-producer", "aria-label": `${model.title} per model` },
                      ...model.rows.map(([name, text]) => h("li", { "data-model": name }, h("span", { class: "producer-cell", text: name }), ` ${text}`)),
                  )
                : null,
            model.sessionRows.length > 0
                ? h(
                      "ul",
                      { class: "per-producer", "aria-label": `${model.title} per session` },
                      ...model.sessionRows.map(([name, text]) => h("li", { "data-session": name }, h("span", { class: "producer-cell", text: `session ${name}` }), ` ${text}`)),
                      ...(model.moreSessions > 0 ? [h("li", { text: `+${model.moreSessions} more sessions` })] : []),
                  )
                : null,
        ),
    );
}

export function renderOverviewCards(
    m: Metrics,
    events: readonly ObservatoryEvent[],
    visibleCount: number,
    store: Pick<SessionStore, "rejectedCount" | "droppedByRetention">,
): void {
    const res = m.resources;
    const tokenCard = tokenCardModel(m);
    const derived = (n: number, what: string) => (n > 0 ? `derived · ${n} ${what}` : "unavailable · no events yet");
    const errorTypes = Object.entries(m.errors.byType)
        .map(([t, n]) => `${t} ×${n}`)
        .join(", ");
    const perProducer = Object.entries(m.requestLatencyByProducer).sort(([a], [b]) => a.localeCompare(b));
    const producerRows =
        perProducer.length > 1
            ? h(
                  "ul",
                  { class: "per-producer", "aria-label": "Request latency per producer" },
                  ...perProducer.map(([name, stats]) =>
                      h(
                          "li",
                          { "data-producer": name },
                          h("span", { class: "producer-cell", text: name }),
                          ` p50 ${fmtMs(stats.p50Ms)} · p95 ${fmtMs(stats.p95Ms)} · ${stats.count} req`,
                      ),
                  ),
              )
            : null;
    // Present only when a request reported them, so other streams render as before.
    const reuseCards = [renderReuseCard(promptCacheCardModel(m)), renderReuseCard(speculationCardModel(m))].filter(
        (c): c is HTMLElement => c !== null,
    );
    const prefillDecode = prefillDecodeAt(events, visibleCount);
    const routes = executionRouteAt(events, visibleCount);
    const nodeGpus = nodeGpuMemoryAt(events, visibleCount);
    const ttftTone = prefillDecode.ttft.latestClassification === "reload" ? "tone-warning" : "";
    byId("cards").replaceChildren(
        card(
            "Request latency",
            `p50 ${fmtMs(m.requestLatency.p50Ms)}`,
            `p95 ${fmtMs(m.requestLatency.p95Ms)} · max ${fmtMs(m.requestLatency.maxMs)} · open ${m.requests.filter((r) => r.outcome === "open").length}`,
            derived(m.requestLatency.count, "finished requests (request.started → end)"),
            "",
            producerRows,
        ),
        card(
            "Time to first token",
            `p50 ${fmtMs(m.timeToFirstToken.p50Ms)}`,
            `p95 ${fmtMs(m.timeToFirstToken.p95Ms)}`,
            derived(m.timeToFirstToken.count, "requests with a first token"),
            ttftTone,
            renderTtftBreakdown(prefillDecode),
        ),
        card("Token rate", tokenCard.value, tokenCard.sub, tokenCard.evidence, "", renderPrefillDecodeSplit(prefillDecode)),
        ...reuseCards,
        ...renderRouteCards(routes),
        ...renderNodeGpuCards(nodeGpus),
        ...renderGpuCards(gpuMemoryAt(events, visibleCount)),
        card(
            "Errors",
            `${m.errors.total}`,
            errorTypes || "none",
            m.errors.total > 0 ? `derived · failed/retry/guard events` : "derived · no error events",
            m.errors.total > 0 ? "tone-error" : "tone-ok",
        ),
        card(
            "Agents & tools",
            `${m.agents.active.length} active agent(s)`,
            `spawned ${m.agents.spawned} · done ${m.agents.completed} · tools ${m.tools.called} called, ${m.tools.failed} failed, ${m.tools.active.length} running`,
            derived(m.agents.transitions, "agent/route transitions"),
        ),
        card(
            "Resource pressure",
            res.latest ? `${fmtPct(res.latest.fraction)} memory` : "—",
            res.latest
                ? `${fmtBytes(res.latest.usedBytes)} / ${fmtBytes(res.latest.totalBytes)} · peak ${fmtPct(res.peak?.fraction ?? null)} · compute ${fmtPct(res.latestComputeUtilization)} · pressure events ${res.pressureEvents}`
                : `pressure events ${res.pressureEvents}`,
            res.latest ? `producer-reported · device.memory.sample ${res.latest.deviceId ?? ""}` : "unavailable · no device samples",
            res.latest && res.latest.fraction >= 0.9 ? "tone-warning" : "",
        ),
        card(
            "Telemetry",
            `${m.eventCount} events`,
            `dropped (producer-reported) ${m.droppedEvents} · rejected ${store.rejectedCount}${store.droppedByRetention > 0 ? ` · ${store.droppedByRetention} older not retained` : ""}`,
            "measured · events received at the cursor",
            m.droppedEvents > 0 ? "tone-warning" : "",
        ),
    );
}
