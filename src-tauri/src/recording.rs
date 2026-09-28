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

    /// The grant root and the checked, canonical path of `entry` in it.
    fn resolve(&self, id: &str, entry: Option<&str>) -> Result<(PathBuf, PathBuf), String> {
        let map = self.map.lock().map_err(|_| "grant lock poisoned")?;
        let grant = map.get(id).ok_or("unknown recording grant")?;
        let entry = entry.unwrap_or("").trim();
        let path: PathBuf = match grant.kind {
            GrantKind::File if entry.is_empty() => grant.root.clone(),
            GrantKind::File => return Err("file recordings have no entries".into()),
            GrantKind::Folder => {
                let rel = safe_relative(entry)?;
                let joined = fs::canonicalize(grant.root.join(rel))
                    .map_err(|e| format!("cannot open entry: {e}"))?;
                // Re-check after canonicalisation so symlinks cannot escape.
                if !joined.starts_with(&grant.root) || !joined.is_file() {
                    return Err("entry is outside the recording or not a file".into());
                }
                joined
            }
        };
        Ok((grant.root.clone(), path))
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
        self.read_with(id, entry, offset, max_bytes, |_| ())
    }

    /// `read`, with a hook that runs between the path check and the open
    /// (tests use it to swap the path in that window).
    fn read_with(
        &self,
        id: &str,
        entry: Option<&str>,
        offset: u64,
        max_bytes: Option<u64>,
        before_open: impl FnOnce(&Path),
    ) -> Result<Vec<u8>, String> {
        let (root, path) = self.resolve(id, entry)?;
        let len = max_bytes.unwrap_or(MAX_CHUNK_BYTES).min(MAX_CHUNK_BYTES);
        before_open(&path);
        let mut f = open_contained(&root, &path)?;
        f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        f.take(len).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        Ok(buf)
    }
}

/// Opens a path that `resolve` checked, then verifies the open handle: a
/// local writer could swap a directory in the path for a link between the
/// check and the open. After opening, the path must still resolve to itself
/// inside `root`, and the handle must be the same file the path names now
/// (so a swap that was undone right after the open is caught too).
fn open_contained(root: &Path, path: &Path) -> Result<fs::File, String> {
    let f = fs::File::open(path).map_err(|e| format!("cannot read entry: {e}"))?;
    let now = fs::canonicalize(path).map_err(|e| format!("cannot read entry: {e}"))?;
    if now != path || !now.starts_with(root) {
        return Err("entry changed while it was opened".into());
    }
    let opened = f.metadata().map_err(|e| e.to_string())?;
    let named = fs::metadata(&now).map_err(|e| e.to_string())?;
    if !opened.is_file() || !same_file(&opened, &named) {
        return Err("entry changed while it was opened".into());
    }
    Ok(f)
}

#[cfg(unix)]
fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev() && a.ino() == b.ino()
}

/// Stable std has no file id on Windows (`file_index` is unstable), so the
/// handle is compared by size and creation / modification
/// timestamps, which differ between distinct files in practice.
#[cfg(not(unix))]
fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    a.len() == b.len() && a.modified().ok() == b.modified().ok() && a.created().ok() == b.created().ok()
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

    #[cfg(unix)]
    fn link_dir(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn link_dir(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    #[test]
    fn entry_swapped_for_a_link_after_the_check_is_refused() {
        let d = tmp("race");
        fs::create_dir_all(d.join("session/data")).unwrap();
        fs::write(d.join("session/data/events.ndjson"), b"{\"seq\":1}\n").unwrap();
        fs::create_dir_all(d.join("outside/data")).unwrap();
        fs::write(d.join("outside/data/events.ndjson"), b"TOP SECRET\n").unwrap();
        // Probe: without symlink rights (Windows without developer mode) the race cannot be staged.
        if link_dir(&d.join("outside/data"), &d.join("probe")).is_err() {
            eprintln!("SKIPPED entry_swapped_for_a_link_after_the_check_is_refused: cannot create symlinks here");
            let _ = fs::remove_dir_all(d);
            return;
        }
        let g = Grants::default();
        let grant = g.grant(&d.join("session")).unwrap();
        let swap = |_: &Path| {
            fs::rename(d.join("session/data"), d.join("session/data-real")).unwrap();
            link_dir(&d.join("outside/data"), &d.join("session/data")).unwrap();
        };
        let got = g.read_with(&grant.id, Some("data/events.ndjson"), 0, None, swap);
        assert!(got.is_err(), "read through a swapped link returned {:?}", got.map(|b| String::from_utf8_lossy(&b).into_owned()));

        // Swapped for the open and restored before the re-check: the handle is another file.
        let _ = fs::remove_dir(d.join("session/data")).or_else(|_| fs::remove_file(d.join("session/data")));
        fs::rename(d.join("session/data-real"), d.join("session/data")).unwrap();
        let root = fs::canonicalize(d.join("session")).unwrap();
        let path = fs::canonicalize(d.join("session/data/events.ndjson")).unwrap();
        assert!(open_contained(&root, &path).is_ok());
        let outside = fs::canonicalize(d.join("outside/data/events.ndjson")).unwrap();
        let f = fs::File::open(&outside).unwrap();
        assert!(!same_file(&f.metadata().unwrap(), &fs::metadata(&path).unwrap()));
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
