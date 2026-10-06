# Call-local Inspector identity reuse qualification

Qualified local source experiment against current canonical-identity main
`65e60c76bcc0a7565477fbdc501b8e211552b1a7`, measured 2026-10-06 UTC.
These are synthetic consumer measurements on Node 24.19.0, not provider
throughput, model quality, production latency, or an allocation/leak bound.

## Change and retained contracts

`createIdentityKeys()` keeps only the last literal tuple for stream, request
and session composition in a fresh consumer-pass instance. Inspector creates
one instance for each unbuilt index tail and returns before creating one on
a no-growth selection. The native composers remain the miss oracle. Each
entry admits at most 16,384 summed UTF-16 code units of its raw fields plus
encoded result; oversized tuples clear that entry and return the complete
stateless result. This limits retained string data per record, not V8 heap
bytes, temporary output allocations, or process memory.

Producer instance inference is recomputed on every event. Known-instance and
session-fallback domains, literal strings, escaping, request-ID presence rules,
ambiguity withholding, original event references, complete request totals and
cursor/retention/reset behavior retain their current-main semantics. Native
composer bytes, scan selection and 3D derivation are unchanged. The factory
does not retain events or producer objects and has no cross-pass/global cache.
There are no telemetry-schema, privacy/consent, producer cursor, batching,
effect recovery, rollback, dependency or CI changes.

## Measurement method

Separate immutable baseline and candidate module graphs used identical
100,000-event fixtures: many short requests, and long requests with matching,
absent or ambiguous parent evidence. Three warmups were excluded; 20 samples
per version reversed version order every repetition. Fixture creation, explicit
GC, setup, correctness checks and output serialization were outside timers.
Cold timings include index construction and selection; transition timings
include the named store mutation and selection. Many-short warm and shared
prefix samples batch 300 selections and report time per call. Implicit GC can
still occur inside a timed operation. Native output equality used the complete
current-main output, with no identity projection or old delimiter baseline.

The table retains all 21 pairs / 840 observations. Values are milliseconds;
p95 is the nineteenth sorted value of 20. A ratio below 1 means a lower
candidate median. Small changes in unchanged paths are controls, not claimed
speedups. In particular, the ambiguous warm-selection p95 increased and is
reported here rather than hidden.

| Fixture | Operation | Baseline median | Candidate median | Median ratio | Baseline p95 | Candidate p95 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| many_short | cold_index | 159.608962 | 84.713337 | 0.5308 | 170.944893 | 102.111159 |
| many_short | warm_selection | 0.004235 | 0.004271 | 1.0086 | 0.004495 | 0.004703 |
| many_short | derive_3d | 357.998611 | 357.972556 | 0.9999 | 364.930188 | 384.013162 |
| many_short | in_order_append_and_selection | 3.709103 | 3.151424 | 0.8496 | 4.230408 | 3.307960 |
| many_short | shared_old_prefix_selection | 0.007408 | 0.007435 | 1.0037 | 0.007949 | 0.008547 |
| many_short | out_of_order_merge_and_selection | 157.535440 | 92.577025 | 0.5877 | 162.144529 | 97.122385 |
| many_short | retention_and_selection | 198.469077 | 141.246138 | 0.7117 | 205.230912 | 147.803309 |
| many_short | reset_rebuild_and_selection | 237.250433 | 169.836429 | 0.7159 | 254.817396 | 173.402132 |
| long_matching | cold_index | 101.135874 | 20.302058 | 0.2007 | 114.160605 | 28.855406 |
| long_matching | warm_selection | 8.279699 | 8.232190 | 0.9943 | 23.158226 | 16.779889 |
| long_matching | derive_3d | 375.836757 | 380.812472 | 1.0132 | 394.123645 | 389.073970 |
| long_absent | cold_index | 102.353830 | 20.948611 | 0.2047 | 113.419070 | 27.579839 |
| long_absent | warm_selection | 9.048822 | 8.313738 | 0.9188 | 13.322992 | 9.003258 |
| long_absent | derive_3d | 369.899321 | 373.378085 | 1.0094 | 398.848901 | 390.040940 |
| long_ambiguous | cold_index | 138.420381 | 44.677929 | 0.3228 | 151.391980 | 51.380226 |
| long_ambiguous | warm_selection | 6.455478 | 6.497100 | 1.0064 | 11.183377 | 21.730809 |
| long_ambiguous | derive_3d | 373.484713 | 373.831881 | 1.0009 | 385.948790 | 379.766917 |
| many_short | scan_selection | 21.563074 | 19.883782 | 0.9221 | 31.902923 | 34.414781 |
| long_matching | scan_selection | 81.617120 | 83.000958 | 1.0170 | 87.313174 | 96.094259 |
| long_absent | scan_selection | 76.083875 | 75.793037 | 0.9962 | 84.715798 | 87.341834 |
| long_ambiguous | scan_selection | 74.309965 | 73.422277 | 0.9881 | 83.146791 | 83.265392 |

Cold-index medians were 0.20–0.53 times the baseline on these four fixtures.
Append, out-of-order merge, retention and reset/rebuild also improved in the
many-short fixture. Seven of 21 median ratios were above 1, including unchanged
controls; this change does not improve every operation or workload. No 3D
speedup is claimed.

