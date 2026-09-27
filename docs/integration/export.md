# Integration notes — `feat/export`

Owner area: `src/export/` (new), plus the minimal desktop save surface in
`src/integrations/desktop.ts` (`saveTextNative`) and `src-tauri/`
(`save_export` command, `src/export.rs`).

## What it does

| Format | Renderer | File |
| --- | --- | --- |
| HTML report | `renderHtml(buildReport(...))` | `observatory-<session>-<stamp>-report.html` |
| Markdown summary | `renderMarkdown(buildReport(...))` | `…-summary.md` |
| Findings + metrics JSON | `renderJson(buildReport(...))` | `…-findings.json` |
| Filtered range as recording | `renderSobs(events, range)` | `….sobs` |

- **HTML** is one file: inline `<style>`, inline SVG (topology scene and a
  timeline density snapshot), no `<script>`, no `src`/`href`, no `url()` other
  than the local arrow marker, and a CSP meta tag (`default-src 'none'`) so a
  browser will refuse any request even if producer text slipped through.
  Producer-controlled strings are HTML-escaped and `://` is broken up so no
  event text reads as a URL.
- **Findings** are recomputed over the exported range with `runDiagnostics`,
  and each finding lists its cited evidence events (time, type, id).
- **`.sobs`** export writes a fresh manifest line plus the selected events,
  unmodified. The manifest's `capture_policy` is the policy declared by the
  source session (`session.started` / `session.created`), even when the range
  filters out the session-start event. `loadRecording()` on the result gives back exactly those events
  (tested for the full session, a class filter, a text filter and a time window).

**Recording hygiene** (docs/SECURITY_PRIVACY.md): `assessExportSensitivity()`
flags full text capture (`text_capture` `full` / `on`, or plaintext
`token_text`) and unredacted tool payloads (`args`/`result`/… on `tool.*`
events that are not `[redacted…]` or `sha256:…`). `exportSession()` throws
`SensitiveExportError` and writes nothing, on both the browser download and the
desktop `save_export` path, unless `acknowledgeSensitive: true` is passed.
`saveText`/`downloadText` are not exported from `src/export` so the hook
cannot bypass the check. `exportWithConfirmation(format, input,
confirmSensitiveExport)` shows the modal warning (native `<dialog>`, labelled
and described, Escape / Cancel = no export, Cancel focused first) only when
needed. The Markdown summary clips producer-controlled strings and applies a
final 65 536-character budget with a truncation marker.

Only public APIs are used: `deriveMetrics` (`src/query/metrics.ts`),
`runDiagnostics` (`src/diagnostics/index.ts`), `deriveTopology` /
`layoutTopology` / `buildScene` / `shapePath` (`src/topology/index.ts`),
`getEventIndex` / `bucketize` (`src/renderer/timelineModel.ts`),
`serializeRecording` (`src/recording/sobs.ts`) and the `fmt*` helpers
(`src/renderer/format.ts`). `src/replay/session.ts`, `SessionStore`, metrics,
diagnostics and topology internals are untouched.

## Lead actions

### package.json / root config

**No changes.** No new dependencies, scripts or config. The new tests live
under `tests/export/` and are picked up by the existing `tests/**/*.test.ts`
glob. The markdown snapshot is committed at
`tests/export/__snapshots__/synthetic-session.summary.md`; regenerate with
`npx vitest run tests/export -u` if the fixture, metrics or detectors change
on purpose.

### "Export" menu hook (`src/renderer/app.ts`, lead-owned)

Not wired on this branch. Suggested hook, next to the existing "Save
recording" control:

```ts
import { confirmSensitiveExport, EXPORT_FORMATS, EXPORT_FORMAT_IDS, exportWithConfirmation, type ExportFormat } from "../export";

// In the header/toolbar render: a <select> or menu button "Export ▾"
// with one item per EXPORT_FORMAT_IDS entry, labelled EXPORT_FORMATS[id].label.
// Disabled while this.store.events.length === 0.

private async exportAs(format: ExportFormat, scope: "session" | "view" = "session"): Promise<void> {
    const range =
        scope === "view"
            ? {
                  cls: this.filterClass,
                  text: this.filterText,
                  // events up to the replay cursor, as the table shows them:
                  toNs: this.cursor.visibleEvents().at(-1)?.mono_ns ?? null,
              }
            : {};
    try {
        const saved = await exportWithConfirmation(format, { events: this.store.events, range }, confirmSensitiveExport);
        if (saved) {
            this.setStatus(`Exported ${saved.name}`); // or the existing status/toast mechanism
        }
    } catch (err) {
        this.setStatus(`Export failed: ${String(err)}`);
    }
}
```

- `exportWithConfirmation` returns `null` when the session is empty, the user
  declines the sensitive-data warning or cancels the desktop dialog; it throws
  on write errors (show the message). Do not call `exportSession` with
  `acknowledgeSensitive: true` unless the user accepted that warning.
- axe: add the warning dialog to `e2e/a11y.spec.ts` once the menu is wired
  (open an export of a `text_capture: "full"` session and scan while it is open).
- `scope: "view"` exports the filtered event range the user is looking at
  (event-table filters + replay cursor); `"session"` exports everything. A
  two-item submenu ("Whole session" / "Current view") per format, or a
  "Current view only" checkbox in the menu, both work.
- Keyboard: optional `Ctrl/Cmd+Shift+E` → HTML report.
- `saveRecording()` in `app.ts` could later become
  `exportWithConfirmation("sobs", { events: this.store.events }, confirmSensitiveExport)` to get the native save
  dialog on desktop too.

`src/renderer/main.ts`: no change.

### Desktop shell (`src-tauri/`)

- New command `save_export(suggestedName, content, filterName?, extensions?)`
  in `lib.rs`, helpers + unit tests in `src/export.rs`. It opens the native
  save dialog **on the Rust side** (`tauri-plugin-dialog`, already a
  dependency) and writes only to the path the user picked there. The webview
  never sends or receives a path: the suggested name is reduced to a bare file
  name, extensions to short alphanumerics, and the result is `{ name }` only.
  Content is capped at 512 MiB.
- Added to `APP_COMMANDS` in `build.rs` and granted as `allow-save-export` in
  `capabilities/main-window.json`. Still no `dialog:*` / `fs:*` permission for
  the webview.
- No Cargo.toml / Cargo.lock changes.

## Tests

`tests/export/`:

- `markdown.test.ts`: file snapshot of the fixture summary, GitHub size limit,
  escaping, caps, filtered-range labelling.
- `html.test.ts`: well-formedness (tag balance), **no external references**
  (absolute or protocol-relative URLs, `src`/`href`/`action` attributes,
  fetching elements, `@import`, non-fragment `url()`), CSP present, no
  scripts or inline handlers; findings + every evidence id, topology and
  timeline SVG present; hostile producer strings escaped.
- `json-sobs.test.ts`: JSON equals derived metrics/findings; `.sobs`
  round-trip for four ranges, byte-identical re-serialisation.
- `report.test.ts`: range filter, evidence resolution, topology/timeline
  coverage, filtered and empty sessions.
- `save.test.ts`: browser download (Blob type/content, URL revoke), desktop
  `save_export` invocation and cancel (Tauri IPC mocked), file names.
