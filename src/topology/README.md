# Topology (Milestone 2 — Sonder topology)

Evidence-grounded agent graph derived from the orchestration events in the
telemetry stream. No dependencies; plain TypeScript + DOM/SVG.

| File | Role |
|---|---|
| `model.ts` | Graph types: nodes (agent, model, tool, memory), edges (delegation, route, route_change, context_transfer, message, tool_call, memory_retrieval, retry, recovery), diagnostics. |
| `derive.ts` | Pure `deriveTopology(events, { atMonoNs })`: dedupes and orders events with `replay/order`, folds them into the graph as of the replay cursor. |
| `layout.ts` | Deterministic layered layout (agents by delegation depth, then models, tools, memory). |
| `scene.ts` | DOM-free visual encoding and legend (shape = kind, badge + dash = status, width = tokens/count, opacity = recency). |
| `view.ts` | `TopologyPanel`: SVG graph, legend, paged selection evidence and diagnostics lists, keyboard selection. |
| `pagination.ts` | 50-row presentation windows with complete evidence retained and replay-safe page clamping. |
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

The Agents side panel mounts at most 50 selected evidence rows and 50
diagnostic rows. First/Previous/Next/Last buttons make every item reachable;
page status states the complete count. Selecting a different node or edge
resets its evidence page. Scrubbing clamps pages to the available items;
replacing the topology timeline resets both lists. In-order live appends keep
their existing page. Paging replaces only side-panel DOM and preserves focus
on an enabled control. The full graph, selection evidence callback, shared
inspector and recording/export data are unchanged. The node fact sheet lists
distinct diagnostic kinds; their individual occurrences remain in the paged
diagnostics list.

These bounds apply to side lists, not graph SVG size, recorded-event memory,
derivation cost or provider/model performance. The synthetic scale check is
`e2e/topology-pagination.spec.ts`; `TOPOLOGY_STRESS_EVENTS` accepts multiples
of 50 from 100 to 100,000. Its default is 5,000 distinct guard events on one
agent, so a constant graph isolates list DOM growth. Generated recordings and
measurements remain in ignored Playwright output.
