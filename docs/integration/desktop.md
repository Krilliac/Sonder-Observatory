# Integration notes — `feat/desktop`

Owner area: `src/integrations/` and `src-tauri/`. This branch wires the Tauri
bridge into the renderer (mode indicator, native open of `.sobs` recordings,
recent files) and polishes the shell (icon artwork, least-privilege
capability, recent-recordings commands).

## Lead actions

### package.json / root config

**No changes required.** Everything uses existing dependencies
(`@tauri-apps/api`, `@tauri-apps/cli`) and scripts (`tauri`, `test`, `lint`,
`build`). In particular, no `@tauri-apps/plugin-dialog` or
`@tauri-apps/plugin-fs` JS packages are added (see "File access" below).

Optional, root-owned: add `"src-tauri/target/**"` and `"src-tauri/gen/**"` to
the ESLint ignores in `eslint.config.js`. After a local `cargo build`, tauri's
generated `target/**/__global-api-script.js` makes `npm run lint` fail locally
(CI is unaffected because it never builds into `src-tauri/target`).

### Binary icons (needs a git push, not possible through the GitHub API tools)

**Done (integrator, 2026-09-26):** the lockfiles workflow gained an `icons`
input that runs the steps below in CI and commits the set; `.gitignore` and
`bundle.icon` were updated as described. The ESLint ignores above and the
`rust-version = "1.87"` bump (Cargo.lock section) landed in PR #17.

The GitHub MCP `push_files` / `create_or_update_file` tools only take text
content, so the PNG/ICO/ICNS set generated on the box could not be committed
byte-for-byte (and retyping binaries is not an option). This branch therefore
commits the source `src-tauri/icons/app-icon.svg` and makes `build.rs`
rasterise the same mark as the placeholder icons. To land the real set, from a
checkout of this branch:

```bash
npm ci
npm run tauri icon src-tauri/icons/app-icon.svg
rm -rf src-tauri/icons/android src-tauri/icons/ios
# src-tauri/.gitignore: replace "/icons/*" and "!/icons/app-icon.svg"
# with "/icons/android/" and "/icons/ios/"
git add src-tauri/icons src-tauri/.gitignore
```

and add `"icons/128x128@2x.png"` and `"icons/icon.icns"` to `bundle.icon` in
`src-tauri/tauri.conf.json`. That produces 32x32, 64x64, 128x128,
128x128@2x, icon.png (512), icon.ico, icon.icns and the Windows Square*/Store
logos (~225 KB total; verified on the box). The placeholder generator in
`build.rs` can be deleted afterwards.

### Cargo.lock

Unchanged on this branch. Regenerating it on the box
(`CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback cargo generate-lockfile`,
cargo 1.85.1) reproduces main's `Cargo.lock` byte-for-byte, and no crate was
added. However that lockfile does **not** build on the declared
`rust-version = "1.85"`: `yoke-derive` 0.8.3 uses `str::from_utf8` (stable in
1.87) while claiming an older MSRV. CI uses stable, so it is not affected. For
the Linux verification below the box used `cargo update -p yoke-derive
--precise 0.8.2` (adds `synstructure` 0.13.2, nothing else changes). Lead
decision: commit that pin (e.g. run it after the lockfiles workflow and push),
or bump `rust-version` to 1.87.

### UI edits outside `src/integrations/` (minimal hook)

Only `src/renderer/main.ts`: the inline mode-badge block (and its two imports)
moved into `src/integrations/desktopUi.ts`; main.ts now ends with a single
`mountDesktopIntegration();` call after `ObservatoryApp.start(...)`.

`src/renderer/app.ts` is **unchanged**. Natively read recordings are handed to
the app through its existing `#file-input` change handler: `fileInputHost()`
wraps the text in a `File`, assigns it via `DataTransfer` and dispatches
`change`, so the app loads it exactly like a browser-picked file (and
disconnects live mode first). If you would rather have an explicit API, add
`openRecordingText(text, label)` to `ObservatoryApp` and pass the app to
`mountDesktopIntegration(app)`; the `RecordingHost` interface already matches.

No CSS changes; the new controls reuse the existing `select`, `.badge` and
`.muted` styles.

## Behaviour

| | Browser (or Flutter WebView) | Desktop (Tauri shell) |
|---|---|---|
| Header badge `#mode-badge` | `browser` | `desktop` |
| "Open recording…" | existing `<input type="file">` (unchanged) | native dialog (filters: `.sobs`, then `.ndjson/.jsonl/.json`, then all files) |
| Recent menu `#recent-select` | not shown | last 10 recordings, missing ones disabled, "Clear recent" |
| `--open <path>` launch arg | n/a | loaded at startup; launch warnings shown in `#desktop-status` |

Session folders (a folder or its `manifest.json`) load the first of
`events.sobs`, `events.ndjson`, `events.jsonl`, `recording.sobs`.
Errors (unreadable file, missing events entry) appear in `#desktop-status`.
The file-input stays in the DOM as the fallback path.

## File access (why no fs plugin in the webview)

