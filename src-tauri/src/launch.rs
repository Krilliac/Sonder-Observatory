//! Command-line launch contract.
//!
//! Standalone use and the Sonder Flutter "Launch Standalone" / "Pop out" flow
//! (docs/INTEGRATION.md) pass these arguments:
//!
//! ```text
//! sonder-observatory [--connect <url>] [--session <id>]
//!                    [--capability-file <path> | --capability <token>]
//!                    [--open <recording>]
//! ```
//!
//! `--endpoint` is accepted as an alias of `--connect`. Both `--flag value` and
//! `--flag=value` forms work. Invalid values are dropped with a warning rather
//! than aborting startup so the viewer can still open and explain the problem.

use serde::Serialize;
use std::path::PathBuf;
use tauri::Url;

/// Upper bound for a capability token read from a file or argument.
const MAX_CAPABILITY_BYTES: usize = 4096;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RawLaunchArgs {
    pub connect: Option<String>,
    pub session: Option<String>,
    pub capability: Option<String>,
    pub open: Option<PathBuf>,
    pub warnings: Vec<String>,
}

/// Validated launch arguments handed to the frontend (the `open` recording is
/// resolved into a read grant separately, see `recording.rs`).
#[derive(Debug, Default, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchArgs {
    pub connect: Option<String>,
    pub session: Option<String>,
    pub capability: Option<String>,
    pub warnings: Vec<String>,
}

/// Parse `args` (excluding argv[0]).
pub fn parse<I, S>(args: I) -> RawLaunchArgs
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut out = RawLaunchArgs::default();
    let mut it = args.into_iter().map(Into::into).peekable();
    while let Some(arg) = it.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f.to_string(), Some(v.to_string())),
            _ => (arg.clone(), None),
        };
        let known = matches!(
            flag.as_str(),
            "--connect" | "--endpoint" | "--session" | "--capability" | "--capability-file" | "--open"
        );
        if !known {
            // Tauri dev / OS launchers may inject their own args; ignore quietly
            // unless it looks like one of ours.
            if flag.starts_with("--") {
                out.warnings.push(format!("ignored unknown argument {flag}"));
            }
            continue;
        }
        let value = match inline {
            Some(v) => Some(v),
            None => match it.peek() {
                Some(next) if !next.starts_with("--") => it.next(),
                _ => None,
            },
        };
        let Some(value) = value.filter(|v| !v.is_empty()) else {
            out.warnings.push(format!("{flag} requires a value"));
            continue;
        };
        match flag.as_str() {
            "--connect" | "--endpoint" => out.connect = Some(value),
            "--session" => out.session = Some(value),
            "--capability" => {
                out.warnings.push(
                    "--capability exposes the token to other local processes; prefer --capability-file".into(),
                );
                out.capability = Some(value);
            }
            "--capability-file" => match std::fs::read(&value) {
                Ok(bytes) if bytes.len() <= MAX_CAPABILITY_BYTES => {
                    match String::from_utf8(bytes) {
                        Ok(s) => out.capability = Some(s.trim().to_string()),
                        Err(_) => out.warnings.push("capability file is not UTF-8".into()),
                    }
                }
                Ok(_) => out.warnings.push("capability file is too large".into()),
                Err(e) => out.warnings.push(format!("cannot read capability file: {e}")),
            },
            "--open" => out.open = Some(PathBuf::from(value)),
            _ => unreachable!(),
        }
    }
    out
}

/// Validate the raw arguments into what the frontend may see.
pub fn validate(raw: &RawLaunchArgs) -> LaunchArgs {
    let mut warnings = raw.warnings.clone();
    let connect = raw.connect.as_deref().and_then(|u| match validate_connect_url(u) {
        Ok(url) => Some(url),
        Err(e) => {
            warnings.push(format!("--connect rejected: {e}"));
            None
        }
    });
    let session = raw.session.as_deref().and_then(|s| {
        let ok = !s.is_empty()
            && s.len() <= 128
            && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'));
        if !ok {
            warnings.push("--session rejected: expected 1-128 chars of [A-Za-z0-9_.:-]".into());
        }
        ok.then(|| s.to_string())
    });
    let capability = raw.capability.as_deref().and_then(|c| {
        let ok = !c.is_empty() && c.len() <= MAX_CAPABILITY_BYTES && !c.chars().any(char::is_control);
        if !ok {
            warnings.push("capability rejected: empty, too long, or contains control characters".into());
        }
        ok.then(|| c.to_string())
    });
    LaunchArgs { connect, session, capability, warnings }
}

