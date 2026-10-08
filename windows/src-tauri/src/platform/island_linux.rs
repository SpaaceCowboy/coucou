// GNOME: a movable window on Wayland, a top-edge island on X11.
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Condvar, Mutex,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow};
use x11rb::{connection::Connection, protocol::xproto::ConnectionExt};

pub const WINDOW_LABEL: &str = "island";
const PANEL_W: f64 = 720.0;
const PANEL_H: f64 = 320.0;
#[derive(Serialize, Clone)]
pub struct ScreenInfo {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}
#[derive(Clone, Copy, Default)]
pub struct IslandRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}
pub struct PollGate {
    active: Mutex<bool>,
    cv: Condvar,
    pub collapsed: AtomicBool,
    pub rect: Mutex<IslandRect>,
    ignoring: AtomicBool,
}
impl PollGate {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(false),
            cv: Condvar::new(),
            collapsed: AtomicBool::new(true),
            rect: Mutex::new(IslandRect::default()),
            ignoring: AtomicBool::new(false),
        }
    }
    pub fn set_rect(&self, rect: IslandRect) {
        *self.rect.lock().unwrap() = rect;
    }
    pub fn forget_ignore_state(&self) {
        self.ignoring.store(false, Ordering::Relaxed);
    }
    pub fn set_active(&self, on: bool) {
        *self.active.lock().unwrap() = on;
        self.cv.notify_all();
    }
    fn wait(&self) {
        let mut active = self.active.lock().unwrap();
        while !*active {
            active = self.cv.wait(active).unwrap();
        }
    }
}
pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}
pub fn screen_info(app: &AppHandle, _pref: &str) -> ScreenInfo {
    if let Some(m) = app.primary_monitor().ok().flatten() {
        let scale = m.scale_factor();
        let p = m.position();
        let s = m.size();
        ScreenInfo {
            x: p.x as f64 / scale,
            y: p.y as f64 / scale,
            width: s.width as f64 / scale,
            height: s.height as f64 / scale,
            scale,
        }
    } else {
        ScreenInfo {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
            scale: 1.0,
        }
    }
}
pub fn make_non_activating(win: &WebviewWindow) {
    let floating = crate::platform::is_wayland();
    let _ = win.set_decorations(floating);
    let _ = win.set_skip_taskbar(!floating);
    let _ = win.set_always_on_top(!floating);
}
pub fn set_activating(_win: &WebviewWindow, _focused: bool) {}
pub fn apply_geometry(app: &AppHandle, pref: &str, collapsed: bool) {
    let Some(win) = window(app) else { return };
    if crate::platform::floating_window() {
        // The frontend sizes the panel; retain placement when reopening.
        if crate::platform::opaque_window() {
            let result = if collapsed { win.hide() } else { win.show() };
            if let Err(error) = result {
                crate::log::line(format!("Floating window visibility failed: {error}"));
            }
        }
        return;
    }
    let screen = screen_info(app, pref);
    let (w, h) = if collapsed {
        (240.0, 6.0)
    } else if app.try_state::<crate::Shared>().is_some_and(|shared|shared.chat_expanded.load(Ordering::Relaxed)) {
        (1040.0_f64.min(screen.width),screen.height)
    } else {
        (PANEL_W, PANEL_H)
    };
    let _ = win.set_size(LogicalSize::new(w, h));
    let _ = win.set_position(LogicalPosition::new(
        screen.x + (screen.width - w) / 2.0,
        screen.y,
    ));
}
pub fn set_ignore_cursor(app: &AppHandle, ignore: bool) {
    if !crate::platform::floating_window() {
        if let Some(win) = window(app) {
            let _ = win.set_ignore_cursor_events(ignore);
        }
    }
}
pub fn spawn_cursor_poll(app: AppHandle, gate: Arc<PollGate>) {
    if crate::platform::floating_window() {
        return;
    } // DOM pointer events; no background polling.
    std::thread::spawn(move || {
        let Ok((connection, screen)) = x11rb::connect(None) else {
            return;
        };
        let root = connection.setup().roots[screen].root;
        loop {
            gate.wait();
            let pointer = connection
                .query_pointer(root)
                .ok()
                .and_then(|cookie| cookie.reply().ok());
            let Some(pointer) = pointer else { break };
            let Some(win) = window(&app) else { break };
            let Ok(pos) = win.outer_position() else { break };
            let scale = win.scale_factor().unwrap_or(1.0);
            let x = (pointer.root_x as f64 - pos.x as f64) / scale;
            let y = (pointer.root_y as f64 - pos.y as f64) / scale;
            let rect = *gate.rect.lock().unwrap();
            let outside = x < rect.x - 14.0
                || x > rect.x + rect.w + 14.0
                || y < rect.y
                || y > rect.y + rect.h + 14.0;
            if gate.ignoring.load(Ordering::Relaxed) != outside {
                set_ignore_cursor(&app, outside);
                gate.ignoring.store(outside, Ordering::Relaxed);
            }
            let _ = app.emit_to(WINDOW_LABEL, "cursor", serde_json::json!({"x":x,"y":y}));
            std::thread::sleep(Duration::from_millis(16));
        }
    });
}
