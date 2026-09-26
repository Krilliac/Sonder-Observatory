//! Sonder Observatory desktop shell (Tauri v2).
//!
//! The shell only hosts the web renderer and adds a deliberately small native
//! surface (see `capabilities/main-window.json`):
//!
//! - `get_launch_args`      validated `--connect/--session/--capability(-file)/--open`
//! - `pick_recording`       native open dialog (tauri-plugin-dialog, Rust side) -> read grant
//! - `list_recording_entries` / `read_recording_entry`  read-only access to granted recordings
//! - `list_recent_recordings` / `open_recent_recording` / `clear_recent_recordings`
//!   recently granted recordings, persisted in the app data dir (see `recent.rs`)
//! - `save_export`          native save dialog (Rust side) + write of one export file (see `export.rs`)
//!
//! No shell, process, HTTP, fs-plugin, or webview-side dialog access is exposed.

mod export;
mod launch;
mod recent;
mod recording;

use export::SavedFile;
use launch::LaunchArgs;
use recent::{RecentList, RecentRecording};
use recording::{Grants, RecordingEntry, RecordingGrant};
use serde::Serialize;
use std::path::Path;
use tauri::{ipc::Response, AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// Launch arguments plus the grant for `--open`, if any.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchInfo {
    #[serde(flatten)]
    args: LaunchArgs,
    open: Option<RecordingGrant>,
}

struct AppState {
    launch: LaunchInfo,
    grants: Grants,
    recent: RecentList,
}

impl AppState {
    /// Grant a user-chosen path and remember it as recent. A failure to
    /// persist the recent list never blocks opening the recording.
    fn grant_and_remember(&self, path: &Path) -> Result<RecordingGrant, String> {
        let grant = self.grants.grant(path)?;
        if let Err(e) = self.recent.touch(path) {
            eprintln!("sonder-observatory: {e}");
        }
        Ok(grant)
    }
}

#[tauri::command]
fn get_launch_args(state: State<'_, AppState>) -> LaunchInfo {
    state.launch.clone()
}

/// Show a native dialog. `folder = true` picks a session folder; otherwise a
/// recording file (`manifest.json` grants its folder). Returns `None` if cancelled.
#[tauri::command]
async fn pick_recording(
    app: AppHandle,
    state: State<'_, AppState>,
    folder: Option<bool>,
) -> Result<Option<RecordingGrant>, String> {
    let dialog = app.dialog().file().set_title("Open Observatory recording");
    let picked = if folder.unwrap_or(false) {
        dialog.blocking_pick_folder()
    } else {
        dialog
            .add_filter("Observatory recording (.sobs)", &["sobs"])
            .add_filter("NDJSON / JSON", &["ndjson", "jsonl", "json"])
            .add_filter("All files", &["*"])
            .blocking_pick_file()
    };
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    state.grant_and_remember(&path).map(Some)
}

#[tauri::command]
fn list_recording_entries(state: State<'_, AppState>, grant: String) -> Result<Vec<RecordingEntry>, String> {
    state.grants.list(&grant)
}

/// Returns raw bytes (an `ArrayBuffer` in JS). Read large files in chunks via
/// `offset` / `maxBytes` (each call is capped at 16 MiB).
#[tauri::command]
fn read_recording_entry(
    state: State<'_, AppState>,
    grant: String,
    entry: Option<String>,
    offset: Option<u64>,
    max_bytes: Option<u64>,
) -> Result<Response, String> {
    state
        .grants
        .read(&grant, entry.as_deref(), offset.unwrap_or(0), max_bytes)
        .map(Response::new)
}

#[tauri::command]
fn list_recent_recordings(state: State<'_, AppState>) -> Result<Vec<RecentRecording>, String> {
    state.recent.list()
}

/// Re-grant a recording from the recent list. Only ids returned by
/// `list_recent_recordings` resolve; the webview cannot name arbitrary paths.
#[tauri::command]
fn open_recent_recording(state: State<'_, AppState>, id: String) -> Result<RecordingGrant, String> {
    let path = state.recent.resolve(&id)?;
    state.grant_and_remember(&path)
}

#[tauri::command]
fn clear_recent_recordings(state: State<'_, AppState>) -> Result<(), String> {
    state.recent.clear()
}

/// Show a native save dialog and write `content` (UTF-8) to the chosen file.
/// The webview only suggests a file name and extension filters; the written
/// path is always the one the user picked. Returns `None` if cancelled.
#[tauri::command]
async fn save_export(
    app: AppHandle,
    suggested_name: String,
    content: String,
    filter_name: Option<String>,
    extensions: Option<Vec<String>>,
) -> Result<Option<SavedFile>, String> {
    export::check_size(&content)?;
    let exts = export::sanitize_extensions(&extensions.unwrap_or_default());
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Export from Sonder Observatory")
        .set_file_name(export::sanitize_file_name(&suggested_name));
    if !exts.is_empty() {
        let refs: Vec<&str> = exts.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(export::sanitize_filter_name(filter_name.as_deref()), &refs);
    }
    let Some(picked) = dialog.blocking_save_file() else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    export::write_export(&path, &content).map(Some)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let raw = launch::parse(std::env::args().skip(1));

    tauri::Builder::default()
        // Registered for Rust-side use only; no `dialog:*` permission is granted.
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let mut args = launch::validate(&raw);
            let data_dir = match app.path().app_data_dir() {
                Ok(d) => Some(d),
                Err(e) => {
                    args.warnings.push(format!("recent recordings will not be saved: {e}"));
                    None
                }
            };
            let mut state = AppState {
                launch: LaunchInfo { args, open: None },
                grants: Grants::default(),
                recent: RecentList::load(data_dir),
            };
            if let Some(p) = raw.open.as_deref() {
                match state.grant_and_remember(p) {
                    Ok(g) => state.launch.open = Some(g),
                    Err(e) => state.launch.args.warnings.push(format!("--open rejected: {e}")),
                }
            }
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_launch_args,
            pick_recording,
            list_recording_entries,
            read_recording_entry,
            list_recent_recordings,
            open_recent_recording,
            clear_recent_recordings,
            save_export
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sonder Observatory");
}
