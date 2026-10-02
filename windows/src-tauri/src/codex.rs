// Passive Codex adapter. Read rollouts only; never launch Codex or answer approvals.
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use windows::core::PCWSTR;
use windows::Win32::Foundation::WAIT_OBJECT_0;
use windows::Win32::Storage::FileSystem::{
    FindCloseChangeNotification, FindFirstChangeNotificationW, FindNextChangeNotification,
    FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_FILE_NAME,
    FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE,
};
use windows::Win32::System::Threading::{WaitForSingleObject, INFINITE};

static STARTED: AtomicBool = AtomicBool::new(false);
const MAX_LINE: u64 = 1024 * 1024;

/// Only a UUID may enter the installed Codex app's thread link.
pub fn chat_url(session_id: &str) -> Option<String> {
    let valid = session_id.len() == 36 && session_id.bytes().enumerate().all(|(i, b)| {
        if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() }
    });
    valid.then(|| format!("codex://threads/{session_id}"))
}

pub fn start(app: AppHandle) {
    if STARTED.swap(true, Ordering::Relaxed) { return; }
    let home = std::env::var_os("CODEX_HOME").map(PathBuf::from).or_else(|| {
        std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join(".codex"))
    });
    let Some(home) = home else { return };
    std::thread::spawn(move || {
        let root = home.join("sessions");
        // Codex may not have been installed/run yet. No history or settings writes.
        while !root.is_dir() { std::thread::sleep(Duration::from_secs(5)); }
        let wide: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
        let watch = unsafe { FindFirstChangeNotificationW(
            PCWSTR(wide.as_ptr()), true,
            FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME
                | FILE_NOTIFY_CHANGE_SIZE | FILE_NOTIFY_CHANGE_LAST_WRITE,
        ) };
        let handle = match watch {
            Ok(handle) => handle,
            Err(err) => { crate::log::line(format!("Codex monitor: {err}")); return; }
        };
        let mut tails = HashMap::new();
        let emit = |event| { let _ = app.emit_to(crate::island::WINDOW_LABEL, "agent", event); };
        scan(&root, &mut tails, true, &emit);
        // Native notification sleeps until a write, even while the island is hidden.
        while unsafe { WaitForSingleObject(handle, INFINITE) } == WAIT_OBJECT_0 {
            if unsafe { FindNextChangeNotification(handle) }.is_err() { break; }
            scan(&root, &mut tails, false, &emit);
        }
        unsafe { let _ = FindCloseChangeNotification(handle); }
        crate::log::line("Codex monitor stopped");
    });
}

// ponytail: scan file metadata on writes; use per-file notifications if history grows costly.
fn scan(root: &Path, tails: &mut HashMap<PathBuf, Tail>, baseline: bool, emit: &impl Fn(Value)) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        if kind.is_dir() {
            scan(&path, tails, baseline, emit);
        } else if kind.is_file()
            && path.extension().is_some_and(|ext| ext == "jsonl")
            && entry.file_name().to_string_lossy().starts_with("rollout-") {
            let tail = tails.entry(path.clone()).or_default();
            let result = if baseline { tail.baseline(&path) } else { tail.read(&path, emit) };
            if let Err(err) = result {
                crate::log::line(format!("Codex rollout read: {err}"));
            }
        }
    }
}

#[derive(Default)]
struct Tail {
    offset: u64,
    session_id: String,
    cwd: String,
    skipping: bool,
}

impl Tail {
    fn baseline(&mut self, path: &Path) -> io::Result<()> {
        let file = File::open(path)?;
        let length = file.metadata()?.len();
        let mut line = Vec::new();
        BufReader::new(file).take(MAX_LINE + 1).read_until(b'\n', &mut line)?;
        if let Ok(record) = serde_json::from_slice::<Value>(&line) { self.record(&record); }
        // Old completions must not generate sounds or alerts when Coucou starts.
        self.offset = length;
        Ok(())
    }

