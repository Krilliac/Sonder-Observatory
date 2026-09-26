# Integrations

Consumer-side embedding and standalone launch boundaries.

- `desktop.ts`: Tauri bridge (launch args, native recording picker, chunked
  reads, recent recordings). Safe to import in a plain browser; `isDesktop()`
  is false there and the helpers are no-ops.
- `desktopUi.ts`: app-shell hook, `mountDesktopIntegration()` called once
  from `src/renderer/main.ts`. Adds the mode badge (`#mode-badge`) and, in the
  desktop shell only, routes "Open recording…" to the native dialog and adds
  the recent-recordings menu (`#recent-select`) plus a status line
  (`#desktop-status`). In a browser the `<input type="file">` stays the open path.
- `mode.ts`: "desktop" vs "browser" runtime mode and badge text.

See [docs/integration/desktop.md](../../docs/integration/desktop.md).
Flutter embedding is not implemented yet. See [source workspace](../README.md).
