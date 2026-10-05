// Coucou for Windows — app wiring and the commands the island calls.

mod claude;
mod clickup;
mod codex;
mod files;
mod hooks;
mod integrations;
mod notifications;
#[cfg(windows)]
mod island;
#[cfg(target_os="linux")]
#[path="platform/island_linux.rs"]
mod island;
mod platform;
mod log;
mod pipe;
mod secrets;
mod settings;
mod tray;
#[cfg(windows)]
mod win_user;


use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

use claude::{Chat, ChatContext, ChatReply};
use files::DroppedFile;
use hooks::{HookPreview, HookStatus};
use island::{PollGate, ScreenInfo};
use pipe::Pending;
use settings::Settings;

/// Keeps spawned helpers from flashing a console window.


fn ensure_running()->Result<(),String>{if integrations::PAUSED.load(Ordering::Relaxed){Err("Coucou is paused. Resume to connect.".into())}else{Ok(())}}

#[tauri::command]
fn attachment_check(path:String,provider:String)->Result<(),String>{files::validate_attachment(&path,&provider)}

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
    pub chat_expanded: std::sync::atomic::AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    version: String,
    hook_path: String,
    capabilities: platform::Capabilities,
    show_requested: bool,
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>) -> BootInfo {
    let mut settings = shared.settings.lock().unwrap().clone();
    // The real state of ~/.claude/settings.json wins over whatever we stored.
    settings.hooks_installed = hooks::status().installed;
    let screen = island::screen_info(&app, &settings.screen);
    BootInfo {
        settings,
        screen,
        capabilities:platform::capabilities(),
        show_requested:std::env::args().any(|arg|arg=="--show"),
        version: env!("CARGO_PKG_VERSION").to_string(),
        hook_path: settings::hook_exe_path().to_string_lossy().to_string(),
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) -> Result<(),String> {
    settings::save(&settings).map_err(|e|format!("Could not save settings: {e}"))?;
    let quiet=settings.quiet_active();
    let (screen_changed, autostart_changed) = {
        let mut current = shared.settings.lock().unwrap();
        let screen_changed = current.screen != settings.screen;
        let autostart_changed = current.autostart != settings.autostart;
        *current = settings.clone();
        (screen_changed, autostart_changed)
    };
    if quiet {pipe::release_all(&app);}
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            eprintln!("[coucou] autostart: {err}");
        }
    }
    if screen_changed {
        let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
        island::apply_geometry(&app, &settings.screen, collapsed);
    }
    // Keep the other window in step (island ⇄ settings window).
    let _ = app.emit("settings-changed", settings);
    Ok(())
}

/// Hidden island → shrink the window to the invisible wake strip and park the
/// cursor poll; anything else → full panel and 60 Hz polling.
#[tauri::command]
fn set_collapsed(app: AppHandle, shared: State<Shared>, collapsed: bool) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    shared.gate.collapsed.store(collapsed, Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
    // The wake strip must always take the mouse, and a resize invalidates the flag.
    island::set_ignore_cursor(&app, false);
    shared.gate.forget_ignore_state();
    shared.gate.set_active(!collapsed);
}

/// The front end pushes the island shape; Rust decides click-through from it.
#[tauri::command]
fn set_island_rect(shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    shared.gate.set_rect(island::IslandRect { x, y, w: width, h: height });
}

#[tauri::command]
fn set_floating_size(app:AppHandle,width:f64,height:f64){
    #[cfg(target_os="linux")]
    if platform::is_wayland(){if let Some(win)=island::window(&app){
        let expanded=app.state::<Shared>().chat_expanded.load(Ordering::Relaxed);
        let screen=island::screen_info(&app,"primary");
        let _=win.set_size(tauri::LogicalSize::new(width.clamp(288.0,if expanded{960.0}else{640.0})+16.0,height.clamp(32.0,if expanded{(screen.height-24.0).max(32.0)}else{300.0})+24.0));
    }}
    #[cfg(windows)] let _=(app,width,height);
}

#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    let Some(win) = island::window(&app) else { return };
    island::set_activating(&win, focused);
    if focused {
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) -> ScreenInfo {
    let pref = shared.settings.lock().unwrap().screen.clone();
    let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
    island::screen_info(&app,&pref)
}

