// File notifications share one interface; the Linux watcher sleeps until a write.
use std::{io, path::Path};
#[cfg(windows)]
pub struct Watcher(windows::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl Watcher {
    pub fn new(root: &Path, _home: &Path) -> io::Result<Self> {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::Storage::FileSystem::*;
        let wide: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            FindFirstChangeNotificationW(
                windows::core::PCWSTR(wide.as_ptr()),
                true,
                FILE_NOTIFY_CHANGE_FILE_NAME
                    | FILE_NOTIFY_CHANGE_DIR_NAME
                    | FILE_NOTIFY_CHANGE_SIZE
                    | FILE_NOTIFY_CHANGE_LAST_WRITE,
            )
        }
        .map(Self)
        .map_err(io::Error::other)
    }
    pub fn wait(&mut self) -> bool {
        use windows::Win32::{
            Foundation::WAIT_OBJECT_0, Storage::FileSystem::FindNextChangeNotification,
            System::Threading::WaitForSingleObject,
        };
        // Timeout lets pause changes and session titles be reconciled.
        let result = unsafe { WaitForSingleObject(self.0, 3000) };
        result.0 == 258
            || (result == WAIT_OBJECT_0 && unsafe { FindNextChangeNotification(self.0) }.is_ok())
    }
}
#[cfg(windows)]
impl Drop for Watcher {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Storage::FileSystem::FindCloseChangeNotification(self.0);
        }
    }
}

#[cfg(target_os = "linux")]
pub struct Watcher {
    _watch: notify::RecommendedWatcher,
    rx: std::sync::mpsc::Receiver<WatchMessage>,
    root: std::path::PathBuf,
    home: std::path::PathBuf,
    watched: std::path::PathBuf,
}
#[cfg(target_os = "linux")]
enum WatchMessage {
    File(notify::Result<notify::Event>),
    Control,
}
#[cfg(target_os = "linux")]
static CONTROL: std::sync::LazyLock<
    std::sync::Mutex<Option<std::sync::mpsc::Sender<WatchMessage>>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(None));
pub fn wake() {
    #[cfg(target_os = "linux")]
    if let Some(sender) = CONTROL.lock().unwrap().as_ref() {
        let _ = sender.send(WatchMessage::Control);
    }
}
#[cfg(target_os = "linux")]
fn nearest_directory(root: &Path) -> &Path {
    root.ancestors().find(|path| path.is_dir()).unwrap_or(root)
}
#[cfg(target_os = "linux")]
impl Watcher {
    pub fn new(root: &Path, home: &Path) -> io::Result<Self> {
        use notify::Watcher as _;
        let (tx, rx) = std::sync::mpsc::channel();
        *CONTROL.lock().unwrap() = Some(tx.clone());
        let mut watch = notify::recommended_watcher(move |event| {
            let _ = tx.send(WatchMessage::File(event));
        })
        .map_err(io::Error::other)?;
        watch
            .watch(nearest_directory(root), notify::RecursiveMode::Recursive)
            .map_err(io::Error::other)?;
        if home.is_dir() && home != nearest_directory(root) {
            watch
                .watch(home, notify::RecursiveMode::NonRecursive)
                .map_err(io::Error::other)?;
        }
        Ok(Self {
            _watch: watch,
            rx,
            root: root.to_path_buf(),
            home: home.to_path_buf(),
            watched: nearest_directory(root).to_path_buf(),
        })
    }
    pub fn wait(&mut self) -> bool {
        if nearest_directory(&self.root) != self.watched {
            match Self::new(&self.root, &self.home) {
                Ok(next) => *self = next,
                Err(err) => {
                    crate::log::line(format!("Codex watcher: {err}"));
                    return false;
                }
            }
        }
        loop {
            match self.rx.recv() {
                Ok(WatchMessage::Control) => return true,
                Ok(WatchMessage::File(Ok(event)))
                    if matches!(
                        event.kind,
                        notify::EventKind::Create(_)
                            | notify::EventKind::Modify(_)
                            | notify::EventKind::Remove(_)
                    ) =>
                {
                    return true
                }
                Ok(WatchMessage::File(Err(err))) => {
                    crate::log::line(format!("Codex watcher: {err}"));
                    return false;
                }
                Ok(_) => continue,
                Err(_) => return false,
            }
        }
    }
}
