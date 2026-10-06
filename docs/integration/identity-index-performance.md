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
