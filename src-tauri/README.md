# src-tauri — Sonder Observatory desktop shell

Tauri v2 shell around the Vite web renderer (roadmap Milestone 1). The web app
stays the source of truth; this crate only hosts it and adds a small,
least-privilege native surface. See `docs/ARCHITECTURE.md`,
`docs/INTEGRATION.md`, and `docs/SECURITY_PRIVACY.md`.

## Layout

| Path | Purpose |
|---|---|
| `tauri.conf.json` | window, CSP, bundle; `devUrl` = Vite dev server, `frontendDist` = `../dist` |
| `capabilities/main-window.json` | the **only** permissions granted to the webview |
| `build.rs` | tauri-build with an explicit app-command manifest |
| `icons/` | committed icon set; `icons/app-icon.svg` is the source for `tauri icon` |
| `src/launch.rs` | CLI contract (`--connect`, `--session`, `--capability-file`, `--open`) + validation, unit-tested |
| `src/recording.rs` | read grants for user-chosen recordings (path-escape safe), unit-tested |
| `src/recent.rs` | recent-recordings list persisted in the app data dir (opaque ids, no paths to the webview), unit-tested |
| `src/lib.rs` | commands + app builder |

## Prerequisites

Rust **1.87+** (stable, via rustup) and Node (for the frontend).

**Windows 10/11**
1. Microsoft C++ Build Tools / Visual Studio 2022 with the *Desktop development with C++* workload (MSVC + Windows SDK).
2. WebView2 Runtime (preinstalled on Windows 11 and current Windows 10; otherwise install the Evergreen runtime).
3. `winget install Rustlang.Rustup` then `rustup default stable-msvc`.

**Debian/Ubuntu**
```bash
sudo apt install pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libssl-dev build-essential
```

**macOS**: `xcode-select --install`.

## Commands

From the repo root (`@tauri-apps/cli` and the `"tauri": "tauri"` script are in package.json):

```bash
npm run tauri dev                      # runs `npm run dev`, opens the window on http://127.0.0.1:5173
npx tauri dev -- -- --connect ws://127.0.0.1:49152/telemetry   # 2nd `--` = app args
npm run tauri build                    # runs `npm run build`, bundles ../dist
npm run tauri build -- --debug         # debug bundle, faster
```

Rust-only checks (no Node needed):

```bash
cd src-tauri
cargo check -j 4
cargo test  -j 4
```

`cargo build` without the Tauri CLI produces a dev-mode binary that loads
`devUrl`, so start `npm run dev` first if you run it directly.

## Launch contract

```text
sonder-observatory [--connect|--endpoint <ws-url>] [--session <id>]
                   [--capability-file <path> | --capability <token>]
                   [--open <recording>]
```

- `--connect` accepts `wss://` (any host) or `ws://` to loopback only
  (`127.0.0.1`, `localhost`, `::1`). URLs with embedded credentials are refused.
- `--capability-file` is preferred over `--capability`: process arguments are
  visible to other local processes (docs/INTEGRATION.md). The token is capped at 4 KiB.
- `--open` accepts a recording file (`events.ndjson`, `*.json`, `*.sobs`) or a
  session folder; a `manifest.json` path grants its parent session folder.
- Invalid values never abort startup; they are dropped and reported in `warnings`.

## Command surface (webview → Rust)

| Command | Args | Returns |
|---|---|---|
| `get_launch_args` | — | `{ connect, session, capability, warnings, open: Grant \| null }` |
| `pick_recording` | `{ folder?: boolean }` | `Grant \| null` (native dialog; null = cancelled) |
| `list_recording_entries` | `{ grant }` | `[{ path, size }]` |
| `read_recording_entry` | `{ grant, entry?, offset?, maxBytes? }` | `ArrayBuffer` (≤16 MiB per call) |
| `list_recent_recordings` | — | `[{ id, name, kind, available }]` (most recent first, max 10) |
| `open_recent_recording` | `{ id }` | `Grant` (only ids from the list resolve) |
| `clear_recent_recordings` | — | `null` |

`Grant = { id, name, kind: "file" | "folder" }`. Absolute paths are never sent
to the webview.

## Security model

- The capability grants only the seven app commands above; no `core:*`
  plugin permissions (the renderer uses none) and `local: true` (no remote
  origins). App commands are registered in `build.rs`, so any command not
  listed in the capability is denied.
- No `shell`, `fs`, `http`, `process`, or webview-side `dialog` permissions. The
  dialog plugin is used from Rust only.
- Reads are limited to what the user explicitly chose (dialog, `--open`, or a
  recent entry that was itself chosen that way);
  entries must be plain relative paths and are re-checked after canonicalisation,
  so `..` and symlinks cannot escape. Listing skips symlinks.
- CSP: `script-src 'self'`; `connect-src` limited to IPC, loopback `ws://` and `http://` (live ingest: WebSocket, SSE, NDJSON), and `wss:` / `https:`.
  `withGlobalTauri` is off and `freezePrototype` on.

## Icons

The artwork is `icons/app-icon.svg` (an observatory dome with an open shutter,
a telescope beam and a star, in the design-token palette). The generated set
(32x32, 64x64, 128x128, 128x128@2x, icon.png, icon.ico, icon.icns and the
Windows Square*/Store logos) is committed. To regenerate it after changing the
SVG, run the **Generate lockfiles** workflow on a feature branch with
`icons: true` (and `cargo: false`), or locally:

```bash
npm run tauri icon src-tauri/icons/app-icon.svg
rm -rf src-tauri/icons/android src-tauri/icons/ios   # desktop-only shell
```

The icons are required: `build.rs` no longer generates placeholders, so a
missing file listed in `bundle.icon` (`tauri.conf.json`) fails the build.

## Licenses

Tauri, tauri-build, tauri-plugin-dialog, and wry are `MIT OR Apache-2.0`; tao is
`Apache-2.0`. The rest of the tree is permissive (MIT/Apache/BSD/ISC/Zlib/Unicode),
apart from five MPL-2.0 crates (`cssparser`, `cssparser-macros`, `selectors`,
`dtoa-short`, `option-ext`), which come in through standard Tauri dependencies.
MPL-2.0 is file-level copyleft and only matters if those files are modified.

## Dependency note

`Cargo.lock` is committed and CI runs `cargo check/test --locked` on stable.
It is what `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback cargo
generate-lockfile` produces. The declared `rust-version` is **1.87** because
`yoke-derive` 0.8.3 in that lockfile uses `str::from_utf8` (stable in 1.87)
while claiming an older MSRV (docs/DECISIONS.md, 2026-09-26). To build on an
older toolchain anyway, run `cargo update -p yoke-derive --precise 0.8.2`
locally (adds `synstructure` 0.13.2) and do not commit the result.
