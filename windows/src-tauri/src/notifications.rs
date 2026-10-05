//! Native desktop alerts. Task monitoring and saved inbox history remain separate.
use serde::Deserialize;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager};

#[derive(Deserialize)]
pub struct DesktopAlert {
    pub source: String,
    pub title: String,
    pub message: String,
}

fn allowed(settings: &crate::settings::Settings, source: &str, paused: bool) -> bool {
    settings.desktop_notifications && !settings.quiet_active() && !paused
        && settings.notification_preferences.get(source).is_none_or(|pref| pref != "off")
}

#[tauri::command]
pub fn desktop_notify(app: AppHandle, alert: DesktopAlert) -> Result<(), String> {
    let shared = app.state::<crate::Shared>();
    let settings = shared.settings.lock().unwrap().clone();
    if !allowed(&settings, &alert.source, crate::integrations::PAUSED.load(Ordering::Relaxed)) {
        return Ok(());
    }
    show(&app, &alert.title, &alert.message)
}

#[tauri::command]
pub fn desktop_notification_test(app: AppHandle) -> Result<(), String> {
    let shared = app.state::<crate::Shared>();
    let settings = shared.settings.lock().unwrap().clone();
    if !allowed(&settings, "Coucou", crate::integrations::PAUSED.load(Ordering::Relaxed)) {
        return Err("Enable desktop notifications and turn off Quiet mode or Pause to test.".into());
    }
    show(&app, "Coucou", "Desktop notifications are ready. New alerts also stay in your attention inbox.")
}

fn text(value: &str, max: usize) -> String {
    value.chars().filter(|c| !c.is_control() || *c == '\n').take(max).collect()
}

#[cfg(windows)]
fn xml(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
        .replace('"', "&quot;").replace('\'', "&apos;")
}

#[cfg(windows)]
fn show(app: &AppHandle, title: &str, message: &str) -> Result<(), String> {
    use windows::{core::HSTRING, Data::Xml::Dom::XmlDocument, UI::Notifications::{ToastNotification, ToastNotificationManager}};
    let send = || -> windows::core::Result<()> {
        let document = XmlDocument::new()?;
        // Coucou already plays its chosen sound; prevent a second OS chime.
        document.LoadXml(&HSTRING::from(format!(
            "<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual><audio silent=\"true\"/></toast>",
            xml(&text(title, 200)), xml(&text(message, 500))
        )))?;
        let toast = ToastNotification::CreateToastNotification(&document)?;
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app.config().identifier.as_str()))?.Show(&toast)
    };
    send().map_err(|_| "Windows could not display the notification. Install Coucou with its installer and enable Coucou in Windows notification settings.".into())
}

#[cfg(target_os = "linux")]
fn show(_app: &AppHandle, title: &str, message: &str) -> Result<(), String> {
    let binary = crate::platform::find_on_path("notify-send")
        .ok_or("Desktop notifications need notify-send. Install libnotify-bin and enable your desktop notification service.")?;
    let mut command = std::process::Command::new(binary);
    command.args(["--app-name=Coucou", "--hint=boolean:suppress-sound:true", "--", &text(title, 200), &text(message, 500)]);
    crate::platform::quiet_command(&mut command).spawn()
        .map(|mut child| { std::thread::spawn(move || { let _ = child.wait(); }); })
        .map_err(|_| "Your desktop notification service could not be reached.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quiet_pause_and_service_preferences_suppress_native_alerts() {
        let mut settings = crate::settings::Settings::default();
        assert!(allowed(&settings, "integration_github", false));
        assert!(!allowed(&settings, "integration_github", true));
        settings.quiet_until = Some(0);
        assert!(!allowed(&settings, "integration_github", false));
        settings.quiet_until = None;
        settings.notification_preferences.insert("integration_github".into(), "off".into());
        assert!(!allowed(&settings, "integration_github", false));
        assert!(allowed(&settings, "codex", false));
        settings.desktop_notifications = false;
        assert!(!allowed(&settings, "codex", false));
    }
    #[test]
    fn notification_text_is_bounded_and_has_no_control_characters() {
        assert_eq!(text("Hi\0\x1b\nworld", 6), "Hi\nwor");
        assert_eq!(text("🦊🦊🦊", 2), "🦊🦊");
    }
    #[cfg(windows)]
    #[test]
    fn provider_text_cannot_inject_toast_markup() {
        assert_eq!(xml("<&>\"'"), "&lt;&amp;&gt;&quot;&apos;");
    }
}
