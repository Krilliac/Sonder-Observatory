//! Saving exports (HTML report, markdown, JSON, `.sobs`) chosen by the user.
//!
//! The webview never names a path. `save_export` (lib.rs) shows the native save
//! dialog on the Rust side and writes only to the file the user picked there;
//! the helpers here sanitise what the webview *does* send (a suggested file
//! name and extension filters) and perform the bounded write.

use serde::Serialize;
use std::{fs, path::Path};

/// Largest export the shell will write (text reports and filtered recordings).
pub const MAX_EXPORT_BYTES: usize = 512 * 1024 * 1024;
const MAX_NAME_CHARS: usize = 120;
const MAX_FILTER_CHARS: usize = 60;
const MAX_EXTENSIONS: usize = 8;

/// What the frontend learns about a saved file: its name only, never the path.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedFile {
    pub name: String,
}

/// A bare file name for the dialog's default: no directories, no control or
/// reserved characters, no leading dots. Falls back to `export`.
pub fn sanitize_file_name(suggested: &str) -> String {
    let base = suggested.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') { '_' } else { c })
        .take(MAX_NAME_CHARS)
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.').trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        "export".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Extension filters: ASCII alphanumerics only (1..=10 chars), deduplicated, at most 8.
pub fn sanitize_extensions(extensions: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for e in extensions {
        let e = e.trim().trim_start_matches('.').to_ascii_lowercase();
        if !e.is_empty() && e.len() <= 10 && e.chars().all(|c| c.is_ascii_alphanumeric()) && !out.contains(&e) {
            out.push(e);
        }
        if out.len() == MAX_EXTENSIONS {
            break;
        }
    }
    out
}

/// Label for the dialog's filter; control characters dropped, length bounded.
pub fn sanitize_filter_name(name: Option<&str>) -> String {
    let s: String = name.unwrap_or("").chars().filter(|c| !c.is_control()).take(MAX_FILTER_CHARS).collect();
    let s = s.trim();
    if s.is_empty() {
        "Export".to_string()
    } else {
        s.to_string()
    }
}

pub fn check_size(content: &str) -> Result<(), String> {
    if content.len() > MAX_EXPORT_BYTES {
        Err(format!("export is {} bytes; the limit is {} bytes", content.len(), MAX_EXPORT_BYTES))
    } else {
        Ok(())
    }
}

/// Writes `content` (UTF-8) to `path`, the dialog's result, replacing any
/// existing file (the native dialog already asked to confirm overwrites).
pub fn write_export(path: &Path, content: &str) -> Result<SavedFile, String> {
    check_size(content)?;
    if path.is_dir() {
        return Err("the chosen path is a folder".to_string());
    }
    fs::write(path, content.as_bytes()).map_err(|e| format!("could not write export: {e}"))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(SavedFile { name })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_are_bare_and_safe() {
        assert_eq!(sanitize_file_name("observatory-ses_1-report.html"), "observatory-ses_1-report.html");
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_file_name("C:\\Windows\\evil.md"), "evil.md");
        assert_eq!(sanitize_file_name("a<b>:c\"d|e?f*g.json"), "a_b__c_d_e_f_g.json");
        assert_eq!(sanitize_file_name("..."), "export");
        assert_eq!(sanitize_file_name(""), "export");
        assert_eq!(sanitize_file_name(".hidden"), "hidden");
        assert_eq!(sanitize_file_name("x\u{0}y\nz.sobs"), "x_y_z.sobs");
        assert_eq!(sanitize_file_name(&"a".repeat(500)).chars().count(), MAX_NAME_CHARS);
    }

    #[test]
    fn extensions_are_alphanumeric_and_bounded() {
        let v = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(sanitize_extensions(&v(&["html", ".MD", "json", "html"])), v(&["html", "md", "json"]));
        assert_eq!(sanitize_extensions(&v(&["*", "../x", "", "toolongextension", "s obs"])), Vec::<String>::new());
        assert_eq!(sanitize_extensions(&v(&["a", "b", "c", "d", "e", "f", "g", "h", "i"])).len(), MAX_EXTENSIONS);
    }

    #[test]
    fn filter_names_are_bounded() {
        assert_eq!(sanitize_filter_name(None), "Export");
        assert_eq!(sanitize_filter_name(Some("  HTML report\n")), "HTML report");
        assert_eq!(sanitize_filter_name(Some(&"x".repeat(200))).len(), MAX_FILTER_CHARS);
    }

    #[test]
    fn writes_only_the_chosen_file() {
        let dir = std::env::temp_dir().join(format!("sobs-export-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("report.html");
        fs::write(&path, "old").unwrap();
        let saved = write_export(&path, "<!doctype html>\n").unwrap();
        assert_eq!(saved, SavedFile { name: "report.html".into() });
        assert_eq!(fs::read_to_string(&path).unwrap(), "<!doctype html>\n");
        assert!(write_export(&dir, "x").is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_oversized_content() {
        assert!(check_size("small").is_ok());
        let big = "x".repeat(MAX_EXPORT_BYTES + 1);
        assert!(check_size(&big).is_err());
    }
}
