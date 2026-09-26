//! Read-only access to recordings the user explicitly chose.
//!
//! The webview has no filesystem permission. Instead, a recording becomes
//! readable only after the user picks it in the native dialog or passes it via
//! `--open`. Each selection is stored as a *grant*; reads must name a grant and
//! (for session folders) a relative entry that stays inside the granted root.
//!
//! Recording layouts (docs/ARCHITECTURE.md):
//! - session folder: `manifest.json`, `events.ndjson`, `snapshots/`, `attachments/`
//! - single file: `events.ndjson`, `*.json`, or a future packaged `*.sobs`
//!
//! Picking a `manifest.json` grants its parent session folder.

use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

/// Largest chunk returned by a single read call.
pub const MAX_CHUNK_BYTES: u64 = 16 * 1024 * 1024;
/// Listing bounds for session folders.
const MAX_ENTRIES: usize = 10_000;
const MAX_DEPTH: usize = 4;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GrantKind {
    File,
    Folder,
}

/// What the frontend learns about a grant. The absolute path is deliberately
/// not exposed; only a display name.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingGrant {
    pub id: String,
    pub name: String,
    pub kind: GrantKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingEntry {
    /// `/`-separated path relative to the grant root (empty for file grants).
    pub path: String,
    pub size: u64,
}

#[derive(Debug)]
struct Grant {
    root: PathBuf,
    kind: GrantKind,
}

#[derive(Debug, Default)]
pub struct Grants {
    next: Mutex<u64>,
    map: Mutex<HashMap<String, Grant>>,
}

impl Grants {
    /// Register a user-selected path. `manifest.json` grants its folder.
    pub fn grant(&self, selected: &Path) -> Result<RecordingGrant, String> {
        let canon = fs::canonicalize(selected)
            .map_err(|e| format!("cannot open recording: {e}"))?;
        let (root, kind) = if canon.is_dir() {
            (canon, GrantKind::Folder)
        } else if canon.file_name().is_some_and(|n| n == "manifest.json") {
            (canon.parent().ok_or("manifest has no parent folder")?.to_path_buf(), GrantKind::Folder)
        } else if canon.is_file() {
            (canon, GrantKind::File)
        } else {
            return Err("recording is neither a file nor a folder".into());
        };
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "recording".into());
        let id = {
            let mut n = self.next.lock().map_err(|_| "grant lock poisoned")?;
            *n += 1;
            format!("rec-{n}")
        };
        self.map
            .lock()
            .map_err(|_| "grant lock poisoned")?
            .insert(id.clone(), Grant { root, kind });
        Ok(RecordingGrant { id, name, kind })
    }

    fn resolve(&self, id: &str, entry: Option<&str>) -> Result<PathBuf, String> {
        let map = self.map.lock().map_err(|_| "grant lock poisoned")?;
        let grant = map.get(id).ok_or("unknown recording grant")?;
        let entry = entry.unwrap_or("").trim();
        match grant.kind {
            GrantKind::File if entry.is_empty() => Ok(grant.root.clone()),
            GrantKind::File => Err("file recordings have no entries".into()),
            GrantKind::Folder => {
                let rel = safe_relative(entry)?;
                let joined = fs::canonicalize(grant.root.join(rel))
                    .map_err(|e| format!("cannot open entry: {e}"))?;
                // Re-check after canonicalisation so symlinks cannot escape.
                if !joined.starts_with(&grant.root) || !joined.is_file() {
                    return Err("entry is outside the recording or not a file".into());
                }
                Ok(joined)
            }
        }
    }

    pub fn list(&self, id: &str) -> Result<Vec<RecordingEntry>, String> {
        let (root, kind) = {
            let map = self.map.lock().map_err(|_| "grant lock poisoned")?;
            let g = map.get(id).ok_or("unknown recording grant")?;
            (g.root.clone(), g.kind)
        };
        if kind == GrantKind::File {
            let size = fs::metadata(&root).map_err(|e| e.to_string())?.len();
            return Ok(vec![RecordingEntry { path: String::new(), size }]);
        }
        let mut out = Vec::new();
        walk(&root, &root, 0, &mut out)?;
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    /// Read up to `max_bytes` (capped at [`MAX_CHUNK_BYTES`]) from `offset`.
    pub fn read(&self, id: &str, entry: Option<&str>, offset: u64, max_bytes: Option<u64>) -> Result<Vec<u8>, String> {
        let path = self.resolve(id, entry)?;
        let len = max_bytes.unwrap_or(MAX_CHUNK_BYTES).min(MAX_CHUNK_BYTES);
        let mut f = fs::File::open(&path).map_err(|e| format!("cannot read entry: {e}"))?;
        f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        f.take(len).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        Ok(buf)
    }
}

