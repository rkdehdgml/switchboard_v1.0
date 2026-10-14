//! `%LOCALAPPDATA%\Switchboard\config.json`: the few knobs a user may change by hand.
//!
//! Everything here ends up in a `wsl.exe` command line, so every value is validated against a
//! strict allowlist before use. A missing file means defaults; a file that exists but does not
//! parse is an error shown to the user, never silently replaced by defaults.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Fixed default so the WebView origin (and the `localStorage` under it) survives restarts.
pub const DEFAULT_PORT: u16 = 3600;
pub const DEFAULT_START: &str = "~/.switchboard/bin/start";
pub const DEFAULT_STOP: &str = "~/.switchboard/bin/stop";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct Config {
    pub port: u16,
    /// WSL distribution name; `None` = the WSL default distribution.
    pub distro: Option<String>,
    pub start_command: String,
    pub stop_command: String,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            port: DEFAULT_PORT,
            distro: None,
            start_command: DEFAULT_START.to_string(),
            stop_command: DEFAULT_STOP.to_string(),
        }
    }
}

impl Config {
    /// Parse and validate a config file's text.
    pub fn parse(text: &str) -> Result<Config, String> {
        let config: Config =
            serde_json::from_str(text).map_err(|e| format!("config.json is not valid: {e}"))?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.port < 1024 {
            return Err(format!("port {} is not allowed (use 1024-65535)", self.port));
        }
        if let Some(distro) = &self.distro {
            if !is_safe_name(distro) {
                return Err("distro may only contain letters, digits, '.', '_' and '-'".to_string());
            }
        }
        for (key, value) in [("startCommand", &self.start_command), ("stopCommand", &self.stop_command)] {
            if !is_safe_path(value) {
                return Err(format!("{key} must be a plain path (letters, digits, / . _ ~ - + @), no spaces"));
            }
        }
        Ok(())
    }
}

fn is_safe_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && !s.starts_with('-')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// A single argv token that cannot be an option and cannot carry shell syntax.
fn is_safe_path(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 256
        && !s.starts_with('-')
        && !s.contains("..")
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '~' | '-' | '+' | '@'))
}

/// `SWITCHBOARD_CONFIG` (a full file path) overrides the default location: for `desktop/dev.ps1`
/// and tests, so a development run never touches the user's real config.json.
pub fn config_path() -> Option<PathBuf> {
    if let Some(custom) = std::env::var_os("SWITCHBOARD_CONFIG") {
        return Some(PathBuf::from(custom));
    }
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(base).join("Switchboard").join("config.json"))
}

/// Load the user's config. A missing file yields the defaults (and writes them out, best effort,
/// so the file is there to edit); an unreadable or invalid one is an `Err` with a readable reason.
pub fn load() -> Result<Config, String> {
    let Some(path) = config_path() else {
        return Ok(Config::default());
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => Config::parse(&text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let config = Config::default();
            if let (Some(dir), Ok(json)) = (path.parent(), serde_json::to_string_pretty(&config)) {
                let _ = std::fs::create_dir_all(dir);
                let _ = std::fs::write(&path, json + "\n");
            }
            Ok(config)
        }
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// Append one line to `%LOCALAPPDATA%\Switchboard\shell.log` (best effort, size-capped):
/// the only trace of what the shell itself did when something goes wrong before a window exists.
pub fn log(message: &str) {
    use std::io::Write;
    let Some(path) = config_path().map(|p| p.with_file_name("shell.log")) else { return };
    if std::fs::metadata(&path).map(|m| m.len() > 256 * 1024).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{secs} {message}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid() {
        Config::default().validate().unwrap();
        assert_eq!(Config::parse("{}").unwrap(), Config::default());
    }

    #[test]
    fn snake_case_keys_round_trip() {
        let c = Config::parse(r#"{"port":4000,"distro":"Ubuntu-22.04","start_command":"/opt/sb/start","stop_command":"/opt/sb/stop"}"#)
            .unwrap();
        assert_eq!((c.port, c.distro.as_deref(), c.start_command.as_str()), (4000, Some("Ubuntu-22.04"), "/opt/sb/start"));
    }

    #[test]
    fn rejects_bad_json_and_unknown_keys() {
        assert!(Config::parse("{").is_err());
        assert!(Config::parse(r#"{"prot":4000}"#).is_err());
        assert!(Config::parse(r#"{"port":"3600"}"#).is_err());
        assert!(Config::parse(r#"{"port":70000}"#).is_err());
    }

    #[test]
    fn rejects_privileged_ports() {
        assert!(Config::parse(r#"{"port":80}"#).is_err());
        assert!(Config::parse(r#"{"port":1023}"#).is_err());
        assert!(Config::parse(r#"{"port":1024}"#).is_ok());
    }

    #[test]
    fn rejects_shell_syntax_and_options_in_names_and_paths() {
        for bad in ["", "-d", "a b", "a;b", "a$(x)", "a`x`", "a|b", "a&b", "a\nb", "../x"] {
            assert!(!is_safe_path(bad), "path {bad:?}");
        }
        for bad in ["", "-x", "a b", "a;b", "é"] {
            assert!(!is_safe_name(bad), "name {bad:?}");
        }
        assert!(is_safe_path("~/.switchboard/bin/start"));
        assert!(Config::parse(r#"{"distro":"Ubuntu; rm -rf ~"}"#).is_err());
        assert!(Config::parse(r#"{"start_command":"start; id"}"#).is_err());
        assert!(Config::parse(r#"{"stop_command":"--help"}"#).is_err());
    }
}
