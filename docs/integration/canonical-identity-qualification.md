# Canonical identity: bounded qualification (2026-10-06)

The canonical identity change separates producer and scoped identity tuples that
previous delimiter concatenation could conflate. The completed local run passed
the recorded correctness controls and browser cases, with substantial measured
costs in cold indexing and 3D derivation. These are synthetic consumer workloads;
no models, live provider calls or producer-quality measurements were involved.
Independent raw review passed and root accepted this bounded local correctness
and measurement evidence. Hosted/public-revision qualification remains pending;
no PR or hosted qualification is established by this report.

## Compatibility boundary

Producer streams and scoped request, session, layer, operator and KV identities
use opaque `obs-key/1:` tagged tuples. Original strings, including embedded
control characters, remain literal. Instance and session-fallback domains are
distinct; an equal explicit or event-ID-inferred producer instance shares its
stream across sessions. Display labels and joins use original source evidence.
3D entity IDs are not split to recover join or label fields. A dedicated
`streamNameAndNode` reader parses the canonical producer-stream tuple for display
names/nodes and returns null for an invalid shape.

`SequenceGap.stream`, `RequestSpan.streamKey` (also in metrics JSON under
`sonder.observatory.export/1`) and scoped 3D IDs deliberately change representation.
Their types and event/export schemas stay the same. Raw envelopes, NDJSON/SOBS
values, event-ID deduplication, resume cursors, text consent and synthetic labeling
retain their contracts. Chunk/token entity IDs remain `chunk:<event_id>` and
`tok:<event_id>`; request-present and legacy requestless pairing use separate
internal domains. Requestless pairing retains its previous raw-session/suffix
behavior.

The change covers grouped Inspector lineage, metrics, cumulative dropped-event
and scoped 3D consumers. Legacy `relatedEvents()` bare-ID correlation, Compare's
request/run/turn alignment, series grouping, recording manifest producer grouping,
node/model lanes, raw session/model maps and global event-ID deduplication retain
their existing limitations. It does not establish universal producer isolation.
See [the schema mapping](../telemetry-schema.md) for the complete reading contract.

Labels resolve original evidence visible at the replay cursor, including output
whose finished request was omitted from the bounded scene. Missing attached
request evidence says `request evidence unavailable`; a null attachment says
`no request`. Future evidence is excluded. The temporary label map is bounded by
requested references; finding them may still scan O(N) retained events.

## Recorded correctness and browser results

Fresh standard q2 recorded lint/typecheck, production build and diff checks with
exit 0; full units were **778 passed, 1 existing skip**. The skip is the opt-in
live-producer conformance case requiring `SONDER_CONFORMANCE_URLS`. The four
collision counterfactuals failed on historical main as expected and all four
passed on the candidate; the focused set passed 41 and the corpus set passed 3.
The corpus checks read retained historical Runtime/Inference NDJSON/SOBS and
native SDK153 capture=false/capture=true variants. They checked parent-bearing
SDK outputs and all 64 outputs in the original actual-main recording; these are
retained-data checks, not a new producer run or current three-repository
interoperability qualification.

Chromium collected and passed **125 unique cases, 0 skips, 0 retries**. The same
two identity controls passed again in a separate bounded invocation: **127
executions**, with **125 distinct cases**. The full browser inventory includes
Inspector replacement/replay and scoped 3D privacy/label controls; the opt-in
ecosystem suite is outside this run. End-position controls assert position 1000,
Follow checked and `Replay · at end`, then Follow unchecked and `Replay · paused
at cursor`, including restoration through a related-event link. JSON/JUnit identities
were matched against the collected inventory using the pinned reporter mapping.
The per-test timeout default was 30 s, with five unchanged existing 60/90 s
overrides in the full inventory; the two repeated identity controls stayed at
30 s. No deadline was enlarged after failure.
This verifies those observable UI predicates, not production rendering latency.

The original failed q1 and its raw evidence remain preserved and unqualified.
The fresh q2 used the same recorded bounds; no timeout was waived. Outer indexed
performance took **261.617 s of 300 s**; outer full browser took **150.190 s of
1200 s**. These are supervisor durations, distinct from inner operation timers.
All 11 followup stages recorded exit 0 and strict cleanup/preservation checks.

## Performance method and all 21 pairs

Node **24.19.0**, Linux x64, ran direct source modules from historical main
`2473d73bdc5d01d9dca39a7c77e0dd72b003648f` and the applied product V4 source.
The cached TypeScript 6.0.3 compiler produced separate module graphs; this
benchmark transpilation is separate from the standard typecheck/build gates.
No historical timing result or optimization override was adopted.