#[tauri::command]
fn set_chat_expanded(app: AppHandle, shared: State<Shared>, expanded: bool) -> ScreenInfo {
    shared.chat_expanded.store(expanded, Ordering::Relaxed);
    let pref=shared.settings.lock().unwrap().screen.clone();
    island::apply_geometry(&app,&pref,shared.gate.collapsed.load(Ordering::Relaxed));
    island::set_ignore_cursor(&app,false);
    shared.gate.forget_ignore_state();
    let screen=island::screen_info(&app,&pref);
    if platform::is_wayland(){if let Some(win)=island::window(&app){
        let _=win.set_size(tauri::LogicalSize::new(if expanded{976.0_f64.min(screen.width)}else{656.0},if expanded{screen.height}else{324.0}));
    }}
    screen
}

#[tauri::command]
fn open_url(url: String) -> Result<(),String> {
    let parsed=reqwest::Url::parse(&url).map_err(|_|"Invalid link")?;
    if !["http","https"].contains(&parsed.scheme()) || !parsed.username().is_empty() || parsed.password().is_some(){return Err("Only web links may be opened.".into());}
    platform::open_target(parsed.as_str())
}

#[tauri::command]
fn open_codex_chat(session_id:String)->Result<(),String>{
    let url=codex::chat_url(&session_id).ok_or("Invalid Codex session ID")?;
    if !platform::capabilities().codex_links {return Err("No Codex app is registered for chat links. Open the working folder or copy the session ID.".into());}
    platform::open_target(&url)
}

