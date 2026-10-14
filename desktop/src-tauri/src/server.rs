//! Starting, probing and stopping the Switchboard server that lives inside WSL.
//!
//! The shell never talks to the server except through three things: the token it pipes on the
//! child's STDIN (never argv: `ps` shows argv), a `GET /api/status` health probe, and the `stop`
//! script. The port is fixed: if something already answers there, a leftover Switchboard server is
//! replaced, anything else is reported as a conflict. The port is never changed silently.

use crate::config::Config;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

/// How long a cold WSL start may take before we give up and show the log hint.
pub const HEALTH_TIMEOUT: Duration = Duration::from_secs(60);
const STOP_TIMEOUT: Duration = Duration::from_secs(25);
const PORT_FREE_TIMEOUT: Duration = Duration::from_secs(15);
const IDENTITY_HEADER: &str = "x-switchboard-desktop";

#[derive(Debug, Clone, PartialEq)]
pub enum StartError {
    /// `wsl.exe` could not be launched at all.
    WslMissing,
    /// Another program owns the configured port.
    PortInUse(u16),
    /// A leftover Switchboard server owns the port and would not stop.
    StopFailed(u16),
    /// The start script exited before the server answered (exit code if known).
    StartFailed(Option<i32>),
    /// The server did not answer in time.
    HealthTimeout,
}

impl StartError {
    /// Stable code the error page maps to a message; `detail` is plain data shown verbatim.
    pub fn code(&self) -> &'static str {
        match self {
            StartError::WslMissing => "wsl_missing",
            StartError::PortInUse(_) => "port_in_use",
            StartError::StopFailed(_) => "stop_failed",
            StartError::StartFailed(_) => "start_failed",
            StartError::HealthTimeout => "health_timeout",
        }
    }

    pub fn detail(&self) -> String {
        match self {
            StartError::PortInUse(p) | StartError::StopFailed(p) => p.to_string(),
            StartError::StartFailed(Some(code)) => code.to_string(),
            _ => String::new(),
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum Probe {
    Free,
    Ours,
    Other,
}

/// A running server: the `wsl.exe` child that hosts it.
pub struct Running {
    pub child: Child,
}

/// `wsl.exe [-d distro] --exec bash -c <expander> <script> <args...>`.
///
/// `--exec` matters: without it wsl.exe runs the command line through the distro's shell, so the
/// expander below would be expanded (and its quotes eaten) before bash ever saw it. The script
/// path rides as `$0` and the arguments as `"$@"`, so nothing a user typed is ever parsed as shell
/// text; a leading `~/` is expanded by our own expander on the Linux side.
pub fn wsl_args(config: &Config, script: &str, args: &[String]) -> Vec<String> {
    const EXPAND_AND_RUN: &str = r#"p="$0"; case "$p" in "~/"*) p="$HOME/${p#\~/}";; esac; exec bash "$p" "$@""#;
    let mut out = Vec::new();
    if let Some(distro) = &config.distro {
        out.push("-d".to_string());
        out.push(distro.clone());
    }
    out.push("--exec".to_string());
    out.push("bash".to_string());
    out.push("-c".to_string());
    out.push(EXPAND_AND_RUN.to_string());
    out.push(script.to_string());
    out.extend(args.iter().cloned());
    out
}

fn wsl_command(config: &Config, script: &str, args: &[String]) -> Command {
    let mut cmd = Command::new("wsl.exe");
    cmd.args(wsl_args(config, script, args));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// 32 random bytes as 64 hex characters.
pub fn new_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the OS random source is unavailable");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The window's first URL: it trades the token for a cookie and redirects, so it never stays in
/// the address bar or the history.
pub fn enter_url(port: u16, token: &str) -> String {
    format!("http://127.0.0.1:{port}/__sb/enter?t={token}")
}

/// Only the app's own pages and its own server may load in the window.
pub fn is_allowed_navigation(url: &tauri::Url, port: u16) -> bool {
    match url.scheme() {
        "tauri" | "about" => true,
        "http" | "https" => match url.host_str() {
            Some("tauri.localhost") => true,
            Some("127.0.0.1") | Some("localhost") => url.scheme() == "http" && url.port() == Some(port),
            _ => false,
        },
        _ => false,
    }
}

/// Percent-encode for a query value (unreserved characters pass through).
pub fn pct_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn error_page(code: &str, detail: &str, port: u16) -> String {
    format!(
        "index.html?state=error&code={}&detail={}&port={port}",
        pct_encode(code),
        pct_encode(detail)
    )
}

/// First line of an HTTP response -> status code.
pub fn parse_status(raw: &str) -> Option<u16> {
    let line = raw.lines().next()?;
    let mut parts = line.split_whitespace();
    let proto = parts.next()?;
    if !proto.starts_with("HTTP/") {
        return None;
    }
    parts.next()?.parse().ok()
}

/// Is this response from a Switchboard desktop server (the marker header on its 401)?
pub fn classify_probe(raw: &str) -> Probe {
    let head = raw.split("\r\n\r\n").next().unwrap_or(raw);
    if head.lines().skip(1).any(|l| l.to_ascii_lowercase().starts_with(&format!("{IDENTITY_HEADER}:"))) {
        Probe::Ours
    } else {
        Probe::Other
    }
}

enum Fetch {
    /// Nothing is listening.
    Refused,
    /// Something accepted the connection but never gave a usable answer.
    Silent,
    Reply(String),
}

fn http_get(port: u16, bearer: Option<&str>) -> Fetch {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(800)) else {
        return Fetch::Refused;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1500)));
    let auth = bearer.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    let request = format!("GET /api/status HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}Connection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return Fetch::Silent;
    }
    let mut buf = Vec::new();
    // Headers and the status line are all that matter; never read an unbounded body.
    let _ = stream.take(16 * 1024).read_to_end(&mut buf);
    if buf.is_empty() {
        Fetch::Silent
    } else {
        Fetch::Reply(String::from_utf8_lossy(&buf).into_owned())
    }
}

