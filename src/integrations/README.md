# Integrations

Consumer-side embedding and standalone launch boundaries.

- `desktop.ts`: Tauri bridge (launch args, native recording picker, chunked
  reads). Safe to import in a plain browser; `isDesktop()` is false there.
- `mode.ts`: "desktop" vs "browser" runtime mode, shown as a header badge
  (`#mode-badge`, set up in `src/renderer/main.ts`).

Flutter embedding is not implemented yet. See [source workspace](../README.md).
