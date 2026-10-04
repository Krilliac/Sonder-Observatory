# Bounded Diagnostics finding and evidence pages

Large recordings previously mounted every derived finding in Diagnostics and
every evidence button of the selected finding. The existing event table was
already virtualized; these separate lists still grew with recording size.

The controller/panel now mount at most 50 findings and 50 selected evidence
buttons. First/Previous/Next/Last controls reach every item and report the
range and total. Paging changes presentation only: detectors, finding order,
severity counts, the full model and evidence, and exports retain their meaning.
All evidence is still highlighted when a finding is selected. Arrow navigation
spans the complete filtered list, reveals its page and keeps focus on the
selected finding. Changing findings, filter or selection resets/clamps the
appropriate boundaries. Replacement with a small recording clears stale
selection and removes unnecessary controls.

## Integration

The module changes are in controller.ts/panel.ts. The renderer diagnostics
cache stamp includes controller.revision: changing a page does not change the
selected finding, so the old selected-id-only stamp would skip the render.
Controller tests preserve counts, selection, filtered navigation and evidence
inspection while checking page reachability and replacement boundaries.
The browser spec is e2e/diagnostics-pagination.spec.ts. This document is the
integrator's moved module INTEGRATION_NOTES.md, per repository instructions.
No protocol, detector, recording/export policy, transport or dependency changed.
Producer cursors, effect recovery and rollback remain with their owners.

## Qualification and limits

Baseline actual main 9ea5f7887e4310a43d3c317dec5324f4e1c56212 was tested before
production edits. The real Chromium renderer loaded 8,000 distinct synthetic
events, derived 5,001 findings, and mounted 5,001 finding rows / 35,012 Diagnostics
DOM nodes. The desired 50-row bound failed. Its ignored report/trace and JSON
receipt are retained outside Git.

Initial candidate on the same fixture mounted 50 finding rows / 361 Diagnostics
nodes; all final findings and evidence remained accessible. The initial larger
80,000-event fixture (43,218,780 bytes) derived 50,001 findings with a final
30,000-evidence finding. It still mounted 50 finding rows / 361 nodes and passed
last-item access, keyboard navigation and an accessibility scan of the populated
pagers. The initial large test body completed in 9.0 seconds; observed load time
was 6,718 ms. These are synthetic browser observations on this host, not
model/provider throughput or a statistically qualified latency speedup.

The bound covers these mounted lists, not total recording/model memory, complete
detector evaluation, topology lists or other views. The full recording and
findings remain retained. No evidence is silently discarded to reach the bound.
The existing synthetic label and sensitive export confirmation are preserved.

Reproduce the default bound/reachability and repeated stability controls:

```sh
E2E_CHROMIUM_PATH=/path/to/chromium npx playwright test \
  e2e/diagnostics-pagination.spec.ts --workers=2 --retries=0
E2E_CHROMIUM_PATH=/path/to/chromium npx playwright test \
  e2e/diagnostics-pagination.spec.ts --repeat-each=20 --workers=2 --retries=0
DIAGNOSTICS_STRESS_FINDINGS=50000 DIAGNOSTICS_STRESS_EVIDENCE=30000 \
  E2E_CHROMIUM_PATH=/path/to/chromium npx playwright test \
  e2e/diagnostics-pagination.spec.ts --repeat-each=6 --workers=2 --retries=0
```

The normal hosted browser check includes the default 8,000-event case. Larger
counts are opt-in, capped at 100,000 per list and required to be multiples of
50. Each test has a 90-second deadline, no retry in the qualification commands,
and emits measurement attachments in ignored Playwright output. All source
replacement, evidence, accessibility and no-page-error assertions remain enabled.
Exact-revision local/hosted/interoperability receipts are recorded with the PR;
initial measurements above describe the pre-publication working implementation.