    fn read(&mut self, path: &Path, emit: &impl Fn(Value)) -> io::Result<()> {
        let mut file = File::open(path)?;
        let length = file.metadata()?.len();
        if length < self.offset { *self = Self::default(); }
        if length == self.offset { return Ok(()); }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut reader = BufReader::new(file);
        loop {
            let mut line = Vec::new();
            let n = reader.by_ref().take(MAX_LINE + 1).read_until(b'\n', &mut line)?;
            if n == 0 { break; }
            let complete = line.last() == Some(&b'\n');
            if self.skipping || n as u64 > MAX_LINE {
                self.offset += n as u64;
                self.skipping = !complete;
                continue;
            }
            // The writer may have flushed half a JSON record or UTF-8 character.
            if !complete { break; }
            self.offset += n as u64;
            if let Ok(record) = serde_json::from_slice::<Value>(&line) {
                if let Some(event) = self.record(&record) { emit(event); }
            }
        }
        Ok(())
    }

    fn record(&mut self, record: &Value) -> Option<Value> {
        let payload = record.get("payload")?;
        let mut event = match text(record, "type") {
            "session_meta" => {
                self.session_id = clipped(text(payload, "id"), 128);
                if self.session_id.is_empty() { self.session_id = clipped(text(payload, "session_id"), 128); }
                self.cwd = clipped(text(payload, "cwd"), 2048);
                json!({"type": "session_started"})
            }
            "turn_context" => {
                if !text(payload, "cwd").is_empty() { self.cwd = clipped(text(payload, "cwd"), 2048); }
                return None;
            }
            "event_msg" => match text(payload, "type") {
                "task_started" | "turn_started" => json!({"type": "session_started"}),
                "task_complete" | "turn_complete" => json!({
                    "type": "session_completed", "message": clipped(text(payload, "last_agent_message"), 60)
                }),
                "turn_aborted" => json!({"type": "error", "message": "Turn interrupted"}),
                "error" => json!({"type": "error", "message": clipped(text(payload, "message"), 200)}),
                "exec_command_begin" => json!({"type": "command", "tool_name": "Command",
                    "tool_input": {"command": command(&payload["command"])}}),
                "exec_command_end" => {
                    if payload["exit_code"].as_i64().is_some_and(|n| n != 0) {
                        json!({"type": "error", "fatal": false, "message": "⚠ command failed"})
                    } else { json!({"type": "activity", "state": "working"}) }
                }
                "patch_apply_begin" => json!({"type": "file_edit", "tool_name": "Edit"}),
                "patch_apply_end" if payload["success"] == false =>
                    json!({"type": "error", "fatal": false, "message": "⚠ edit failed"}),
                "item_completed" => item_event(&payload["item"])? ,
                _ => return None,
            },
            "response_item" => match text(payload, "type") {
                "function_call" | "custom_tool_call" => tool_event(payload),
                _ => return None,
            },
            _ => return None,
        };
        if self.session_id.is_empty() { return None; }
        event["source"] = json!("codex");
        event["session_id"] = json!(self.session_id);
        event["cwd"] = json!(self.cwd);
        Some(event)
    }
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str { value[key].as_str().unwrap_or("") }
fn clipped(value: &str, count: usize) -> String { value.chars().take(count).collect() }
fn command(value: &Value) -> String {
    if let Some(args) = value.as_array() {
        clipped(&args.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "), 2000)
    } else { clipped(value.as_str().unwrap_or(""), 2000) }
}

fn tool_event(payload: &Value) -> Value {
    let name = text(payload, "name");
    let args: Value = serde_json::from_str(text(payload, "arguments")).unwrap_or(Value::Null);
    if ["exec_command", "shell_command", "shell"].contains(&name) {
        let cmd = args.get("cmd").or_else(|| args.get("command")).unwrap_or(&Value::Null);
        json!({"type": "command", "tool_name": "Command", "tool_input": {"command": command(cmd)}})
    } else if name == "apply_patch" {
        let paths = text(payload, "input").lines().filter_map(|line| {
            ["*** Add File: ", "*** Update File: ", "*** Delete File: "]
                .iter().find_map(|prefix| line.strip_prefix(prefix))
        }).take(3).map(|path| clipped(path, 200)).collect::<Vec<_>>().join(", ");
        json!({"type": "file_edit", "tool_name": "Edit", "message": paths})
    } else {
        // Do not forward arbitrary tool input, code, outputs, credentials or history.
        json!({"type": "activity", "state": "working", "tool_name": clipped(name, 80)})
    }
}

fn item_event(item: &Value) -> Option<Value> {
    match text(item, "type") {
        "CommandExecution" | "commandExecution" => {
            if item["exit_code"].as_i64().is_some_and(|n| n != 0) {
                Some(json!({"type": "error", "fatal": false, "message": "⚠ command failed"}))
            } else {
                Some(json!({"type": "command", "tool_name": "Command",
                    "tool_input": {"command": command(&item["command"])}}))
            }
        }
        "FileChange" | "fileChange" => Some(json!({"type": "file_edit", "tool_name": "Edit"})),
        "McpToolCall" | "mcpToolCall" => Some(json!({"type": "activity", "state": "working",
            "tool_name": clipped(text(item, "tool"), 80)})),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::Mutex;

    #[test]
    fn chat_links_accept_only_thread_uuids() {
        let id = "01a0fb98-fb4b-7491-9c9f-96e6ee07ab9e";
        assert_eq!(chat_url(id), Some(format!("codex://threads/{id}")));
        assert!(chat_url(&id.to_uppercase()).is_some());
        for invalid in ["", "../settings", "not-a-thread", "01a0fb98-fb4b-7491-9c9f-96e6ee07ab9e?prompt=x",
            "01a0fb98-fb4b-7491-9c9f-96e6ee07ab9g", "01a0fb98/fb4b-7491-9c9f-96e6ee07ab9e"] {
            assert!(chat_url(invalid).is_none());
        }
    }

    #[test]
    fn codex_normalizes_lifecycle_tools_and_ignores_unknown_records() {
        let mut tail = Tail::default();
        let start = tail.record(&json!({"type":"session_meta", "payload":{"id":"s1","cwd":"C:/repo"}})).unwrap();
        assert_eq!(start["source"], "codex");
        assert_eq!(start["type"], "session_started");
        for (kind, expected) in [("task_started","session_started"), ("task_complete","session_completed"),
            ("turn_aborted","error"), ("error","error")] {
            let event = tail.record(&json!({"type":"event_msg","payload":{"type":kind}})).unwrap();
            assert_eq!(event["type"], expected);
            assert_eq!(event["session_id"], "s1");
        }
        let cmd = tail.record(&json!({"type":"response_item","payload":{"type":"function_call",
            "name":"exec_command","arguments":"{\"cmd\":\"git status\"}"}})).unwrap();
        assert_eq!(cmd["tool_input"]["command"], "git status");
        let edit = tool_event(&json!({"name":"apply_patch","input":"*** Update File: src/main.rs\n+private content"}));
        assert_eq!(edit["type"], "file_edit");
        assert!(!edit.to_string().contains("private content"));
        assert_eq!(item_event(&json!({"type":"CommandExecution","exit_code":1})).unwrap()["fatal"], false);
        assert!(tail.record(&json!({"type":"event_msg","payload":{"type":"token_count"}})).is_none());
        assert!(tail.record(&json!({"type":"response_item","payload":{"type":"message"}})).is_none());
    }

    #[test]
    fn tails_skip_history_retry_partial_lines_and_recover_after_truncation() {
        let path = std::env::temp_dir().join(format!("coucou-codex-test-{}.jsonl", std::process::id()));
        let meta = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"s1\",\"cwd\":\"C:/repo\"}}\n";
        fs::write(&path, format!("{meta}{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"task_complete\"}}}}\n")).unwrap();
        let events = Mutex::new(Vec::new());
        let emit = |e| events.lock().unwrap().push(e);
        let mut tail = Tail::default();
        tail.baseline(&path).unwrap();
        tail.read(&path, &emit).unwrap();
        assert!(events.lock().unwrap().is_empty());
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"bad json\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_").unwrap();
        tail.read(&path, &emit).unwrap();
        assert!(events.lock().unwrap().is_empty());
        file.write_all(b"started\"}}\n").unwrap();
        tail.read(&path, &emit).unwrap();
        assert_eq!(events.lock().unwrap()[0]["type"], "session_started");
        // Oversized records are discarded in bounded chunks, then normal events resume.
        file.write_all(&vec![b'x'; MAX_LINE as usize + 20]).unwrap();
        file.write_all(b"\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}\n").unwrap();
        tail.read(&path, &emit).unwrap();
        assert_eq!(events.lock().unwrap().len(), 2);
        drop(file);
        fs::write(&path, meta).unwrap();
        tail.read(&path, &emit).unwrap();
        assert_eq!(events.lock().unwrap().len(), 3);
        fs::remove_file(&path).unwrap();
    }
}