Four immutable synthetic fixtures each contain 100,000 events: many short
requests and one long request with matching, absent or ambiguous parent evidence.
Event hashes match the retained original fixture manifest. Each pair has three
excluded warmups and 20 measured observations per version; version order reverses
each repetition. The **21 pairs / 840 observations** comprise 17 indexed pairs
and four scan pairs. Fixtures, validation, setup and explicit GC are outside the
timers. `cold_index` measures fresh Inspector `CorrelationIndex` construction
plus selection, rather than `MetricsIndex`. Mutation rows include
the named store transition and selection. Many-short warm and shared-prefix rows
average 300 selections per observation; other rows time one operation.

Only source-derived identity/reference fields are projected for historical parity;
evidence, ordering, counts, timing, text and policy fields compare strictly.
Collision controls are separate and are not normalized away. Indexed and scan
results preserve matching, absent and ambiguity behavior; high-K request totals
remain complete. Warm indexed lookup avoids a scan of unrelated events; work for
a long matching request remains proportional to its matching events.

All times below are milliseconds per operation. Ratios are candidate / baseline;
p95 uses the recorded nearest-rank statistic over 20 observations. Rounded ratios
must not be interpreted as timing thresholds.

| Fixture | Operation | Baseline median ms | Candidate median ms | Median ratio | Baseline p95 ms | Candidate p95 ms | p95 ratio |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| long_absent | cold_index | 42.564902 | 110.972017 | 2.607× | 49.778467 | 116.049209 | 2.331× |
| long_absent | derive_3d | 171.970568 | 364.891551 | 2.122× | 179.659666 | 372.925270 | 2.076× |
| long_absent | warm_selection | 7.639683 | 7.572152 | 0.991× | 11.662651 | 14.456404 | 1.240× |
| long_ambiguous | cold_index | 69.660089 | 146.069898 | 2.097× | 77.236213 | 152.387573 | 1.973× |
| long_ambiguous | derive_3d | 172.407863 | 362.831934 | 2.104× | 180.328800 | 371.719872 | 2.061× |
| long_ambiguous | warm_selection | 6.174740 | 6.722155 | 1.089× | 6.394138 | 7.416051 | 1.160× |
| long_matching | cold_index | 42.820238 | 112.285654 | 2.622× | 50.239365 | 124.214374 | 2.472× |
| long_matching | derive_3d | 170.985432 | 359.976253 | 2.105× | 178.247290 | 370.226975 | 2.077× |
| long_matching | warm_selection | 8.466497 | 8.280937 | 0.978× | 18.036029 | 19.384862 | 1.075× |
| many_short | cold_index | 74.492563 | 159.910233 | 2.147× | 83.809255 | 175.523260 | 2.094× |
| many_short | derive_3d | 209.834271 | 351.444028 | 1.675× | 215.734150 | 363.223420 | 1.684× |
| many_short | in_order_append_and_selection | 3.710450 | 3.813783 | 1.028× | 4.578317 | 4.065211 | 0.888× |
| many_short | out_of_order_merge_and_selection | 70.987708 | 170.817902 | 2.406× | 76.772932 | 186.018854 | 2.423× |
| many_short | reset_rebuild_and_selection | 137.776943 | 248.303482 | 1.802× | 153.706315 | 261.556663 | 1.702× |
| many_short | retention_and_selection | 110.849299 | 209.688453 | 1.892× | 121.181776 | 222.369037 | 1.835× |
| many_short | shared_old_prefix_selection | 0.003862 | 0.007741 | 2.004× | 0.004668 | 0.007960 | 1.705× |
| many_short | warm_selection | 0.002680 | 0.004422 | 1.650× | 0.002891 | 0.004713 | 1.630× |
| long_absent | scan_selection | 69.987671 | 74.346257 | 1.062× | 73.040346 | 85.782995 | 1.174× |
| long_ambiguous | scan_selection | 54.610229 | 74.249603 | 1.360× | 66.935644 | 81.899886 | 1.224× |
| long_matching | scan_selection | 92.572382 | 82.978340 | 0.896× | 99.829279 | 87.298395 | 0.874× |
| many_short | scan_selection | 58.349653 | 20.241193 | 0.347× | 68.180480 | 32.951685 | 0.483× |

Cold-index medians were **2.10–2.62×**, and 3D derivation medians **1.67–2.12×**
historical main. Out-of-order merge, reset and retention also cost more in this
run. Some scan and warm-selection observations improved, while others regressed;
17 of the 21 median ratios exceed 1. This does not support a general speedup
or a production no-regression claim.
Canonical encoding adds work and longer keys; the measurements do not isolate a
causal allocation or CPU profile. Absolute sub-millisecond rows, GC, process
state and tail dispersion limit comparisons beyond this fixed synthetic run.