#[tauri::command]
fn open_in_vscode(path:Option<String>)->bool{
    if path.as_deref().is_some_and(|p|!p.is_empty() && !std::path::Path::new(p).is_absolute()){return false;}
    if let Some(code)=platform::find_on_path("code") {
        let mut command=Command::new(code);
        if let Some(p)=path.as_deref().filter(|p|!p.is_empty()){command.arg(p);}
        if platform::quiet_command(&mut command).spawn().is_ok(){return true;}
    }
    if let Some(p)=path.as_deref().filter(|p|!p.is_empty()) {
        #[cfg(windows)] {let mut command=Command::new("explorer");command.arg(p);let _=platform::quiet_command(&mut command).spawn();}
        #[cfg(not(windows))] {let _=platform::open_target(p);}
    }
    false
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Tray → Pause. Paused means paused: the pollers stop talking to the network,
/// not just the island stopping showing things.
#[tauri::command]
fn set_paused(app:AppHandle, paused: bool) {
    integrations::set_paused(paused);
    if paused{pipe::release_all(&app);}
}

#[tauri::command]
fn start_codex_monitor(app: AppHandle, session_ids: Vec<String>) {
    codex::start(app, session_ids);
}

#[tauri::command]
async fn clickup_setup(workspace: Option<String>) -> Result<serde_json::Value, String> {
    ensure_running()?;
    clickup::setup(workspace).await
}

#[tauri::command]
async fn clickup_send(shared: State<'_, Shared>, clickup: State<'_, clickup::Clickup>, query: String, local_time: String, selected_task: Option<String>) -> Result<clickup::Reply, String> {
    ensure_running()?;
    let settings = shared.settings.lock().unwrap().clone();
    clickup::send(&clickup, &settings, query, local_time, selected_task).await
}

#[tauri::command]
async fn clickup_confirm(shared: State<'_, Shared>, clickup: State<'_, clickup::Clickup>, id: u64) -> Result<serde_json::Value, String> {
    ensure_running()?;
    let settings = shared.settings.lock().unwrap().clone();
    clickup::confirm(&clickup, &settings, id).await
}

#[tauri::command]
async fn clickup_cancel(clickup: State<'_, clickup::Clickup>, id: u64) -> Result<(), String> {
    clickup::cancel(&clickup, id).await
}

// ── Claude Code hooks ─────────────────────────────────────────────────────────

#[tauri::command]
fn hooks_status() -> HookStatus {
    hooks::status()
}

/// Returns the diff the user has to look at before anything is written.
#[tauri::command]
fn hooks_preview(install: bool) -> Result<HookPreview, String> {
    hooks::preview(install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn hooks_apply(
    app: AppHandle,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
) -> Result<String, String> {
    // The fingerprint comes from the preview the user actually looked at, so a
    // settings.json that changed in between is refused rather than overwritten.
    let backup = hooks::write(install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.hooks_installed = install;
        let _ = settings::save(&current);
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

#[tauri::command]
fn approval_decision(app: AppHandle, request_id: String, decision: String) {
    pipe::answer(&app, &request_id, &decision);
}

/// The island has the card on screen, so the long wait for a human may begin.
/// Until this arrives the relay only waits a few hundred milliseconds, which is
/// what stops a paused or unresponsive island from freezing Claude Code.
#[tauri::command]
fn approval_ack(app: AppHandle, request_id: String) {
    pipe::acknowledge(&app, &request_id);
}

/// Nobody can act on this request — the island is paused, or another card is
/// already up. Claude Code falls back to asking in the terminal immediately.
#[tauri::command]
fn approval_decline(app: AppHandle, request_id: String) {
    pipe::decline(&app, &request_id);
}

// ── Chat, files and secrets ───────────────────────────────────────────────────

/// One chat turn. The API key and any file bytes stay on the Rust side.
#[tauri::command]
async fn chat_send(
    shared: State<'_, Shared>,
    chat: State<'_, Chat>,
    codex_chat: State<'_, codex::CodexChat>,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    ensure_running()?;
    let settings = shared.settings.lock().unwrap().clone();
    match settings.chat_provider.as_str() {
        "claude" => claude::send(&chat, &settings.model, query, context).await,
        "codex" => codex::chat_send(&codex_chat, query, context).await,
        _ => Err("Choose Codex or Claude in Settings → Chat.".into()),
    }
}

#[tauri::command]
async fn chat_reset(chat: State<'_, Chat>, codex_chat: State<'_, codex::CodexChat>) -> Result<(),String> {
    chat.reset();
    *codex_chat.0.lock().await = Default::default();
    Ok(())
}

/// Copies a dropped file into the inbox and reports its name back.
#[tauri::command]
fn ingest_file(path: String) -> Result<DroppedFile, String> {
    files::ingest(&path)
}

/// The island may only ask whether a key exists — never read it.
#[tauri::command]
fn secret_present(key: String) -> bool {
    secrets::present(&key)
}

#[tauri::command]
fn secret_status(key:String)->serde_json::Value {
    match secrets::status(&key){Ok(present)=>serde_json::json!({"present":present,"error":null}),Err(error)=>serde_json::json!({"present":false,"error":error})}
}

#[tauri::command]
fn chat_status(shared:State<Shared>)->serde_json::Value {
    let settings=shared.settings.lock().unwrap();
    let status=if settings.chat_provider=="claude" {secrets::status("anthropic-api-key")}else{Ok(platform::codex_executable().is_some())};
    match status{Ok(ready)=>serde_json::json!({"configured":ready}),Err(error)=>serde_json::json!({"configured":false,"error":error})}
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    secrets::set(&key, &value)?;
    if key=="github-token"{integrations::reset_github();}
    Ok(())
}

#[tauri::command]
fn secret_clear(key: String) -> Result<(), String> {
    secrets::clear(&key)?;
    if key=="github-token"{integrations::reset_github();}
    Ok(())
}

/// Opens the configured n8n instance — the URL lives in the Credential Manager.
#[tauri::command]
fn open_n8n() {
    if let Some(url) = secrets::get("n8n-url") {
        let _=open_url(url);
    }
}

/// Refresh buttons in the integration cards.
#[tauri::command]
async fn refresh_integration(app: AppHandle, id: String) {
    integrations::poll_once(app, &id).await;
}

/// Lets the island write to the same log as the Rust side.
#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

// ── Settings window ───────────────────────────────────────────────────────────

/// WebView2 allows exactly one browser environment per app, and its options are
/// fixed by whichever webview is created first. Every window must therefore ask
/// for the *same* arguments as the island (see `additionalBrowserArgs` in
/// tauri.conf.json) — a mismatch makes the second window come up blank, with no
/// error anywhere.
#[cfg(windows)]
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// In a dev build the pages are served by Vite, so the second window needs the
/// absolute dev URL; a bundled build resolves it inside the app bundle.
fn settings_page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/settings.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("settings.html".into())
}

/// The settings window is created hidden at launch and only ever shown and
/// hidden afterwards. A WebView2 window created later — on the main thread or
/// not — silently comes up blank in this app, so the window that works is the
/// one that exists before the island's webview does.
fn create_settings_window(app: &AppHandle) {
    let url = settings_page_url(app);
    let builder=WebviewWindowBuilder::new(app,"settings",url);
    #[cfg(windows)] let builder=builder.additional_browser_args(BROWSER_ARGS);
    let builder=if platform::is_wayland(){builder}else{builder.center()};
    match builder
        .title("Settings — Coucou")
        .inner_size(560.0, 680.0)
        .min_inner_size(460.0, 480.0)
        .resizable(true)
        .visible(false)
        .build()
    {
        Ok(win) => {
            // Closing it must only hide it, or it could never be reopened.
            let hidden = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                }
            });
        }
        Err(err) => log::line(format!("settings window failed: {err}")),
    }
}

pub fn show_settings_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("settings") else {
        log::line("settings window missing");
        return;
    };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

#[tauri::command]
fn open_settings_window(app: AppHandle) {
    show_settings_window(&app);
}

pub fn run() {
    let loaded = settings::load();
    let gate = Arc::new(PollGate::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win)=island::window(app){let _=win.show();let _=win.unminimize();}
            let _ = app.emit_to(island::WINDOW_LABEL, "tray", "open".to_string());
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(Shared {
            settings: Mutex::new(loaded.clone()),
            gate: gate.clone(),
            chat_expanded: std::sync::atomic::AtomicBool::new(false),
        })
        .manage(Pending::default())
        .manage(Chat::default())
        .manage(codex::CodexChat::default())
        .manage(clickup::Clickup::default())
        .invoke_handler(tauri::generate_handler![
            boot,
            notifications::desktop_notify,
            notifications::desktop_notification_test,
            clickup_setup,
            clickup_send,
            clickup_confirm,
            clickup_cancel,
            start_codex_monitor,
            save_settings,
            set_collapsed,
            set_chat_expanded,
            set_island_rect,
            set_floating_size,
            focus_window,
            reposition,
            open_url,
            open_in_vscode,
            open_codex_chat,
            quit_app,
            hooks_status,
            hooks_preview,
            hooks_apply,
            approval_decision,
            approval_ack,
            approval_decline,
            log_line,
            chat_send,
            chat_reset,
            ingest_file,
            attachment_check,
            secret_present,
            secret_status,
            chat_status,
            secret_set,
            secret_clear,
            refresh_integration,
            open_n8n,
            open_settings_window,
            set_paused,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            if let Err(err)=tray::build(&handle){log::line(format!("Tray unavailable: {err}"));}
            // Before the island: see create_settings_window.
            create_settings_window(&handle);

            if let Some(win) = island::window(&handle) {
                #[cfg(target_os="linux")]
                {
                    let hidden=win.clone();let app_handle=handle.clone();
                    win.on_window_event(move |event|{
                        if let tauri::WindowEvent::CloseRequested{api,..}=event{
                            api.prevent_close();pipe::release_all(&app_handle);let _=hidden.hide();
                            let _=app_handle.emit_to(island::WINDOW_LABEL,"tray","hide".to_string());
                        }
                    });
                }
                island::make_non_activating(&win);
                island::apply_geometry(&handle, &loaded.screen, false);
                let _ = win.show();
            }
            gate.collapsed.store(false, Ordering::Relaxed);
            gate.set_active(true);
            island::spawn_cursor_poll(handle.clone(), gate.clone());

            log::line(format!("--- Coucou {} started ---", env!("CARGO_PKG_VERSION")));
            hooks::ensure_hook_exe(&handle);
            pipe::start(handle.clone());
            integrations::start(handle.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Coucou");
}
