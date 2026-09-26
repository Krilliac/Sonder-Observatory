//! Recently opened recordings (desktop only).
//!
//! The list lives on the Rust side, in `<app data dir>/recent-recordings.json`,
//! and only ever contains paths the user chose in the native dialog or passed
//! with `--open`. The webview sees an opaque id and a display name per entry,
//! never the absolute path, and can only ask to re-open an id from this list.
//! So "recent files" does not widen the read surface beyond what the user
//! already granted.

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use crate::recording::GrantKind;

/// Entries kept in the list.
pub const MAX_RECENT: usize = 10;
/// Refuse to parse a recent list larger than this (it should be tiny).
const MAX_FILE_BYTES: u64 = 64 * 1024;
const FILE_NAME: &str = "recent-recordings.json";

/// What the frontend sees for one recent recording.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecentRecording {
    /// Opaque, stable id derived from the path (FNV-1a, hex).
    pub id: String,
    pub name: String,
    pub kind: GrantKind,
    /// False if the path no longer exists; the UI greys it out.
    pub available: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct OnDisk {
    version: u32,
    paths: Vec<PathBuf>,
}

#[derive(Debug, Default)]
pub struct RecentList {
    file: Option<PathBuf>,
    paths: Mutex<Vec<PathBuf>>,
}

/// FNV-1a 64-bit; ids only need to be stable and unguessable-enough to not be paths.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

pub fn recent_id(path: &Path) -> String {
    format!("recent-{:016x}", fnv1a(path.to_string_lossy().as_bytes()))
}

fn describe(path: &Path) -> RecentRecording {
    // Mirrors `Grants::grant`: a folder or its `manifest.json` is a session folder.
    let is_manifest = path.file_name().is_some_and(|n| n == "manifest.json");
    let shown = if is_manifest { path.parent().unwrap_or(path) } else { path };
    let kind = if is_manifest || path.is_dir() { GrantKind::Folder } else { GrantKind::File };
    RecentRecording {
        id: recent_id(path),
        name: shown
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "recording".into()),
        kind,
        available: path.exists(),
    }
}

impl RecentList {
    /// Load from `<dir>/recent-recordings.json`. A missing or corrupt file
    /// yields an empty list; `None` keeps the list in memory only.
    pub fn load(dir: Option<PathBuf>) -> Self {
        let file = dir.map(|d| d.join(FILE_NAME));
        let paths = file
            .as_deref()
            .and_then(|f| {
                let meta = fs::metadata(f).ok()?;
                if meta.len() > MAX_FILE_BYTES {
                    return None;
                }
                serde_json::from_slice::<OnDisk>(&fs::read(f).ok()?).ok()
            })
            .map(|d| {
                let mut p = d.paths;
                p.retain(|p| p.is_absolute());
                p.dedup();
                p.truncate(MAX_RECENT);
                p
            })
            .unwrap_or_default();
        Self { file, paths: Mutex::new(paths) }
    }

    /// Record a path that was just granted as most recent. Call this only
    /// after `Grants::grant` succeeded for the same path.
    pub fn touch(&self, selected: &Path) -> Result<(), String> {
        let path = fs::canonicalize(selected).map_err(|e| format!("cannot remember recording: {e}"))?;
        let snapshot = {
            let mut paths = self.paths.lock().map_err(|_| "recent lock poisoned")?;
            paths.retain(|p| p != &path);
            paths.insert(0, path);
            paths.truncate(MAX_RECENT);
            paths.clone()
        };
        self.save(snapshot)
    }

    pub fn list(&self) -> Result<Vec<RecentRecording>, String> {
        let paths = self.paths.lock().map_err(|_| "recent lock poisoned")?;
        Ok(paths.iter().map(|p| describe(p)).collect())
    }

    /// Resolve an id from [`Self::list`] back to its path.
    pub fn resolve(&self, id: &str) -> Result<PathBuf, String> {
        let paths = self.paths.lock().map_err(|_| "recent lock poisoned")?;
        paths
            .iter()
            .find(|p| recent_id(p) == id)
            .cloned()
            .ok_or_else(|| "unknown recent recording".into())
    }

    pub fn clear(&self) -> Result<(), String> {
        self.paths.lock().map_err(|_| "recent lock poisoned")?.clear();
        self.save(Vec::new())
    }

    fn save(&self, paths: Vec<PathBuf>) -> Result<(), String> {
        let Some(file) = &self.file else { return Ok(()) };
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("cannot save recent list: {e}"))?;
        }
        let body = serde_json::to_vec_pretty(&OnDisk { version: 1, paths }).map_err(|e| e.to_string())?;
        fs::write(file, body).map_err(|e| format!("cannot save recent list: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sobs-recent-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(d).unwrap()
    }

    #[test]
    fn touch_dedupes_caps_and_persists() {
        let d = tmp("persist");
        let rec = d.join("a.sobs");
        fs::write(&rec, b"{}").unwrap();
        let list = RecentList::load(Some(d.clone()));
        for i in 0..(MAX_RECENT + 3) {
            let gone = d.join(format!("gone-{i}.sobs"));
            fs::write(&gone, b"{}").unwrap();
            list.touch(&gone).unwrap();
            fs::remove_file(&gone).unwrap();
        }
        assert!(list.touch(&d.join("never-existed.sobs")).is_err());
        list.touch(&rec).unwrap();
        list.touch(&rec).unwrap();
        let items = list.list().unwrap();
        assert_eq!(items.len(), MAX_RECENT);
        assert_eq!(items[0].name, "a.sobs");
        assert!(items[0].available);
        assert!(!items[1].available);
        assert_eq!(items[0].kind, GrantKind::File);

        let reloaded = RecentList::load(Some(d.clone()));
        assert_eq!(reloaded.list().unwrap(), items);
        assert_eq!(reloaded.resolve(&items[0].id).unwrap(), rec);
        assert!(reloaded.resolve("recent-0000000000000000").is_err());

        reloaded.clear().unwrap();
        assert!(RecentList::load(Some(d.clone())).list().unwrap().is_empty());
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn ignores_corrupt_or_relative_entries() {
        let d = tmp("corrupt");
        fs::write(d.join(FILE_NAME), b"not json").unwrap();
        assert!(RecentList::load(Some(d.clone())).list().unwrap().is_empty());
        fs::write(d.join(FILE_NAME), br#"{"version":1,"paths":["relative/x.sobs"]}"#).unwrap();
        assert!(RecentList::load(Some(d.clone())).list().unwrap().is_empty());
        assert!(RecentList::load(None).list().unwrap().is_empty());
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn manifest_entries_show_as_folders() {
        let d = tmp("manifest");
        fs::create_dir_all(d.join("session")).unwrap();
        fs::write(d.join("session/manifest.json"), b"{}").unwrap();
        let list = RecentList::load(None);
        list.touch(&d.join("session/manifest.json")).unwrap();
        list.touch(&d.join("session")).unwrap();
        let items = list.list().unwrap();
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|r| r.name == "session" && r.kind == GrantKind::Folder && r.available));
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn ids_do_not_leak_paths() {
        let id = recent_id(Path::new("/home/user/secret/run.sobs"));
        assert!(id.starts_with("recent-"));
        assert!(!id.contains("secret"));
    }
}
