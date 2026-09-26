# Replay

Responsibility: Recorded-session playback, seeking, and state reconstruction.

- `order.ts` dedupes by `event_id`, orders by `mono_ns`/`sequence`/`event_id`, and reports sequence gaps.
- `controller.ts` is the pure replay cursor (seek, advance by speed, next match).
- `session.ts` holds the currently viewed session from a fixture, file, or live connection.

State snapshots are not implemented yet. See [source workspace](../README.md).
