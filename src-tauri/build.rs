//! Build script: runs tauri-build with an explicit app command manifest so that
//! *only* commands granted in `capabilities/` are callable from the webview.
//!
//! The icon set in `icons/` is generated from `icons/app-icon.svg` with
//! `tauri icon` (the lockfiles workflow's `icons` input) and committed.

/// App commands exposed to the frontend. Listing them here makes tauri-build
/// generate `allow-<name>` / `deny-<name>` permissions and enforces ACL checks
/// on them (without this, app commands are allowed by default).
const APP_COMMANDS: &[&str] = &[
    "get_launch_args",
    "pick_recording",
    "list_recording_entries",
    "read_recording_entry",
    "list_recent_recordings",
    "open_recent_recording",
    "clear_recent_recordings",
    "save_export",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