The native dialog is `tauri-plugin-dialog`, invoked **from Rust**
(`pick_recording`). The user's choice becomes a read-only *grant*; the webview
reads it through `read_recording_entry` in 16 MiB chunks. Granting the webview
`dialog:allow-open` plus `fs:allow-read-file` would let any script in the
webview read any path the fs scope allows, which is broader than "files the user
picked". So the dialog plugin is used as intended and the fs plugin's role is
served by the scoped grant commands. `tauri-plugin-fs` appears in `Cargo.lock`
only as a transitive dependency of the dialog plugin; it is not registered and
no `fs:*` permission is granted.

Recent files live Rust-side in `<app data dir>/recent-recordings.json`
(`src-tauri/src/recent.rs`; app data dir = `com.krilliac.sonder.observatory`
under the OS data dir). Only paths that were granted (dialog / `--open`) are
recorded. The webview sees `{ id, name, kind, available }` with an opaque
FNV-1a id and can only re-open ids from that list, so recent files do not widen
the read surface.

## Tauri changes

- New commands `list_recent_recordings`, `open_recent_recording`,
  `clear_recent_recordings` (registered in `build.rs` `APP_COMMANDS`).
- `capabilities/main-window.json`: now only the 7 app commands, `local: true`.
  Removed `core:app:allow-version`, `core:event:allow-listen/unlisten`,
  `core:window:allow-set-title` (nothing in `src/` uses them; re-add
  individually if a feature needs them).
- Icons: `src-tauri/icons/app-icon.svg` (observatory dome with open shutter,
  telescope beam and star, token colours). `build.rs` now rasterises this same
  mark (4x4 supersampled) for the placeholder icons instead of the old
  ring; see "Binary icons" above for committing the real `tauri icon` set.
- `src-tauri/.gitignore`: still ignores generated icons, but keeps
  `icons/app-icon.svg`.
- `tauri.conf.json`, `recording.rs`, `Cargo.toml`, `Cargo.lock`: unchanged.

## Verification (box, Linux, rustc/cargo 1.85.1 + webkit2gtk 4.1, Node 20.19)

- `src-tauri/`: `cargo check --locked`, `cargo test --locked` (10 tests: 4
  launch, 2 recording, 4 new recent-list tests), `cargo build --locked`; no
  warnings. Run with the local yoke-derive 0.8.2 pin (see Cargo.lock above),
  both with the `tauri icon` set present and with only the SVG (placeholder
  path).
- `npm run lint` (with `src-tauri/target` excluded), `npm test` (27 files,
  200 tests), `npm run build`.
- New Vitest suites with Tauri mocked (`vi.mock("@tauri-apps/api/core")`):
  `tests/desktop.test.ts` (9 tests: browser inertness, launch info, chunked
  reads, native open, cancel, folder grants, missing events, recent
  list/open/clear, errors) and `tests/desktopUi.test.ts` (6 tests: menu model,
  browser vs desktop wiring, native open replacing the file-input click,
  recent open/clear, `--open` + warnings + error status).
- GUI smoke test under Xvfb with `npm run dev` + the debug binary:
  `--open x.sobs --bogus` shows the `desktop` badge, loads the recording
  (source badge "recording · x.sobs", via the file-input hook), shows the
  `--bogus` warning, and writes `recent-recordings.json`; clicking
  "Open recording…" opens the native GTK dialog with the
  "Observatory recording (.sobs)" filter. IPC works with the reduced
  capability.

Not verified: Windows/macOS runtime and `tauri build` bundling (the Windows CI
job covers `cargo check/test`).

## Launch arguments for several producers (live producer protocol v1)

`src-tauri/src/launch.rs` now accepts:

- `--connect` / `--endpoint` repeatedly, with `ws`, `wss`, `http` or `https`
  URLs. Plain `ws` / `http` only to loopback; URLs with credentials or a
  `token` / `access_token` query parameter are rejected (the warning does not
  echo the URL).
- `--token-file <path>`, an alias of `--capability-file`: read once, at most
  4 KiB, trimmed, never logged. Given right after a `--connect`, the token
  binds to that URL; a token file without a preceding `--connect` is the
  legacy `capability`, applied only when exactly one http(s) URL is launched.
  Tokens are never applied to ws(s) URLs and must be printable ASCII without
  spaces (the same rule as `LiveConnectionManager`; others are rejected with a
  warning at startup).
- `--capability <token>` on the command line is still accepted for older
  frontends (reported as `capability`, with a warning) but is never used as a
  bearer token for a `--connect` URL: command lines are readable by other
  local users. Use `--token-file`.

`LaunchInfo` keeps `connect` (the first accepted URL) and adds `connectAll`
(every accepted URL) and `connectTokens` (the bearer token per URL, or null).
`launchProducers(info)` in `src/integrations/desktop.ts` turns that into
`LiveConnectionManager.add()` inputs, and accepts launch info from older
shells that only report `connect`. Rust unit tests in `launch.rs` cover
repeatable `--connect`, the URL policy, token binding, the single-URL
fallback, ws refusal and the token-file limits.

## Follow-ups (not in this branch)

- `--connect` is applied since PR #17 (`ObservatoryApp.connectLive()`, `--open`
  wins when both are given) for the first URL. Connecting every `connectAll`
  URL through `LiveConnectionManager` with its token is renderer/UX work
  (`src/integrations/desktopUi.ts`, `src/renderer/`). `--session` is not
  applied to live connections.
- Drag-and-drop of recordings onto the window (HTML5 DnD works because
  `dragDropEnabled` is false; needs an app hook).
