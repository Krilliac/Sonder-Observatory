# Recording format (Milestone 1)

Decided 2026-09-26; provisional. Resolves the Milestone 0 item "choose
recording extension/container name" for bring-up.

## Extension

`.sobs` ("Sonder Observatory session"). The extension was already reserved in
`.gitignore` as a private recording type, so recordings stay out of Git.

## Container

A `.sobs` file is UTF-8 newline-delimited JSON (NDJSON / JSONL):

```text
line 1   {"format":"sonder.observatory.recording/1", ...manifest...}
line 2+  one protocol event per line, exactly as received
```

This is the single-file form of the logical layout in ARCHITECTURE.md
(`manifest.json` + `events.ndjson`). It is debuggable with text tools and can
be appended to. `snapshots/` and `attachments/` are not produced yet.

A later ZIP-compatible `.sobs` container is allowed; readers distinguish it by
its leading `PK` bytes. The current reader reports ZIP files as unsupported
rather than guessing.

Readers also accept a bare NDJSON/JSONL event log with no manifest (for
example `fixtures/synthetic-session.ndjson`).

## Manifest fields

The manifest is Observatory-owned recorder metadata, not part of the producer
protocol. It is computed from the recorded events when saving:

| Field | Meaning |
|---|---|
| `format` | `sonder.observatory.recording/1` |
| `created_at` | when the file was written (UTC) |
| `recorder` | recorder name/version |
| `complete` | every session in the file has a `session.ended` event |
| `event_count` | number of event lines |
| `schema_versions` | distinct `schema` values seen |
| `producers` | distinct producer name/version/node, with `synthetic` flag |
| `session_ids`, `run_ids` | distinct correlation ids |
| `sampling_levels` | distinct `sampling.level` values |
| `capture_policy` | `attributes.text_capture` from `session.started`, else `unspecified` |
| `dropped_events` | sum of producer-reported `telemetry.dropped` counts |
| `time_origin` | wall/monotonic time of the first event |
| `synthetic` | any producer marked `synthetic: true` |

Not yet recorded (need producer support or later milestones): redaction
policy details, model/backend/device descriptors beyond event ids, storage
quota/retention, rotation.

## Validation on load

Every event line is checked against the v1 envelope schema. Invalid lines are
kept out of the view but counted and reported with line numbers so partial or
corrupt recordings remain inspectable. Duplicate `event_id`s are ignored and
counted.
