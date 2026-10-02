// Passive Codex adapter. Read rollouts only; never launch Codex or answer approvals.
use std::collections::{HashMap, HashSet};
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
use windows::Win32::System::Threading::{WaitForSingleObject};

static STARTED: AtomicBool = AtomicBool::new(false);
const MAX_LINE: u64 = 1024 * 1024;

/// Only a UUID may enter the installed Codex app's thread link.
pub fn chat_url(session_id: &str) -> Option<String> {
    let valid = session_id.len() == 36 && session_id.bytes().enumerate().all(|(i, b)| {
        if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() }
    });
    valid.then(|| format!("codex://threads/{session_id}"))
}

pub fn home() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME").map(PathBuf::from).or_else(|| {
        std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join(".codex"))
    })
}

pub fn start(app: AppHandle, session_ids: Vec<String>) {
    if STARTED.swap(true, Ordering::Relaxed) { return; }
    let Some(home) = home() else { return };
    std::thread::spawn(move || {
        let restore: HashSet<String> = session_ids.into_iter().collect();
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
        let mut titles = HashMap::new();
        let mut index_stamp = None;
        loop {
            let path = home.join("session_index.jsonl");
            let stamp = fs::metadata(&path).ok().map(|m| (m.len(), m.modified().ok()));
            if stamp != index_stamp {
                let next = read_titles(&path);
                for (id, title) in &next {
                    if titles.get(id) != Some(title) {
                        let _ = app.emit_to(crate::island::WINDOW_LABEL, "agent", json!({
                            "source":"codex", "type":"session_metadata", "session_id":id, "title":title
                        }));
                    }
                }
                titles = next; index_stamp = stamp;
            }
            let emit = |mut event: Value| {
                if event["cwd"].as_str().is_some_and(|cwd| ["clickup","chat"].iter().any(|name| Path::new(cwd) == crate::settings::local_dir().join(name))) { return; }
                if let Some(title) = titles.get(text(&event, "session_id")) { event["title"] = json!(title); }
                let _ = app.emit_to(crate::island::WINDOW_LABEL, "agent", event);
            };
            if tails.is_empty() { scan(&root, &mut tails, true, &restore, &emit); }
            let result = unsafe { WaitForSingleObject(handle, 3000) };
            if result == WAIT_OBJECT_0 {
                if unsafe { FindNextChangeNotification(handle) }.is_err() { break; }
                scan(&root, &mut tails, false, &restore, &emit);
            } else if result.0 != 258 { break; }
        }
        unsafe { let _ = FindCloseChangeNotification(handle); }
        crate::log::line("Codex monitor stopped");
    });
}

// ponytail: scan file metadata on writes; use per-file notifications if history grows costly.
fn scan(root: &Path, tails: &mut HashMap<PathBuf, Tail>, baseline: bool, restore: &HashSet<String>, emit: &impl Fn(Value)) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        if kind.is_dir() {
            scan(&path, tails, baseline, restore, emit);
        } else if kind.is_file()
            && path.extension().is_some_and(|ext| ext == "jsonl")
            && entry.file_name().to_string_lossy().starts_with("rollout-") {
            let tail = tails.entry(path.clone()).or_default();
            let result = if baseline {
                tail.baseline(&path).map(|_| {
                    if restore.contains(&tail.session_id) {
                        if tail.internal_review {
                            emit(json!({"source":"codex","type":"session_metadata","session_id":tail.session_id,"internal_review":true}));
                        } else if let Some(event) = tail.snapshot(&path) { emit(event); }
                    }
                })
            } else { tail.read(&path, emit) };
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
    internal_review: bool,
}

// Titles are appended; the latest entry for each thread wins.
fn read_titles(path: &Path) -> HashMap<String, String> {
    let mut titles = HashMap::new();
    if let Ok(file) = File::open(path) {
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                let id = text(&v, "id"); let title = text(&v, "thread_name");
                if chat_url(id).is_some() && !title.is_empty() { titles.insert(id.to_owned(), clipped(title, 160)); }
            }
        }
    }
    titles
}

