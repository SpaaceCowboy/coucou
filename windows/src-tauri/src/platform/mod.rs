pub mod watch;
use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub platform: &'static str,
    pub floating_window: bool,
    pub opaque_window: bool,
    pub top_edge: bool,
    pub codex_links: bool,
    pub credential_store: &'static str,
}

pub fn is_wayland() -> bool {
    cfg!(target_os = "linux")
        && (std::env::var("XDG_SESSION_TYPE").is_ok_and(|s| s == "wayland")
            || std::env::var_os("WAYLAND_DISPLAY").is_some())
}

// Cache the startup choice so native geometry and frontend capabilities agree.
pub fn opaque_window() -> bool {
    static OPAQUE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *OPAQUE.get_or_init(|| {
        cfg!(target_os = "linux") && opaque_window_choice(
            std::env::var("COUCOU_OPAQUE_WINDOW").ok().as_deref(),
            std::path::Path::new("/proc/driver/nvidia/version").exists(),
        )
    })
}

fn opaque_window_choice(setting: Option<&str>, nvidia: bool) -> bool {
    match setting {
        Some("1") => true,
        Some("0") => false,
        _ => nvidia,
    }
}

pub fn floating_window() -> bool {
    is_wayland() || opaque_window()
}

pub fn capabilities() -> Capabilities {
    Capabilities {
        platform: if cfg!(windows) { "windows" } else { "linux" },
        floating_window: floating_window(),
        opaque_window: opaque_window(),
        top_edge: !is_wayland(),
        codex_links: codex_link_available(),
        credential_store: if cfg!(windows) {
            "Windows Credential Manager"
        } else {
            "Linux Secret Service"
        },
    }
}

pub fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn hook_name() -> &'static str {
    if cfg!(windows) {
        "coucou-hook.exe"
    } else {
        "coucou-hook"
    }
}

pub fn quiet_command(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

pub fn find_on_path(stem: &str) -> Option<PathBuf> {
    let dirs = std::env::var_os("PATH")?;
    #[cfg(windows)]
    let extensions: Vec<_> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .map(str::to_lowercase)
        .collect();
    #[cfg(not(windows))]
    let extensions = vec![String::new()];
    for dir in std::env::split_paths(&dirs) {
        for ext in &extensions {
            let path = dir.join(format!("{stem}{ext}"));
            if !path.is_file() {
                continue;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if path.metadata().ok()?.permissions().mode() & 0o111 == 0 {
                    continue;
                }
            }
            return Some(path);
        }
    }
    None
}

pub fn codex_executable() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        find_on_path("codex")
            .filter(|p| p.extension().is_some_and(|e| e == "exe"))
            .or_else(|| {
                std::env::var_os("LOCALAPPDATA")
                    .map(|p| PathBuf::from(p).join("Programs/OpenAI/Codex/bin/codex.exe"))
                    .filter(|p| p.is_file())
            })
    }
    #[cfg(not(windows))]
    {
        find_on_path("codex")
    }
}

pub fn open_target(target: &str) -> Result<(), String> {
    #[cfg(windows)]
    let mut command = {
        let mut c = Command::new("rundll32.exe");
        c.args(["url.dll,FileProtocolHandler", target]);
        c
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut c = Command::new("xdg-open");
        c.arg(target);
        c
    };
    quiet_command(&mut command)
        .spawn()
        .map(|_| ())
        .map_err(|_| "Could not open the target. Check your default application.".into())
}

fn codex_link_available() -> bool {
    #[cfg(windows)]
    {
        true
    }
    #[cfg(not(windows))]
    {
        Command::new("xdg-mime")
            .args(["query", "default", "x-scheme-handler/codex"])
            .output()
            .is_ok_and(|r| r.status.success() && !r.stdout.is_empty())
    }
}

pub fn stamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

#[cfg(test)]
mod tests;
