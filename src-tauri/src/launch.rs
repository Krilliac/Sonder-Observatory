//! Command-line launch contract.
//!
//! Standalone use and the Sonder Flutter launch flow (docs/INTEGRATION.md)
//! pass these arguments:
//!
//! ```text
//! sonder-observatory [--connect <url> [--token-file <path>]]... [--session <id>]
//!                    [--capability-file <path> | --capability <token>]
//!                    [--open <recording>]
//! ```
//!
//! - `--connect` (alias `--endpoint`) is repeatable. Each URL is `ws`, `wss`,
//!   `http` or `https`; plain `ws`/`http` only to a loopback host. URLs with
//!   credentials or a `token`/`access_token` query parameter are refused.
//!   `connect` keeps the first accepted URL; `connectAll` lists all of them.
//! - `--token-file` is an alias of `--capability-file`: the file is read
//!   once (at most 4 KiB, trimmed) and the token is kept in memory only and
//!   never logged. A token file given right after a `--connect` binds to that
//!   URL (`connectTokens[i]`), so each producer only ever receives its own
//!   token. A token not bound to a URL is the `capability`; it is applied to
//!   the launched http(s) connection only when exactly one http(s) URL was
//!   given, and never to ws(s) URLs (browsers cannot send it there).
//!
//! Both `--flag value` and `--flag=value` forms work. Invalid values are
//! dropped with a warning rather than aborting startup so the viewer can still
//! open and explain the problem.

use serde::Serialize;
use std::path::PathBuf;
use tauri::Url;

/// Upper bound for a capability token read from a file or argument.
const MAX_CAPABILITY_BYTES: usize = 4096;

/// Query parameters that would carry a secret in a URL.
const SECRET_QUERY_PARAMS: [&str; 2] = ["token", "access_token"];

/// One `--connect` argument and the token given right after it, if any.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RawConnect {
    pub url: String,
    pub token: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RawLaunchArgs {
    pub connect: Vec<RawConnect>,
    pub session: Option<String>,
    /// Token not bound to a `--connect` URL.
    pub capability: Option<String>,
    pub open: Option<PathBuf>,
    pub warnings: Vec<String>,
}

/// Validated launch arguments handed to the frontend (the `open` recording is
/// resolved into a read grant separately, see `recording.rs`).
#[derive(Debug, Default, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchArgs {
    /// First accepted `--connect` URL (kept for older frontends).
    pub connect: Option<String>,
    /// Every accepted `--connect` URL, in argument order.
    pub connect_all: Vec<String>,
    /// Bearer token per `connect_all` entry (same length), or null.
    pub connect_tokens: Vec<Option<String>>,
    pub session: Option<String>,
    pub capability: Option<String>,
    pub warnings: Vec<String>,
}

/// Reads a token file: at most 4 KiB, UTF-8, trimmed. Errors never include
/// the file contents.
fn read_token_file(path: &str) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("cannot read token file: {e}"))?;
    if bytes.len() > MAX_CAPABILITY_BYTES {
        return Err("token file is too large (max 4 KiB)".into());
    }
    let text = String::from_utf8(bytes).map_err(|_| "token file is not UTF-8".to_string())?;
    Ok(text.trim().to_string())
}

/// Parse `args` (excluding argv[0]).
pub fn parse<I, S>(args: I) -> RawLaunchArgs
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut out = RawLaunchArgs::default();
    let mut it = args.into_iter().map(Into::into).peekable();
    // Index of the --connect a directly following token may bind to.
    let mut bindable: Option<usize> = None;
    while let Some(arg) = it.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f.to_string(), Some(v.to_string())),
            _ => (arg.clone(), None),
        };
        let known = matches!(
            flag.as_str(),
            "--connect"
                | "--endpoint"
                | "--session"
                | "--capability"
                | "--capability-file"
                | "--token-file"
                | "--open"
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
        let token = match flag.as_str() {
            "--connect" | "--endpoint" => {
                out.connect.push(RawConnect { url: value, token: None });
                bindable = Some(out.connect.len() - 1);
                continue;
            }
            "--session" => {
                out.session = Some(value);
                bindable = None;
                continue;
            }
            "--open" => {
                out.open = Some(PathBuf::from(value));
                bindable = None;
                continue;
            }
            "--capability" => {
                out.warnings.push(
                    "--capability exposes the token to other local processes; prefer --token-file".into(),
                );
                value
            }
            "--capability-file" | "--token-file" => match read_token_file(&value) {
                Ok(token) => token,
                Err(e) => {
                    out.warnings.push(format!("{flag}: {e}"));
                    bindable = None;
                    continue;
                }
            },
            _ => unreachable!(),
        };
        match bindable.take() {
            Some(i) => out.connect[i].token = Some(token),
            None => {
                if out.capability.is_some() {
                    out.warnings.push(format!(
                        "{flag}: more than one token without a preceding --connect; the last one is used"
                    ));
                }
                out.capability = Some(token);
            }
        }
    }
    out
}