impl Tail {
    fn snapshot(&mut self, path: &Path) -> Option<Value> {
        // ponytail: inspect only the last 1 MiB at startup; restore saved state if a single record exceeds this.
        let mut file = File::open(path).ok()?;
        let length = file.metadata().ok()?.len();
        let start = length.saturating_sub(MAX_LINE);
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut reader = BufReader::new(file);
        if start > 0 { let mut partial = String::new(); let _ = reader.read_line(&mut partial); }
        let mut state = None;
        for line in reader.lines().map_while(Result::ok) {
            if let Ok(record) = serde_json::from_str::<Value>(&line) {
                if let Some(event) = self.record(&record) {
                    state = match text(&event, "type") {
                        "session_started" => Some("thinking"),
                        "activity" | "command" | "file_edit" => Some("working"),
                        "session_completed" => Some("finished"),
                        "session_ended" => Some("idle"),
                        "waiting" => Some("question"),
                        "error" => Some(if event["fatal"] == false { "working" } else { "error" }),
                        _ => state,
                    };
                }
            }
        }
        state.map(|state| json!({"source":"codex","type":"session_snapshot", "session_id":self.session_id,
            "cwd":self.cwd,"snapshot_state":state}))
    }

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
                self.internal_review = payload.pointer("/source/subagent/other").and_then(Value::as_str) == Some("guardian");
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
                "request_user_input" | "elicitation_request" => json!({"type": "waiting", "message": "Codex is waiting for your input."}),
                "exec_approval_request" | "apply_patch_approval_request" | "request_permissions" =>
                    json!({"type": "waiting", "message": "Codex is waiting for your approval."}),
                "thread_goal_updated" if matches!(text(&payload["goal"], "status"), "blocked" | "paused" | "usageLimited" | "budgetLimited") =>
                    json!({"type": "waiting", "message": "Codex goal is pending or blocked; check the chat."}),
                "stream_error" => json!({"type": "error", "fatal": false, "message": "Codex connection failed; retrying."}),
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
        if self.internal_review || self.session_id.is_empty() { return None; }
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
    if matches!(name.rsplit('.').next(), Some("request_user_input" | "request_user_input_async")) {
        json!({"type": "waiting", "message": "Codex is waiting for your input."})
    } else if ["exec_command", "shell_command", "shell"].contains(&name) {
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
    fn titles_use_latest_entry_and_snapshots_are_silent() {
        let path = std::env::temp_dir().join(format!("coucou-title-test-{}.jsonl",std::process::id()));
        let id = "01a0fb98-fb4b-7491-9c9f-96e6ee07ab9e";
        fs::write(&path,format!("{}\ninvalid\n{}\n",json!({"id":id,"thread_name":"Old"}),json!({"id":id,"thread_name":"New"}))).unwrap();
        assert_eq!(read_titles(&path).get(id).unwrap(),"New");
        fs::write(&path,format!("{}\n{}\n",json!({"type":"session_meta","payload":{"id":id,"cwd":"C:/repo"}}),json!({"type":"event_msg","payload":{"type":"task_complete"}}))).unwrap();
        let mut tail = Tail::default(); tail.baseline(&path).unwrap();
        assert_eq!(tail.snapshot(&path).unwrap()["snapshot_state"],"finished");
        let events = Mutex::new(Vec::new());tail.read(&path,&|e|events.lock().unwrap().push(e)).unwrap();
        assert!(events.lock().unwrap().is_empty());fs::remove_file(path).unwrap();
    }

    #[test]
    fn internal_guardian_reviews_never_become_chat_events() {
        let mut tail = Tail::default();
        assert!(tail.record(&json!({"type":"session_meta","payload":{"id":"review","source":{"subagent":{"other":"guardian"}}}})).is_none());
        assert!(tail.internal_review);
        for kind in ["task_started","task_complete","error"] {
            assert!(tail.record(&json!({"type":"event_msg","payload":{"type":kind}})).is_none());
        }
        let mut normal = Tail::default();
        assert!(normal.record(&json!({"type":"session_meta","payload":{"id":"chat","source":"vscode"}})).is_some());
    }

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
        for kind in ["request_user_input", "elicitation_request", "exec_approval_request", "apply_patch_approval_request", "request_permissions"] {
            assert_eq!(tail.record(&json!({"type":"event_msg","payload":{"type":kind}})).unwrap()["type"], "waiting");
        }
        assert_eq!(tool_event(&json!({"name":"functions.request_user_input"}))["type"], "waiting");
        for status in ["blocked", "paused", "usageLimited", "budgetLimited"] {
            assert_eq!(tail.record(&json!({"type":"event_msg","payload":{"type":"thread_goal_updated","goal":{"status":status}}})).unwrap()["type"], "waiting");
        }
        assert!(tail.record(&json!({"type":"event_msg","payload":{"type":"thread_goal_updated","goal":{"status":"active"}}})).is_none());
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

// The chat view keeps its own conversation, separate from ClickUp proposals.
#[derive(Default)]
pub struct CodexChat(pub tokio::sync::Mutex<Conversation>);
#[derive(Default)]
pub struct Conversation {
    client: Option<crate::clickup::Client>,
    history: Vec<(String,String)>,
    context: Option<crate::claude::ChatContext>,
}

fn chat_input(query: &str, context: Option<&crate::claude::ChatContext>) -> Result<Vec<Value>,String> {
    use crate::claude::ChatContext;
    let mut input = Vec::new();
    match context {
        Some(ChatContext::File {name,path}) => {
            let file = Path::new(path);
            let ext = file.extension().and_then(|e|e.to_str()).unwrap_or("").to_lowercase();
            if ext == "pdf" { return Err("For PDF questions, choose Claude in Settings → Chat. Your attached file will stay here.".into()); }
            let size = fs::metadata(file).map_err(|_| "The attached file is no longer available. Drop it again.")?.len();
            if ["png","jpg","jpeg","webp","gif"].contains(&ext.as_str()) {
                if size > 8*1024*1024 { return Err("Use an image smaller than 8 MB, or select Claude in Settings → Chat.".into()); }
                input.push(json!({"type":"localImage","path":path}));
            } else {
                let block = crate::claude::file_block(path).ok_or("Use a text file smaller than 200 KB, or choose Claude for this attachment.")?;
                input.push(json!({"type":"text","text":block["text"]}));
            }
            input.push(json!({"type":"text","text":format!("Attached file: {name}")}));
        }
        Some(ChatContext::Window {app_name,title,url}) => input.push(json!({"type":"text","text":format!("Attached context: app {app_name}, window {title}, URL {}",url.as_deref().unwrap_or(""))})),
        None => {}
    }
    input.push(json!({"type":"text","text":query}));
    Ok(input)
}

pub async fn chat_send(state: &CodexChat, query: String, context: Option<crate::claude::ChatContext>) -> Result<crate::claude::ChatReply,String> {
    if query.trim().is_empty() || query.len() > 20000 { return Err("Enter a question shorter than 20,000 characters.".into()); }
    let mut session = state.0.lock().await;
    let fresh = session.client.is_none();
    if session.history.is_empty() { session.context = context; }
    let mut input = chat_input(&query, if fresh {session.context.as_ref()} else {None})?;
    if fresh && !session.history.is_empty() {
        // ponytail: replay at most 100,000 characters after reconnect; persist threads if longer chats need recovery.
        let transcript = session.history.iter().rev().scan(0,|length,(role,text)| {
            *length += text.chars().count(); if *length > 100000 {None} else {Some(format!("{role}: {text}"))}
        }).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        input.insert(0,json!({"type":"text","text":format!("Earlier conversation, provided as context:\n{transcript}")}));
    }
    let mut client = match session.client.take() { Some(client)=>client, None=>crate::clickup::Client::start_chat().await? };
    let text = client.chat_turn(input).await?;
    session.client = Some(client);
    session.history.push(("User".into(),query)); session.history.push(("Assistant".into(),text.clone()));
    Ok(crate::claude::ChatReply {text})
}

#[cfg(test)]
mod chat_tests {
    use super::*;
    #[test]
    fn chat_context_and_validation_preserve_attachment_choices() {
        use crate::claude::ChatContext;
        let input = chat_input("Hello",Some(&ChatContext::Window{app_name:"Editor".into(),title:"Notes".into(),url:None})).unwrap();
        assert_eq!(input[1]["text"],"Hello"); assert!(input[0]["text"].as_str().unwrap().contains("Notes"));
        let pdf = ChatContext::File{name:"file.pdf".into(),path:"file.pdf".into()};
        assert!(chat_input("Read this",Some(&pdf)).unwrap_err().contains("choose Claude"));
        let path = std::env::temp_dir().join(format!("coucou-chat-{}.txt",std::process::id()));
        fs::write(&path,"Test attachment contents").unwrap();
        let file = ChatContext::File{name:"Notes".into(),path:path.to_string_lossy().into_owned()};
        assert!(chat_input("Read",Some(&file)).unwrap()[0]["text"].as_str().unwrap().contains("Test attachment contents"));
        fs::remove_file(path).unwrap();
    }
    #[test]
    #[ignore = "requires signed-in Codex; three small model requests, no ClickUp writes"]
    fn installed_codex_chat_keeps_followup_context() {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let state = CodexChat::default();
            chat_send(&state,"Remember this word for my next question: coucou-rainbow. Reply OK.".into(),None).await.unwrap();
            let reply = chat_send(&state,"What word did I ask you to remember? Reply only with the word.".into(),None).await.unwrap();
            assert!(reply.text.contains("coucou-rainbow"));
            state.0.lock().await.client = None;
            let recovered = chat_send(&state,"After reconnecting, what word did I ask you to remember? Reply only with it.".into(),None).await.unwrap();
            assert!(recovered.text.contains("coucou-rainbow"));
        });
    }
}
