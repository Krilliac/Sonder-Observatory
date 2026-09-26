//! Sonder Observatory desktop shell (Tauri v2).
//!
//! The shell only hosts the web renderer and adds a deliberately small native
//! surface (see `capabilities/main-window.json`):
//!
//! - `get_launch_args`      validated `--connect/--session/--capability(-file)/--open`
//! - `pick_recording`       native open dialog -> read grant for that selection
//! - `list_recording_entries` / `read_recording_entry`  read-only access to granted recordings
//!
//! No shell, process, HTTP, or general filesystem access is exposed to the webview.

mod launch;
mod recording;

use launch::LaunchArgs;
use recording::{Grants, RecordingEntry, RecordingGrant};
use serde::Serialize;
use tauri::{ipc::Response, AppHandle, State};
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
            .add_filter("Observatory recording", &["json", "ndjson", "sobs"])
            .add_filter("All files", &["*"])
            .blocking_pick_file()
    };
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    state.grants.grant(&path).map(Some)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let raw = launch::parse(std::env::args().skip(1));
    let grants = Grants::default();
    let mut args = launch::validate(&raw);
    let open = raw.open.as_deref().and_then(|p| match grants.grant(p) {
        Ok(g) => Some(g),
        Err(e) => {
            args.warnings.push(format!("--open rejected: {e}"));
            None
        }
    });

    tauri::Builder::default()
        // Registered for Rust-side use only; no `dialog:*` permission is granted.
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { launch: LaunchInfo { args, open }, grants })
        .invoke_handler(tauri::generate_handler![
            get_launch_args,
            pick_recording,
            list_recording_entries,
            read_recording_entry
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sonder Observatory");
}