fn valid_token(token: &str) -> bool {
    !token.is_empty() && token.len() <= MAX_CAPABILITY_BYTES && !token.chars().any(char::is_control)
}

/// Validate the raw arguments into what the frontend may see.
pub fn validate(raw: &RawLaunchArgs) -> LaunchArgs {
    let mut warnings = raw.warnings.clone();
    let mut connect_all = Vec::new();
    let mut connect_tokens = Vec::new();
    for (i, entry) in raw.connect.iter().enumerate() {
        let url = match validate_connect_url(&entry.url) {
            Ok(url) => url,
            Err(e) => {
                warnings.push(format!("--connect #{} rejected: {e}", i + 1));
                continue;
            }
        };
        let token = entry.token.as_deref().and_then(|t| {
            if !valid_token(t) {
                warnings.push(format!(
                    "token for --connect #{} rejected: empty, too long, or contains control characters",
                    i + 1
                ));
                return None;
            }
            if is_ws(&url) {
                warnings.push(format!(
                    "token for --connect #{} not applied: a bearer token cannot be sent over WebSocket",
                    i + 1
                ));
                return None;
            }
            Some(t.to_string())
        });
        connect_all.push(url);
        connect_tokens.push(token);
    }
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
        let ok = valid_token(c);
        if !ok {
            warnings.push("capability rejected: empty, too long, or contains control characters".into());
        }
        ok.then(|| c.to_string())
    });
    if let Some(token) = capability.as_deref() {
        let http: Vec<usize> = (0..connect_all.len()).filter(|&i| !is_ws(&connect_all[i])).collect();
        match http.as_slice() {
            [only] => {
                if connect_tokens[*only].is_none() {
                    connect_tokens[*only] = Some(token.to_string());
                }
            }
            [] => {}
            _ => warnings.push(
                "a token without a preceding --connect is not applied when several http(s) URLs are given; \
                 put --token-file right after the --connect it belongs to"
                    .into(),
            ),
        }
    }
    LaunchArgs {
        connect: connect_all.first().cloned(),
        connect_all,
        connect_tokens,
        session,
        capability,
        warnings,
    }
}

fn is_ws(url: &str) -> bool {
    url.starts_with("ws://") || url.starts_with("wss://")
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "[::1]" | "::1")
        || host.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.is_loopback())
}

