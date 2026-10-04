# Inference chat message counts in export sensitivity checks

Sonder-Inference's `TELEMETRY.md` defines `messages` on `request.queued`
with `kind: "chat"` as the number of chat messages. The C ABI/Python mock SDK
emits this integer even with `capture_text=False`. Previously Observatory
classified the integer as plaintext and warned that capture-off recordings
contained prompt/output text.

`assessExportSensitivity` recognizes this field as structural only when the
producer name is `sonder-inference`, the event is `request.queued`, the kind
is `chat`, and the value is a nonnegative safe integer. All other fields are
assessed as before. Strings, message arrays/objects, invalid counters and
unknown producer/event/kind contexts still require the conservative warning.
Explicit `full` / `on` capture declarations remain session-wide, including
when an export range excludes the declaration. Tool payload checks and the
browser/desktop explicit acknowledgment gate are unchanged. This recognition
is about field semantics; a producer label is not authentication or proof
that an entire recording is safe.

Recordings and `.sobs` exports preserve the original event values and IDs.
No producer schema, instrumentation, execution state, capture policy, replay
cursor, batching or rollback contract changes. Mock sessions retain their
synthetic provenance; shared observations with unknown provenance stay unknown.

## Qualification

The 20 unit cases in `tests/export/inference-message-count.test.ts` cover
valid counters and privacy controls. Two browser cases in `e2e/export.spec.ts`
exercise direct count-only downloads and Cancel/explicit acknowledgment for
actual message content, using synthetic fixtures.

Run the bounded offline scan from the repository root:

```sh
node tests/export/qualification/inference-counts.mjs --events=100000 --rounds=20
```

It scans 1,000, 10,000 and 100,000 synthetic events, retaining each measured
cohort, with four privacy controls per cohort: real message content, unknown
producer counters, numeric tool results and a capture-on declaration outside
the selected range. Limits are 100,000 events and 20 rounds. It performs no
provider calls, writes no recordings and measures sensitivity scanning only;
its timings are not model quality or provider throughput evidence. The JSON
receipt records the revision and whether source edits were present. Live SDK
recording roundtrips and hosted checks belong in the PR's qualification receipt;
do not commit those recordings or infer their execution from this document.