## Miss and admission cost

An additional direct-composition comparison used four 10,000-event cases
and one 1,000-event oversized case, each calling stream/request/session. Fresh
factories, three excluded warmups and 20 samples per version produced 200
observations. Both timers include output-array collection and the same cheap
checksum; full native string equality, fixtures, GC and factory creation are
outside timers. Five extra cycles produced 50 stability passes. These direct
key timings do not measure whole-index latency.

| Direct-key case | Baseline median ms | Candidate median ms | Median ratio | Baseline p95 ms | Candidate p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| same_scope_hits | 10.392825 | 1.770673 | 0.1704 | 11.046213 | 1.995135 |
| alternating_two_known_misses | 10.004763 | 11.736323 | 1.1731 | 11.288243 | 13.333412 |
| unique_known_misses | 10.473798 | 11.832319 | 1.1297 | 10.790376 | 13.978985 |
| changing_inferred_fallback | 12.234695 | 14.979418 | 1.2243 | 12.699625 | 17.045421 |
| oversized_stream_fallback | 233.581265 | 234.504467 | 1.0040 | 237.809304 | 242.101213 |

Alternating/unique/changing-inference misses cost about 13–22% more in this
direct-key comparison. A stream miss repeats native instance inference, and
admitted misses allocate the replacement record. The measured Inspector
benefit depends on adjacent scope/request reuse. Oversized fallback was near
baseline; output was never truncated. This is a useful bounded index
optimization with an explicit miss tradeoff, not a universal encoder speedup.

## Correctness and stability

The full unit suite passed 785 tests, including seven new literal/mode,
mutation, lifetime, last-entry and cap/fallback controls; one existing opt-in
live-producer conformance test was skipped because its URL configuration was
absent. Lint/typecheck, build, unstaged and staged diff checks passed. Per-test
timeouts were unchanged and the unit suite used four concurrent workers.

Five sequential stress cycles per version exercised four fixtures and six
transitions through indexed and scan selections: 240 selections per version.
Corresponding full-output signatures, retained-event counts and complete own
candidate/row counts matched across versions. Warm getter controls read zero
unrelated keys, parent ambiguity remained bounded, high-K own-request evidence
retained its complete totals, and scene request/chunk bounds passed. The direct
key supplement also passed ten native cap-boundary outputs and two unchanged
thrown-marker controls.

Stress memory samples include fixtures, mandatory outputs and correctness
oracles. After-GC samples and lifetime maximum RSS are whole-process values;
they do not prove exclusive cache allocation, a peak-heap limit or absence of
all leaks. No live producer/provider/model execution occurred. This does not
substitute for the skipped opt-in live-conformance test.

## Source and evidence receipts

The three implementation/test byte hashes were fixed throughout compilation,
measurement and standard checks. The later report addition is documentation;
it does not restamp historical compile or test receipts.

| File | SHA-256 |
| --- | --- |
| `src/query/identity.ts` | `b789cd3bfa2c0a2e9fcf73255193f6acf3152eda944ed9084e286fdb19a98abf` |
| `src/inspector/related.ts` | `2c78ea3dfce61a5caad72b9cae2b48fca27c1ebed410276859044413106417f6` |
| `tests/identity-cache.test.ts` | `383a2170cd50df10ac873f1047fcd18da95a363bd447c7392654fcfbb15a5455` |

Raw evidence is retained outside Git, including source-bound inputs, compile
receipts, drivers, guards, process ledgers, all observations and test JSON.
The following hashes identify the principal immutable result files:

| Result | SHA-256 |
| --- | --- |
| `results-indexed.json` | `2debbf34ac41452c1adc89790959dd5e4531f5f6d3e59da5940d2b9ec2de2273` |
| `results-unindexed.json` | `2b2dea05a897396b96d11f955eedbb4155ca53e0641e14ce3cfebaacdc8087d0` |
| `allocation-stress-baseline.json` | `e8f8e505cf2096696602782a3ebfe2fa44236f60644b9ca9b3e1e92b8ae93a13` |
| `allocation-stress-candidate.json` | `e0e2874cd83138ae4a050258c3989cd71cd88f9ffb26134f60df51098aa7852c` |
| `result.json` | `f4d358bec52d4a1853c5f2b55926523bb7c4371b08607e22984af8a18ab1c4af` |
| `full-units-I1.json` | `42debdbc3cc5643febf7f0951a93c656fcc5e2f3df2d82dfdf1cb5f053026e8d` |

Stage command budgets stayed at 300 seconds for the indexed matrix, 180 for
the scan matrix, 90 per stress child, and 90 for the direct-key supplement.
Their driver elapsed times were 297.509, 50.690, 30.965, 25.974 and 22.755
seconds respectively. Supervisor totals also include preservation and cleanup;
the indexed total was 303.329 seconds. All commands exited zero with recorded
source preservation, final ECHILD, no owned leftovers and no cleanup signals.
An initial uppercase supplement stage label was rejected during guard capture
before product execution; its record is retained. No test timeout was raised
and no failed product run was retried.

