# src/export — export & reports

Pure renderers over a session's events plus one save helper.

| File | Purpose |
| --- | --- |
| `filter.ts` | `filterEvents(events, range)`: class / text / time window (same semantics as the event table) |
| `report.ts` | `buildReport()`: metrics (`deriveMetrics`), findings with resolved evidence (`runDiagnostics`), topology scene (`deriveTopology` → `layoutTopology` → `buildScene`), timeline density snapshot (`bucketize`) |
| `html.ts` | Self-contained HTML report (inline CSS + SVG, no scripts, CSP `default-src 'none'`) |
| `svg.ts` | Static topology / timeline SVG, HTML escaping |
| `markdown.ts` | PR / issue summary (GFM, fields clipped, hard 65 536-char budget with truncation marker) |
| `json.ts` | Findings + metrics JSON (`sonder.observatory.export/1`) |
| `sobs.ts` | Selected range back to `.sobs` NDJSON (`serializeRecording`) |
| `sensitivity.ts` | Recording hygiene: `assessExportSensitivity()` (full text / tool payloads), warning text, `SensitiveExportError` |
| `confirmDialog.ts` | Modal `<dialog>` warning (`confirmSensitiveExport`) for `exportWithConfirmation` |
| `save.ts` | Desktop: native save dialog via `save_export`; browser: Blob download |
| `index.ts` | `renderExport(format, input)`, `exportSession(format, input, { acknowledgeSensitive })`, `exportWithConfirmation(format, input, confirm)` |

Only public APIs of `query/metrics`, `diagnostics`, `topology`, `recording/sobs`
and `renderer/timelineModel` are used; nothing here mutates events.
Tests: `tests/export/` (markdown snapshot in `tests/export/__snapshots__/`).
Wiring notes for the lead: `docs/integration/export.md`.
