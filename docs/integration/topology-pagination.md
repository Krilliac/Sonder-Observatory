# Agents topology side-list pagination

The existing renderer already wires `TopologyPanel`; no main.ts, dependency,
package script, schema, design-token or producer changes are needed. This
branch owns `src/topology/` plus its unit/browser qualification.

Selected evidence and retry/recovery/guard diagnostic lists mount 50 rows per
page, with complete data retained and First/Previous/Next/Last navigation.
Paging updates only the side panel. Keyboard focus stays on the corresponding
enabled control or an enabled same-list fallback. Selection changes reset the
evidence page; replay changes clamp both pages, and replacing the timeline
resets them. In-order live appends retain pages. Node facts list distinct
diagnostic kinds, while their complete occurrences remain reachable.

Continuity follows the topology index's existing verified Store-prefix signal:
an extended timeline shares its core and has a nondecreasing source length.
Wrapper identity alone does not identify a replacement, since each in-order
append creates a wrapper. The actual Store browser control holds both lists
on a later page across three appends, then checks retention and replacement
resets; it also verifies the selection callback includes all 120 evidence ids.

The existing graph, layout, selection evidence callback, inspector behavior,
capture consent, producer cursors, recording/export data and synthetic labels
remain unchanged. These bounds concern side-list DOM only; event retention,
graph SVG and topology/diagnostic derivation cost remain unbounded by this
change. No provider throughput or model-quality claim follows.

Baseline actual main `364b01b8156c0c369c7a6b7426a8dc1d99e97203`, with 5,000
distinct synthetic guard events on one agent, mounted 5,000 evidence rows and
5,000 diagnostic rows (20,016 side-panel descendant elements). The failing
bound assertion and browser report are preserved outside Git. Candidate
qualification receipts will record executed results on the final revision;
this document makes no prospective passing-test claim.

Run the targeted scale/navigation control with:

```sh
E2E_CHROMIUM_PATH=/usr/bin/chromium E2E_PORT=4197 \
  npx playwright test e2e/topology-pagination.spec.ts --workers=1 --retries=0
TOPOLOGY_STRESS_EVENTS=100000 E2E_CHROMIUM_PATH=/usr/bin/chromium E2E_PORT=4197 \
  npx playwright test e2e/topology-pagination.spec.ts --workers=1 --retries=0
```

`TOPOLOGY_STRESS_EVENTS` is validated as a multiple of 50 between 100 and
100,000. The default 5,000-event case checks independent list bounds, final
event inspection, keyboard page navigation, accessibility, replay shrink and
replacement-source clamping; a second case checks edge selection and resets.
All recordings and JSON DOM attachments remain in ignored test output.