pub fn probe(port: u16) -> Probe {
    match http_get(port, None) {
        Fetch::Refused => Probe::Free,
        Fetch::Silent => Probe::Other,
        Fetch::Reply(raw) => classify_probe(&raw),
    }
}

fn healthy(port: u16, token: &str) -> bool {
    match http_get(port, Some(token)) {
        Fetch::Reply(raw) => parse_status(&raw) == Some(200),
        _ => false,
    }
}

/// Run a command to completion, killing it when `limit` passes. `None` = it was killed.
fn run_with_timeout(mut cmd: Command, limit: Duration) -> std::io::Result<Option<ExitStatus>> {
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = cmd.spawn()?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        if started.elapsed() >= limit {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Run the stop script. Best effort: its outcome is judged by the port, not the exit code.
pub fn run_stop(config: &Config) {
    let _ = run_with_timeout(wsl_command(config, &config.stop_command, &[]), STOP_TIMEOUT);
}

fn wait_until_free(port: u16, limit: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < limit {
        if probe(port) == Probe::Free {
            return true;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    false
}

/// Start the server and wait until it answers the health probe.
pub fn start(config: &Config, token: &str) -> Result<Running, StartError> {
    match probe(config.port) {
        Probe::Free => {}
        Probe::Other => return Err(StartError::PortInUse(config.port)),
        Probe::Ours => {
            run_stop(config);
            if !wait_until_free(config.port, PORT_FREE_TIMEOUT) {
                return Err(StartError::StopFailed(config.port));
            }
        }
    }

    let args = vec!["--host".to_string(), "127.0.0.1".to_string(), "--port".to_string(), config.port.to_string()];
    let mut cmd = wsl_command(config, &config.start_command, &args);
    cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|_| StartError::WslMissing)?;

    // The token goes in on stdin and the pipe is closed right away.
    if let Some(mut stdin) = child.stdin.take() {
        if stdin.write_all(format!("{token}\n").as_bytes()).is_err() {
            let _ = child.kill();
            return Err(StartError::StartFailed(None));
        }
    }

    let started = Instant::now();
    while started.elapsed() < HEALTH_TIMEOUT {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(StartError::StartFailed(status.code()));
        }
        if healthy(config.port, token) {
            return Ok(Running { child });
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    let _ = child.kill();
    let _ = child.wait();
    run_stop(config);
    Err(StartError::HealthTimeout)
}

impl Running {
    /// Stop the server explicitly: killing `wsl.exe` alone can leave the Linux process running.
    /// tmux sessions are not touched; they are meant to outlive the server.
    pub fn stop(mut self, config: &Config) {
        run_stop(config);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(distro: Option<&str>) -> Config {
        Config { distro: distro.map(String::from), ..Config::default() }
    }

    #[test]
    fn wsl_args_keep_user_values_out_of_the_shell_text() {
        let args = wsl_args(&cfg(Some("Ubuntu")), "~/.switchboard/bin/start", &["--port".into(), "3600".into()]);
        assert_eq!(&args[..3], ["-d", "Ubuntu", "--exec"]);
        assert_eq!(&args[3..5], ["bash", "-c"]);
        assert!(args[5].contains("exec bash"));
        assert_eq!(&args[6..], ["~/.switchboard/bin/start", "--port", "3600"]);
        // a hostile value is only ever an argument, never part of the script string
        let hostile = wsl_args(&cfg(None), "x; id", &[]);
        assert_eq!(hostile[0], "--exec");
        assert!(!hostile[..4].iter().any(|a| a.contains("x; id")));
        assert_eq!(hostile.last().unwrap(), "x; id");
    }

    #[test]
    fn the_expander_really_runs_through_wsl_with_script_as_dollar_zero() {
        // Needs wsl.exe and a distro; skipped where there is none (CI, a bare machine).
        let cmd_cfg = cfg(None);
        let probe = Command::new("wsl.exe").args(["--exec", "true"]).output();
        if !matches!(probe, Ok(ref o) if o.status.success()) {
            return;
        }
        let out = wsl_command(&cmd_cfg, "~/definitely-missing-script.sh", &["a b".into(), "$HOME".into()])
            .output()
            .unwrap();
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(!out.status.success());
        assert!(err.contains("/definitely-missing-script.sh"), "stderr: {err}");
        assert!(!err.contains("~/definitely"), "the tilde must have been expanded: {err}");
        assert!(!err.contains("$HOME/definitely"), "HOME must have been expanded by the script: {err}");
    }

    #[test]
    fn tokens_are_64_hex_and_unique() {
        let (a, b) = (new_token(), new_token());
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn enter_url_targets_loopback_only() {
        assert_eq!(enter_url(3600, "abc"), "http://127.0.0.1:3600/__sb/enter?t=abc");
    }

    #[test]
    fn navigation_is_limited_to_the_app_and_its_own_server() {
        let ok = |u: &str| is_allowed_navigation(&tauri::Url::parse(u).unwrap(), 3600);
        assert!(ok("http://127.0.0.1:3600/"));
        assert!(ok("http://localhost:3600/api/x"));
        assert!(ok("http://tauri.localhost/index.html?state=error"));
        assert!(ok("tauri://localhost/index.html"));
        assert!(!ok("http://127.0.0.1:3601/"));
        assert!(!ok("http://127.0.0.1/"));
        assert!(!ok("https://127.0.0.1:3600/"));
        assert!(!ok("http://example.com/"));
        assert!(!ok("http://127.0.0.1.evil.com:3600/"));
        assert!(!ok("file:///C:/Windows/win.ini"));
        assert!(!ok("javascript:alert(1)"));
    }

    #[test]
    fn status_and_identity_parsing() {
        assert_eq!(parse_status("HTTP/1.1 200 OK\r\nA: b\r\n\r\n"), Some(200));
        assert_eq!(parse_status("HTTP/1.1 401 Unauthorized\r\n"), Some(401));
        assert_eq!(parse_status("garbage"), None);
        assert_eq!(parse_status(""), None);
        let ours = "HTTP/1.1 401 Unauthorized\r\nX-Switchboard-Desktop: 1\r\ncontent-length: 12\r\n\r\nUnauthorized";
        assert_eq!(classify_probe(ours), Probe::Ours);
        assert_eq!(classify_probe("HTTP/1.1 401 Unauthorized\r\n\r\nUnauthorized"), Probe::Other);
        // the marker must be a header, not text in the body
        assert_eq!(classify_probe("HTTP/1.1 200 OK\r\n\r\nx-switchboard-desktop: 1"), Probe::Other);
        assert_eq!(classify_probe(""), Probe::Other);
    }

    #[test]
    fn error_pages_encode_their_parts() {
        assert_eq!(error_page("port_in_use", "3600", 3600), "index.html?state=error&code=port_in_use&detail=3600&port=3600");
        assert!(!error_page("x", "a&b=c d", 1).contains("a&b"));
        assert_eq!(pct_encode("한"), "%ED%95%9C");
    }

    #[test]
    fn error_codes_are_stable() {
        assert_eq!(StartError::PortInUse(1).code(), "port_in_use");
        assert_eq!(StartError::StartFailed(Some(3)).detail(), "3");
        assert_eq!(StartError::HealthTimeout.detail(), "");
    }

    #[test]
    fn probe_of_a_closed_port_is_free() {
        // Bind then drop to get a port that is almost certainly closed.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert_eq!(probe(port), Probe::Free);
    }

    #[test]
    fn probe_tells_a_foreign_listener_from_ours() {
        use std::net::TcpListener;
        fn serve_once(reply: &'static str) -> u16 {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = l.local_addr().unwrap().port();
            std::thread::spawn(move || {
                if let Ok((mut s, _)) = l.accept() {
                    let mut buf = [0u8; 1024];
                    let _ = s.read(&mut buf);
                    let _ = s.write_all(reply.as_bytes());
                }
            });
            port
        }
        let other = serve_once("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
        assert_eq!(probe(other), Probe::Other);
        let ours = serve_once("HTTP/1.1 401 Unauthorized\r\nX-Switchboard-Desktop: 1\r\nContent-Length: 0\r\n\r\n");
        assert_eq!(probe(ours), Probe::Ours);
    }
}