/// Accept only plain relative paths (no root, prefix, `..`, or `.` tricks).
fn safe_relative(entry: &str) -> Result<PathBuf, String> {
    if entry.is_empty() {
        return Err("folder recordings require an entry path".into());
    }
    let p = Path::new(entry);
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(s) => out.push(s),
            _ => return Err("entry must be a plain relative path".into()),
        }
    }
    Ok(out)
}

fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<RecordingEntry>) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Ok(());
    }
    for item in fs::read_dir(dir).map_err(|e| e.to_string())? {
        if out.len() >= MAX_ENTRIES {
            break;
        }
        let item = item.map_err(|e| e.to_string())?;
        let ft = item.file_type().map_err(|e| e.to_string())?;
        if ft.is_symlink() {
            continue; // never follow links out of the recording
        }
        let path = item.path();
        if ft.is_dir() {
            walk(root, &path, depth + 1, out)?;
        } else if ft.is_file() {
            let rel = path.strip_prefix(root).map_err(|e| e.to_string())?;
            let rel = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
            let size = item.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(RecordingEntry { path: rel, size });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sobs-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("session/snapshots")).unwrap();
        fs::write(d.join("session/manifest.json"), b"{\"schema\":1}").unwrap();
        fs::write(d.join("session/events.ndjson"), b"{\"seq\":1}\n{\"seq\":2}\n").unwrap();
        fs::write(d.join("session/snapshots/s1.json"), b"{}").unwrap();
        fs::write(d.join("secret.txt"), b"nope").unwrap();
        d
    }

    #[test]
    fn manifest_grants_folder_and_blocks_escape() {
        let d = tmp("folder");
        let g = Grants::default();
        let grant = g.grant(&d.join("session/manifest.json")).unwrap();
        assert_eq!(grant.kind, GrantKind::Folder);
        let names: Vec<_> = g.list(&grant.id).unwrap().into_iter().map(|e| e.path).collect();
        assert_eq!(names, ["events.ndjson", "manifest.json", "snapshots/s1.json"]);
        assert_eq!(g.read(&grant.id, Some("events.ndjson"), 0, Some(9)).unwrap(), b"{\"seq\":1}");
        assert_eq!(g.read(&grant.id, Some("events.ndjson"), 10, None).unwrap(), b"{\"seq\":2}\n");
        assert!(g.read(&grant.id, Some("../secret.txt"), 0, None).is_err());
        assert!(g.read(&grant.id, Some(d.join("secret.txt").to_str().unwrap()), 0, None).is_err());
        assert!(g.read(&grant.id, Some("snapshots"), 0, None).is_err());
        assert!(g.read("rec-999", Some("events.ndjson"), 0, None).is_err());
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn file_grant_reads_only_itself() {
        let d = tmp("file");
        let g = Grants::default();
        let grant = g.grant(&d.join("session/events.ndjson")).unwrap();
        assert_eq!(grant.kind, GrantKind::File);
        assert!(g.read(&grant.id, None, 0, None).unwrap().starts_with(b"{\"seq\":1}"));
        assert!(g.read(&grant.id, Some("manifest.json"), 0, None).is_err());
        let _ = fs::remove_dir_all(d);
    }
}
