# Topology (Milestone 2 — Sonder topology)

Evidence-grounded agent graph derived from the orchestration events in the
telemetry stream. No dependencies; plain TypeScript + DOM/SVG.

| File | Role |
|---|---|
| `model.ts` | Graph types: nodes (agent, model, tool, memory), edges (delegation, route, route_change, context_transfer, message, tool_call, memory_retrieval, retry, recovery), diagnostics. |
| `derive.ts` | Pure `deriveTopology(events, { atMonoNs })`: dedupes and orders events with `replay/order`, folds them into the graph as of the replay cursor. |
| `layout.ts` | Deterministic layered layout (agents by delegation depth, then models, tools, memory). |
| `scene.ts` | DOM-free visual encoding and legend (shape = kind, badge + dash = status, width = tokens/count, opacity = recency). |
| `view.ts` | `TopologyPanel`: SVG graph, legend, selection evidence list, diagnostics list, keyboard selection. |
| `fixtures/topology-synthetic.ts` | **Synthetic** orchestration events covering paths the M1 fixture lacks. Not model telemetry. |

Grounding rules:

- Every node and edge carries `evidence` (event ids, replay order); never empty.
- An entity exists only if an event names it. Events lacking a required id
  (for example `tool.completed` with an unknown call id and no tool name) are
  listed in `unmappedEventIds` rather than guessed.
- Attribute conventions read by the derivation are documented at the top of
  `derive.ts`; they match the M1 synthetic fixture (`attributes.parent`,
  `attributes.tool`, `attributes.tool_call_id`) and accept common aliases.
  They are provisional until the protocol owners define per-event payloads.

Tests: `tests/topology/`.
