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
| `build.rs` | tauri-build with an explicit app-command manifest; synthesises placeholder icons if `icons/` is missing |
| `src/launch.rs` | CLI contract (`--connect`, `--session`, `--capability-file`, `--open`) + validation, unit-tested |
| `src/recording.rs` | read grants for user-chosen recordings (path-escape safe), unit-tested |
| `src/lib.rs` | commands + app builder |

## Prerequisites

Rust **1.85+** (stable, via rustup) and Node (for the frontend).

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

From the repo root, once the lead has added `@tauri-apps/cli` and a `"tauri": "tauri"` script (see `INTEGRATION_NOTES.md`):

```bash
npm run tauri dev                      # runs `npm run dev`, opens the window on http://localhost:5173
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

`Grant = { id, name, kind: "file" | "folder" }`. Absolute paths are never sent
to the webview.

## Security model

- Capabilities grant only: `core:app:allow-version`, event listen/unlisten,
  `core:window:allow-set-title`, and the four commands above. App commands are
  registered in `build.rs`, so any command not listed in the capability is denied.
- No `shell`, `fs`, `http`, `process`, or webview-side `dialog` permissions. The
  dialog plugin is used from Rust only.
- Reads are limited to what the user explicitly chose (dialog or `--open`);
  entries must be plain relative paths and are re-checked after canonicalisation,
  so `..` and symlinks cannot escape. Listing skips symlinks.
- CSP: `script-src 'self'`; `connect-src` limited to IPC, loopback `ws://`, and `wss:`.
  `withGlobalTauri` is off and `freezePrototype` on.

## Icons

`build.rs` writes simple placeholder icons into `icons/` when absent (ignored by
Git) so a fresh checkout builds without binary blobs. For release artwork run
`npm run tauri icon path/to/source.png`, commit `icons/`, and remove `/icons/`
from `src-tauri/.gitignore`.

## Licenses

Tauri, tauri-build, tauri-plugin-dialog, and wry are `MIT OR Apache-2.0`; tao is
`Apache-2.0`. The rest of the tree is permissive (MIT/Apache/BSD/ISC/Zlib/Unicode),
apart from five MPL-2.0 crates (`cssparser`, `cssparser-macros`, `selectors`,
`dtoa-short`, `option-ext`), which come in through standard Tauri dependencies.
MPL-2.0 is file-level copyleft and only matters if those files are modified.

## Dependency note

`Cargo.lock` isn't committed yet, so current stable Rust resolves the latest
Tauri 2.x. If you're on rustc 1.85, resolve with
`CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback cargo generate-lockfile` and
`cargo update -p idna_adapter --precise 1.1.0`, because `yoke-derive` 0.8.3
claims an MSRV it doesn't meet. That resolution was verified with tauri 2.11.6,
tauri-plugin-dialog 2.7.3, and wry 0.55.1. Commit a lockfile from the first
green Windows CI run.