Qualification of hosted checks and merging must use the exact published head.
This local report alone is not a hosted-CI or merge receipt.

## D1: reuse the native request key within each 3D event

This subsequent qualification uses a fresh baseline at main
`7694327917232810519689e9018a2371e57ace98`, including the Inspector changes
above. Its timings must not be compared to the earlier I1 epoch as a paired
measurement. The candidate composes the native scoped request key once for
each relevant event and reuses that string for the second request lookup.
Both map lookups remain, including the lookup after creating a new request.
The variable resets on every event; no cross-event cache or retained event
reference is introduced. Relevance, empty-ID lifecycle behavior, output and
sampling predicates, producer inference, ambiguity, consent and scene bounds
retain their existing behavior.

Fresh baseline and candidate graphs each contain 14 source modules and 15
emitted files. Only the emitted `src/inference3d/derive.js` differs. Node
24.19.0 and TypeScript 6.0.3 were used with the same 1024 MiB old-space setting.
Four immutable synthetic fixtures contain 100,000 events each. Each cell has
three excluded warmups and 20 measured calls per version, with alternating
version order: 160 observations in one paired process. Preparation, explicit
GC, serialization and correctness checks are outside the timed derive call.
Every measured complete native output matched by deep equality and SHA-256;
untimed indexed/scan Inspector and negative controls also passed.

| Fixture | Baseline median ms | Candidate median ms | Baseline p95 ms | Candidate p95 ms |
| --- | ---: | ---: | ---: | ---: |
| `many_short` | 364.720 | 298.630 | 385.589 | 318.223 |
| `long_matching` | 375.584 | 311.567 | 407.457 | 326.173 |
| `long_absent` | 371.660 | 310.180 | 379.564 | 314.395 |
| `long_ambiguous` | 368.395 | 306.683 | 379.062 | 317.565 |

Median time was 16.5–18.1% lower and p95 time 16.2–19.9% lower in these
fixtures. These are local synthetic telemetry-consumer measurements, not
provider throughput, model quality, production latency bounds or a statistical
significance claim. Whole-process memory samples include fixtures, modules,
outputs and correctness oracles; they do not prove exclusive allocation or
absence of leaks.

Separate baseline and candidate stress processes each ran five cycles through
four fixtures and six transitions: initial input, append, shared prefix,
out-of-order input, retention and reset. All 120 corresponding complete-model
hashes, input hashes, retained counts, native counts and clock values matched.
Twenty cursor comparisons per version also matched, representing 40 extra
derive calls per version. The 256-event cursor control bounds visible events;
filtering the full input array can still traverse all 100,000 events. Existing
request/chunk/evidence bounds passed. No live producer or provider ran.

The focused suite passed 34 tests. The full suite passed 788 tests, including
three added preservation cases; the existing URL-dependent live-producer
conformance case was skipped (789 total). Lint/typecheck, build and both diff
checks passed. Four unit workers and native per-case timeouts were retained.
The three added cases test fact-only events before request creation, newborn
request evidence and unrelated events across repeated cursor calls; they are
preservation controls, not red defect reproductions.

The paired driver took 83.849 seconds within its 300-second command budget;
baseline and candidate stress drivers took 69.581 and 63.256 seconds within
separate 90-second budgets. Compile, focus, pair, stress, lint, units and build
commands all exited zero, with recorded source preservation, final ECHILD,
no owned process leftovers and no cleanup signals. An initial empty patch
hunk was rejected before writes, and a root build-receipt bookkeeping lease
assertion was corrected after the successful build; neither caused a product
retry. Independent source and completed measurement/stress DATA reviews
passed. Hosted qualification and merge remain separate exact-revision gates.

| D1 source/result | SHA-256 |
| --- | --- |
| `src/inference3d/derive.ts` | `c1027b8003bb1ddff68b4ffc0acc59ae859fa7df8d55c50407980ffd7b806428` |
| `tests/inference3d/identity-isolation.test.ts` | `19a04f3f2152be90bc21deae9ac4fe2df53d1a462b3a900bf25fd57cfa1ff211` |
| `benchmark-results.json` | `991ce2ccfdddd478fa257c9278ddf05dde3aae0f671d8b5c5a2240a28db1d7c2` |
| `derive-stress-baseline.json` | `748fd57215f56c853696d6f99c1c43623c7a57d3f59a8a70521a697a97f889e5` |
| `derive-stress-candidate.json` | `ee8faf19ecec0e70f97ab34d2b7e48862fd8ea5c6b3375336ff8262bf4d2a32a` |
| `full-units-D1.json` | `be6e3209fcdadff4b5c95b86c62377cbf3a93a0cf3afc2b8bbbc85b41162b2a6` |
| Independent completed measurement DATA review | `f193f15a6e5f1d1eb4d15ffd88f55726dfb786846ffe7df5cd75b39d1d78ca03` |

The implementation/test bytes were fixed throughout all D1 executions. This
later report append does not restamp the earlier source-input, compile or test
receipts as executions on a published head or merge. Raw observations,
source-bound manifests, guards, process ledgers and logs are retained outside
Git. This section records local results only.
