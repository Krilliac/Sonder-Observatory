# Integration notes — `feat/tauri-shell`

This branch only adds `src-tauri/` and this file. The lead needs to make the
following changes outside `src-tauri/` when merging.

## 1. package.json

```jsonc
{
  "scripts": {
    "tauri": "tauri"
  },
  "dependencies": {
    "@tauri-apps/api": "^2"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2"
  }
}
```

Both are `MIT OR Apache-2.0`. `@tauri-apps/plugin-dialog` is **not** needed
because the dialog runs from Rust.

## 2. Vite config expectations

`src-tauri/tauri.conf.json` assumes:

- The dev server is on `http://127.0.0.1:5173`, matching the current
  `vite.config.ts` (`server.host = 127.0.0.1`). Using the IP avoids `localhost`
  resolving to `::1` on Windows. Please add `strictPort: true` so Vite fails
  instead of silently moving to another port. If you change the host or port,
  update `build.devUrl`.
- `base: "./"` (already set) works with Tauri's asset protocol.
- `npm run build` writes to `dist/` (`build.frontendDist = "../dist"`).
- `npm run dev` / `npm run build` exist (`beforeDevCommand` / `beforeBuildCommand`).
- Recommended: `clearScreen: false`, `envPrefix: ['VITE_', 'TAURI_ENV_']`, and
  `build.target` of at least `chrome105` / `safari13` for WebView2 and WebKit.
- The CSP is `script-src 'self'`, so no inline scripts and no `eval`. Inline
  styles are allowed. WebSocket `connect-src` covers loopback `ws://` (including
  Vite HMR) and any `wss:`.

## 3. Frontend hook (lead owns `src/`)

This is a suggested `src/integrations/desktop.ts`. It's a no-op in a plain browser
or the Flutter WebView:

```ts
import { invoke, isTauri } from '@tauri-apps/api/core';

export interface RecordingGrant { id: string; name: string; kind: 'file' | 'folder' }
export interface LaunchInfo {
  connect: string | null;     // first validated --connect URL (ws, wss, http, https)
  connectAll?: string[];      // every validated --connect URL, in order
  connectTokens?: (string | null)[]; // bearer token per connectAll entry; memory only, never log
  session: string | null;
  capability: string | null;  // token not bound to a URL; keep it in memory and never log it
  open: RecordingGrant | null;
  warnings: string[];         // show these in the UI
}

export const isDesktop = () => isTauri();

export async function getLaunchInfo(): Promise<LaunchInfo | null> {
  return isTauri() ? invoke<LaunchInfo>('get_launch_args') : null;
}

export async function pickRecording(folder = false): Promise<RecordingGrant | null> {
  return invoke<RecordingGrant | null>('pick_recording', { folder });
}

export async function listRecordingEntries(grant: string) {
  return invoke<{ path: string; size: number }[]>('list_recording_entries', { grant });
}

/** Read a whole entry in 16 MiB chunks. `entry` is omitted for file grants. */
export async function readRecordingEntry(grant: string, entry?: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const CHUNK = 16 * 1024 * 1024;
  for (let offset = 0; ; offset += CHUNK) {
    const buf = new Uint8Array(await invoke<ArrayBuffer>('read_recording_entry', { grant, entry, offset, maxBytes: CHUNK }));
    parts.push(buf);
    if (buf.byteLength < CHUNK) break;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}
```

At startup:

1. `const info = await getLaunchInfo()`.
2. Connect every `info.connectAll` URL, each with its own `connectTokens[i]`
   as a bearer token (`launchProducers(info)` builds the
   `LiveConnectionManager.add()` inputs). Launch argument rules: see
   [desktop notes](desktop.md), "Launch arguments for several producers".
3. If `info.open` is set, load it. For a folder grant, read `manifest.json`, then `events.ndjson`.
4. Surface `info.warnings`.

The "Open recording" button calls `pickRecording()` on desktop. In the browser,
fall back to `<input type="file">` / drag-and-drop. Window drag-drop is disabled
in the shell (`dragDropEnabled: false`), so HTML5 drag-and-drop works in the webview too.

If you want different command names or payloads, tell the shell owner. Adding a
command means updating `build.rs` `APP_COMMANDS` and `capabilities/main-window.json`.

## 4. CI job (GitHub Actions)

This verifies the shell on Windows, which is the target platform. Rust-only;
it doesn't need Node or `dist/`:

```yaml
  tauri-check:
    name: Tauri shell (windows)
    runs-on: windows-latest
    defaults:
      run:
        working-directory: src-tauri
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri
      - run: cargo check -j 4
      - run: cargo test -j 4
```

For a Linux job, add this step before the cargo steps:
`sudo apt-get update && sudo apt-get install -y pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libssl-dev`.
If you want a full bundle later, add `actions/setup-node`, `npm ci`, and
`npx tauri build --debug` on `windows-latest`. The artifact lands at
`src-tauri/target/debug/bundle/{msi,nsis}/`.

## 5. Root `.gitignore`

This already covers `/src-tauri/target/`. `src-tauri/.gitignore` additionally
ignores `gen/schemas/` and the placeholder `icons/`.

## 6. Verified on this branch

These were run on Linux (rustc 1.85.1, webkit2gtk 4.1):

- `cargo check`: clean, no warnings
- `cargo test`: 6 tests pass (CLI parsing/URL policy, grant path-escape checks)
- `cargo build`: debug binary builds
- Not yet run: Windows MSVC build, `tauri dev`, and `tauri build`, because the
  frontend isn't on main yet and no Windows machine was reachable. The CI job
  in §4 covers the Windows build.

## Open items

- Pop-out/reattach from Flutter (Milestone 4). A single-instance plugin and a
  deep-link or IPC handoff can be added then. The current CLI contract
  carries one or more `--connect` URLs, per-URL `--token-file`, `--session`
  and `--open`.
- Real icons (see `src-tauri/README.md`).
- There's no LICENSE file yet (`package.json` says `UNLICENSED`). `Cargo.toml`
  has no `license` field; set it and the bundle metadata once a license is chosen.