## Bounded stress, labels and memory observations

Each version ran five cycles in one fresh child across four fixtures, six transitions
(initial prefix, append, shared prefix, out-of-order merge, retention and reset)
and indexed/scan selection: **240 checked selections per version**. High K close
to retained N and early parent ambiguity were included. Input immutability,
complete request totals and selection signatures were checked. Whole-process
stress took 25.673 s baseline and 30.225 s candidate. Final sampled RSS was
325,099,520 / 324,677,632 bytes and lifetime maxRSS was 442,252 / 446,540 KiB
(baseline / candidate).

These RSS/heap/external/array-buffer samples include fixtures, correctness oracles,
module graphs and indexes. Explicit GC occurs outside selection timers. Lifetime
maxRSS is an OS process high-water mark. Five bounded cycles do **not** establish
an operation allocation bound, parser-only peak memory or absence of a leak.

Candidate label lookup ran **20 calls**, each over 100,000 events with **21
references**: five each for recent output, omitted finished requests, missing
evidence and future-at-cursor evidence. Recent and omitted cases returned 11
original labels; missing/future cases returned zero. Observed call ranges were
0.057–0.278 ms recent, 2.706–15.673 ms omitted, 2.725–5.125 ms missing and
3.110–15.384 ms future-cutoff. This corrects label behavior without a claimed
baseline speed comparison. The bounded map does not eliminate the O(N) scan.

Per-event encoding totals in that fixture were 3,540,288 → 7,040,288 bytes for
stream strings and 5,049,220 → 11,549,220 for public 3D request-ID strings;
maximum individual lengths were 45 → 80 and 61 → 126 bytes. These are repeated
encoding byte counts, not retained cache size or exclusive allocation.

## Provenance and practical limits

The applied **product V4 / 21-file scope** is distinct from external **followup
driver V3** and root **invoker V4**. The measured source includes the schema doc
before this report/link addition; these two proposed documentation files do not
alter code, tests or the measured production bundle.

| Evidence | SHA-256 |
| --- | --- |
| Product V4 source freeze | `0473bbff1aa6f08d72f16c59aa99fbf4f4b9c5e80e7a126c703c3d1f15301d41` |
| Actual V4 application (`root-source-application-actual-v4.json`) | `752cffe1cb49142e5a0df815fdd0b1e393d9091bd354143afda2163355d4a2ca` |
| Followup driver V3 freeze | `39e46de2daa4f3413e6f10bcdd0f16eede3f7916ecef4ec6183fea78540116d0` |
| Root invoker V4 (`run-followups-v4.py`) | `2244b34f78246d44dbb3e22ede60d8d3d95113ff206892fa2d7982021b85aaf0` |
| Standard q2 root actual witness | `3692193ad4f4ebf3f454068f804a91153fa7711f29016dbbea6c30501fa8b384` |
| Standard q2 independent raw review | `b64ef2dc0dbcf41d23db49a2bd63d523a58a955c12ad38f6f71a29e931111902` |
| Followup q2 root actual witness | `528f5a0661dd15dfba908191d9a0107d9a0887597d10517c99e12d21e2e1379a` |
| Followup raw index (197 files) | `fcb982b34662fa12ad72153e6fa267ef0653e02666711dc2b455a6c276b632e6` |
| Measurement data audit | `0aac15cc602693fa2549bc57756bc781848d2b42d51cb4fff761c60fd00ef836` |
| Browser data audit | `159c5c3a0d0e1c63630be3bef0dda564952019f016dc30a1ef4bee33ebed9b6c` |
| Followup q2 independent final raw review | `bc92ff2e1e5be8afa045346be4bb655330f6aa10507cd646d2d233344bd905b6` |
| Root bounded local acceptance | `bfce770c9732572705e8a8a9a9042b3465eca22526b91ca74b72df7a4bb24d3c` |

The root actual witness is retained in the cycle evidence directory as
`root-followup-q2-actual-v1.json`; raw output is retained under
`obs-identity-followups-dbijzqll-q2`. Raw receipt pins describe this historical
run rather than current heads of unrelated repositories. The independent review
rechecked the final raw evidence; root acceptance binds that review and the
standard gates, retaining all 20 expected stage outcomes including the intended
baseline collision exit 1. Mechanical exit 0 alone is not release acceptance.
No new producer process/execution, model download or live provider request is
part of these measurements. Retained corpus evidence does not establish current
producer interoperability or production quality.
