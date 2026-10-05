# Recording replacement and Follow

A successfully loaded recording or synthetic fixture starts at its own end,
with Follow enabled and replay stopped. The new cursor is positioned before
enabling Follow, because stopping active playback can render synchronously.
The previous source's relative cursor position does not carry across a source
replacement, including shifted origins, different durations and empty or
zero-duration recordings.

This applies at the successful load commit. Cancelled, failed and superseded
loads keep the previous source and cursor. The shared cursor rebuild behavior
for paused live appends is unchanged; producer HTTP resume cursors remain
separate from UI replay time. Live retention, ordering, privacy and export
consent contracts are unchanged.

`e2e/recording-replacement.spec.ts` covers a scrubbed source replacement,
20 transitions across durations and empty/tied recordings, active playback,
stream failure/cancellation/supersession, fixture replacement and a distinct
100,000-event recording uploaded from disk. Synthetic data exercises viewer
stability and scale, not provider or model quality.