/// Live telemetry URL policy (docs/SECURITY_PRIVACY.md): `wss`/`https` to any
/// host, plain `ws`/`http` only to loopback. Credentials and token query
/// parameters in the URL are refused.
pub fn validate_connect_url(input: &str) -> Result<String, String> {
    let url = Url::parse(input).map_err(|e| format!("invalid URL ({e})"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("credentials in URL are not allowed".into());
    }
    if url
        .query_pairs()
        .any(|(k, _)| SECRET_QUERY_PARAMS.contains(&k.to_ascii_lowercase().as_str()))
    {
        return Err("token query parameters are not allowed; use --token-file".into());
    }
    let host = url.host_str().ok_or("URL has no host")?;
    match url.scheme() {
        "wss" | "https" => {}
        scheme @ ("ws" | "http") => {
            if !is_loopback(host) {
                let secure = if scheme == "ws" { "wss" } else { "https" };
                return Err(format!(
                    "plain {scheme}:// is only allowed to loopback; use {secure}:// for remote"
                ));
            }
        }
        other => return Err(format!("unsupported scheme {other}:// (expected ws, wss, http or https)")),
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn token_file(dir: &std::path::Path, name: &str, contents: &[u8]) -> String {
        let path = dir.join(name);
        std::fs::File::create(&path).unwrap().write_all(contents).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sonder-obs-launch-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_both_forms_and_alias() {
        let raw = parse(["--endpoint", "ws://127.0.0.1:49152/telemetry", "--open=rec/manifest.json", "--session", "ses_1"]);
        assert_eq!(raw.connect, vec![RawConnect { url: "ws://127.0.0.1:49152/telemetry".into(), token: None }]);
        assert_eq!(raw.open, Some(PathBuf::from("rec/manifest.json")));
        assert_eq!(raw.session.as_deref(), Some("ses_1"));
        assert!(raw.warnings.is_empty());
    }

    #[test]
    fn missing_value_and_unknown_flags_warn() {
        let raw = parse(["--connect", "--open", "x", "--bogus", "positional"]);
        assert!(raw.connect.is_empty());
        assert_eq!(raw.open, Some(PathBuf::from("x")));
        assert_eq!(raw.warnings.len(), 2);
    }

    #[test]
    fn connect_is_repeatable_and_keeps_the_first() {
        let raw = parse([
            "--connect",
            "http://127.0.0.1:11435",
            "--endpoint=http://127.0.0.1:11437",
            "--connect",
            "ws://127.0.0.1:8765",
        ]);
        let v = validate(&raw);
        assert_eq!(v.connect.as_deref(), Some("http://127.0.0.1:11435/"));
        assert_eq!(
            v.connect_all,
            vec!["http://127.0.0.1:11435/", "http://127.0.0.1:11437/", "ws://127.0.0.1:8765/"]
        );
        assert_eq!(v.connect_tokens, vec![None, None, None]);
        assert!(v.warnings.is_empty(), "{:?}", v.warnings);
    }

    #[test]
    fn url_policy() {
        for ok in [
            "ws://127.0.0.1:1/t",
            "ws://localhost:1/t",
            "ws://[::1]:1/t",
            "http://127.0.0.1:11435",
            "http://127.1.2.3:1/sse",
            "http://localhost:11437/.well-known/sonder-telemetry",
            "wss://node.example:443/t",
            "https://node.example/v1/observability/events?format=ndjson",
        ] {
            assert!(validate_connect_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "ws://192.168.1.2:1/t",
            "http://10.0.0.1:11435",
            "http://node.example/",
            "ftp://127.0.0.1/",
            "wss://u:p@node.example/",
            "https://user@node.example/",
            "http://127.0.0.1:11435/?token=abc",
            "https://node.example/sse?Access_Token=abc",
            "not a url",
        ] {
            assert!(validate_connect_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn validate_drops_bad_values() {
        let raw = parse([
            "--connect",
            "ws://10.0.0.1/",
            "--connect",
            "http://127.0.0.1:1/?access_token=abc",
            "--session",
            "bad id!",
        ]);
        let v = validate(&raw);
        assert_eq!(v.connect, None);
        assert!(v.connect_all.is_empty());
        assert!(v.connect_tokens.is_empty());
        assert_eq!(v.session, None);
        assert_eq!(v.warnings.len(), 3);
        // The rejected URL (and the secret in it) is not echoed.
        assert!(v.warnings.iter().all(|w| !w.contains("abc")), "{:?}", v.warnings);
    }

    #[test]
    fn token_file_binds_to_the_preceding_connect() {
        let dir = temp_dir("bind");
        let rt = token_file(&dir, "rt", b"runtime-key\n");
        let inf = token_file(&dir, "inf", b"  inference-key  ");
        let raw = parse([
            "--connect",
            "http://127.0.0.1:11435",
            "--token-file",
            &rt,
            "--connect",
            "http://127.0.0.1:11437",
            &format!("--capability-file={inf}"),
            "--connect",
            "http://127.0.0.1:8766/sse",
        ]);
        let v = validate(&raw);
        assert_eq!(
            v.connect_tokens,
            vec![Some("runtime-key".to_string()), Some("inference-key".to_string()), None]
        );
        assert_eq!(v.capability, None);
        assert!(v.warnings.is_empty(), "{:?}", v.warnings);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn unbound_token_applies_only_to_a_single_http_url() {
        let dir = temp_dir("unbound");
        let tok = token_file(&dir, "tok", b"shared");
        // Legacy order: token before any --connect.
        let single = validate(&parse(["--token-file", &tok, "--connect", "http://127.0.0.1:11435"]));
        assert_eq!(single.capability.as_deref(), Some("shared"));
        assert_eq!(single.connect_tokens, vec![Some("shared".to_string())]);

        let several = validate(&parse([
            "--token-file",
            &tok,
            "--connect",
            "http://127.0.0.1:11435",
            "--connect",
            "http://127.0.0.1:11437",
        ]));
        assert_eq!(several.connect_tokens, vec![None, None]);
        assert!(several.warnings.iter().any(|w| w.contains("several http(s) URLs")));
        assert!(several.warnings.iter().all(|w| !w.contains("shared")));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn tokens_never_go_to_websocket_urls() {
        let dir = temp_dir("ws");
        let tok = token_file(&dir, "tok", b"secret");
        let bound = validate(&parse(["--connect", "ws://127.0.0.1:8765", "--token-file", &tok]));
        assert_eq!(bound.connect_all, vec!["ws://127.0.0.1:8765/"]);
        assert_eq!(bound.connect_tokens, vec![None]);
        assert!(bound.warnings.iter().any(|w| w.contains("WebSocket")));
        let unbound = validate(&parse(["--token-file", &tok, "--connect", "ws://127.0.0.1:8765"]));
        assert_eq!(unbound.connect_tokens, vec![None]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn token_file_limits() {
        let dir = temp_dir("limits");
        let big = token_file(&dir, "big", &vec![b'a'; MAX_CAPABILITY_BYTES + 1]);
        let raw = parse(["--connect", "http://127.0.0.1:1", "--token-file", &big]);
        assert_eq!(raw.connect[0].token, None);
        assert!(raw.warnings.iter().any(|w| w.contains("too large")));
        let missing = parse(["--token-file", "/nonexistent/sonder-token"]);
        assert_eq!(missing.capability, None);
        assert!(missing.warnings[0].starts_with("--token-file: cannot read token file"));
        let empty = token_file(&dir, "empty", b"  \n");
        let v = validate(&parse(["--connect", "http://127.0.0.1:1", "--token-file", &empty]));
        assert_eq!(v.connect_tokens, vec![None]);
        assert!(v.warnings.iter().any(|w| w.contains("token for --connect #1 rejected")));
        std::fs::remove_dir_all(dir).ok();
    }
}
