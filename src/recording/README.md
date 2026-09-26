# Recording

Responsibility: Bounded session recording with redaction and retention metadata.

- `ndjson.ts` parses NDJSON/JSONL, validating each line and reporting rejects with line numbers.
- `sobs.ts` builds the manifest and reads/writes `.sobs` files
  ([format](../../docs/RECORDING_FORMAT.md)).

Quota, retention, and rotation are not implemented yet. See [source workspace](../README.md).
