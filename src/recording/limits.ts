/**
 * Size limits for opening recordings (browser file input and desktop grants).
 * Every event of a recording is held in memory, so a bigger file would
 * exhaust the tab rather than open.
 */

/** Largest recording the viewer opens: 2 GiB. */
export const MAX_RECORDING_BYTES = 2 * 1024 * 1024 * 1024;

/** Longest recording line kept (16 Mi UTF-16 code units); a longer one is rejected unread. */
export const MAX_RECORDING_LINE_CHARS = 16 * 1024 * 1024;

export function recordingTooLarge(limit: number): Error {
    return new Error(`the recording is larger than the ${limit}-byte limit (${(limit / 1024 ** 3).toFixed(1)} GiB) this viewer opens`);
}