/// Live endpoint policy, matching the schemes `resolveEndpoint` accepts in the
/// renderer (src/ingest/live/endpoint.ts): `wss://` / `https://` to any host,
/// plain `ws://` / `http://` only to loopback (docs/SECURITY_PRIVACY.md:
/// loopback by default, remote must be encrypted). Credentials embedded in the
/// URL are refused.
pub fn validate_connect_url(input: &str) -> Result<String, String> {
    let url = Url::parse(input).map_err(|e| format!("invalid URL ({e})"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("credentials in URL are not allowed".into());
    }
    let host = url.host_str().ok_or("URL has no host")?;
    match url.scheme() {
        "wss" | "https" => {}
        scheme @ ("ws" | "http") => {
            if !is_loopback(host) {
                let secure = if scheme == "ws" { "wss" } else { "https" };
                return Err(format!("plain {scheme}:// is only allowed to loopback; use {secure}:// for remote"));
            }
        }
        other => return Err(format!("unsupported scheme {other}:// (expected ws, wss, http or https)")),
    }
    Ok(url.to_string())
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "[::1]" | "::1")
        || host.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.is_loopback())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_both_forms_and_alias() {
        let raw = parse(["--endpoint", "ws://127.0.0.1:49152/telemetry", "--open=rec/manifest.json", "--session", "ses_1"]);
        assert_eq!(raw.connect.as_deref(), Some("ws://127.0.0.1:49152/telemetry"));
        assert_eq!(raw.open, Some(PathBuf::from("rec/manifest.json")));
        assert_eq!(raw.session.as_deref(), Some("ses_1"));
        assert!(raw.warnings.is_empty());
    }

    #[test]
    fn missing_value_and_unknown_flags_warn() {
        let raw = parse(["--connect", "--open", "x", "--bogus", "positional"]);
        assert_eq!(raw.connect, None);
        assert_eq!(raw.open, Some(PathBuf::from("x")));
        assert_eq!(raw.warnings.len(), 2);
    }

    #[test]
    fn connect_url_policy() {
        assert!(validate_connect_url("ws://127.0.0.1:1/t").is_ok());
        assert!(validate_connect_url("ws://localhost:1/t").is_ok());
        assert!(validate_connect_url("ws://[::1]:1/t").is_ok());
        assert!(validate_connect_url("wss://node.example:443/t").is_ok());
        assert!(validate_connect_url("ws://192.168.1.2:1/t").is_err());
        assert!(validate_connect_url("wss://u:p@node.example/").is_err());
        assert!(validate_connect_url("not a url").is_err());
        assert!(validate_connect_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn http_connect_urls_follow_the_same_loopback_rule() {
        assert!(validate_connect_url("http://127.0.0.1:1/events").is_ok());
        assert!(validate_connect_url("http://localhost:1/events?format=ndjson").is_ok());
        assert!(validate_connect_url("http://[::1]:1/events").is_ok());
        assert!(validate_connect_url("https://node.example/stream").is_ok());
        let err = validate_connect_url("http://10.0.0.1/events").unwrap_err();
        assert!(err.contains("https://"), "{err}");
        assert!(validate_connect_url("https://u:p@node.example/").is_err());
    }

    #[test]
    fn validate_drops_bad_values() {
        let raw = parse(["--connect", "ws://10.0.0.1/", "--session", "bad id!"]);
        let v = validate(&raw);
        assert_eq!(v.connect, None);
        assert_eq!(v.session, None);
        assert_eq!(v.warnings.len(), 2);
    }
}
