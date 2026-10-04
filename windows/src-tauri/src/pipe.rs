// Named-pipe server for coucou-hook.
//
// `\\.\pipe\coucou-<sid>` — one instance per connection. Every hook event is
// forwarded to the island as a `hook` event. `PermissionRequest` is the only one
// that keeps its connection open: it waits for the island's decision and writes
// it back on the same pipe, which is how approving from the island works.
//
// Claude Code is never blocked by us. Three things guarantee it:
//   * coucou-hook gives the connection 300 ms and exits cleanly if we are closed;
//   * we only wait for a human once the island has *confirmed* the card is on
//     screen, so a paused island or a webview that is not listening costs a few
//     hundred milliseconds, not two minutes;
//   * whatever happens we drop the connection after the decision timeout, and
//     the terminal takes over.
//
// What we write back is the bare word `allow` or `deny`. Turning that into the
// documented hookSpecificOutput JSON is coucou-hook's job, so the wire format
// Claude Code expects lives in exactly one place.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[cfg(windows)]
use tokio::net::windows::named_pipe::{ServerOptions};
use tokio::sync::mpsc;

use crate::island::WINDOW_LABEL;
use crate::log;

#[cfg(target_os="linux")]
#[path="../../shared/relay_path.rs"]
mod relay_path;

#[cfg(target_os="linux")]
pub fn start(app:AppHandle){
    tauri::async_runtime::spawn(async move{
        use std::os::unix::fs::{MetadataExt,PermissionsExt};
        let path=match relay_path::socket_path(){Ok(p)=>p,Err(e)=>{log::line(e.to_string());return}};
        if let Ok(meta)=std::fs::symlink_metadata(&path){
            if meta.uid()!=unsafe{libc::geteuid()} || !std::os::unix::fs::FileTypeExt::is_socket(&meta.file_type()){return;}
            if tokio::net::UnixStream::connect(&path).await.is_ok(){return;}
            if std::fs::remove_file(&path).is_err(){return;}
        }
        let listener=match tokio::net::UnixListener::bind(&path){Ok(l)=>l,Err(e)=>{log::line(format!("Claude socket: {e}"));return}};
        if std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o600)).is_err(){return;}
        let slots=std::sync::Arc::new(tokio::sync::Semaphore::new(32));
        loop{
            let Ok((stream,_))=listener.accept().await else{break};
            if !stream.peer_cred().is_ok_and(|cred|cred.uid()==unsafe{libc::geteuid()}){continue;}
            let Ok(slot)=slots.clone().try_acquire_owned()else{continue};
            let app=app.clone();tauri::async_runtime::spawn(async move{let _slot=slot;handle(app,stream).await;});
        }
    });
}

/// Slightly under coucou-hook's own 110 s wait, so we always answer first.
const DECISION_TIMEOUT: Duration = Duration::from_secs(108);
/// How long the island gets to say "the card is up". This is the whole of B4:
/// without it, an island that is paused, hidden behind a crashed webview or
/// simply not listening would leave Claude Code staring at a prompt nobody can
/// see for nearly two minutes.
const ACK_TIMEOUT: Duration = Duration::from_millis(800);
const MAX_PAYLOAD: usize = 1 << 20;

/// What the island can say about a permission request.
pub enum Reply {
    /// The card is on screen and a human can act on it.
    Ack,
    /// A human clicked: `allow` or `deny`.
    Decision(String),
    /// Nobody can act on it — paused, or another request already holds the card.
    Decline,
}

/// Permission requests the island has been told about.
#[derive(Default)]
pub struct Pending(pub Mutex<HashMap<String, mpsc::Sender<Reply>>>);

static COUNTER: AtomicU64 = AtomicU64::new(1);

/// `\\.\pipe\coucou-<sid>` — must match coucou-hook's `pipe_path()` exactly.
#[cfg(windows)]
pub fn pipe_name() -> String {
    let key = crate::win_user::current_user_sid()
        .unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "user".into()));
    format!(r"\\.\pipe\coucou-{key}")
}

#[cfg(windows)]
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let name = pipe_name();
        // first_pipe_instance also means we refuse to join a pipe somebody else
        // already owns under our name, rather than serving on top of it.
        let mut server = match ServerOptions::new().first_pipe_instance(true).create(&name) {
            Ok(s) => s,
            Err(err) => {
                log::line(format!("cannot open the relay pipe: {err}"));
                return;
            }
        };
        loop {
            if server.connect().await.is_err() {
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
            // Hand the connected instance to a task and listen on a fresh one.
            let next = match ServerOptions::new().create(&name) {
                Ok(s) => s,
                Err(err) => {
                    log::line(format!("cannot reopen the relay pipe: {err}"));
                    return;
                }
            };
            let connected = std::mem::replace(&mut server, next);
            let app = app.clone();
            tauri::async_runtime::spawn(async move { handle(app, connected).await });
        }
    });
}

async fn handle<P: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(app: AppHandle, mut pipe: P) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match tokio::time::timeout(Duration::from_secs(2),pipe.read(&mut chunk)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > MAX_PAYLOAD { return; }
                if buf.contains(&b'\n') {
                    break;
                }
            }
            _ => return,
        }
    }
    let line = match buf.iter().position(|b| *b == b'\n') {
        Some(i) => &buf[..i],
        None => &buf[..],
    };
    let Ok(mut payload) = serde_json::from_slice::<Value>(line) else { return };
    if !payload.is_object() {
        return;
    }

    let event = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    if payload.get("event_id").is_none(){
        if let Some(tool_id)=payload.get("tool_use_id").and_then(Value::as_str){
            payload["event_id"]=json!(format!("{}:{event}:{tool_id}",payload["session_id"].as_str().unwrap_or("")));
        }
    }

    if event != "PermissionRequest" {
        log::line(format!("hook {event}"));
        let _ = app.emit_to(WINDOW_LABEL, "hook", payload);

        return;
    }

    let id = format!("{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
    payload["request_id"] = json!(id);
    let quiet = app.state::<crate::Shared>().settings.lock().unwrap().quiet_active();
    if quiet || crate::integrations::PAUSED.load(Ordering::Relaxed) {
        payload["terminal_fallback"] = json!(true);
        let _ = app.emit_to(WINDOW_LABEL,"hook",payload);
        return;
    }
    let (tx, mut rx) = mpsc::channel::<Reply>(4);
    {
        let pending = app.state::<Pending>();
        pending.0.lock().unwrap().insert(id.clone(), tx);
    }
    payload["request_id"] = json!(id);
    log::line(format!("hook PermissionRequest id={id}"));
    let _ = app.emit_to(WINDOW_LABEL, "hook", payload);

    let decision = wait_for_decision(&id, &mut rx).await;
    app.state::<Pending>().0.lock().unwrap().remove(&id);

    // No decision: say nothing at all. coucou-hook then writes nothing to stdout
    // and Claude Code asks in the terminal, exactly as if Coucou were closed.
    if let Some(d) = decision {
        let _ = pipe.write_all(format!("{d}\n").as_bytes()).await;
        let _ = pipe.flush().await;
    }

}

/// Two waits: a short one for "the card is up", then the long one for a human.
async fn wait_for_decision(id: &str, rx: &mut mpsc::Receiver<Reply>) -> Option<String> {
    match tokio::time::timeout(ACK_TIMEOUT, rx.recv()).await {
        Ok(Some(Reply::Ack)) => {}
        // A click that beats the ack is still a click.
        Ok(Some(Reply::Decision(d))) => {
            log::line(format!("hook id={id} answered {d}"));
            return Some(d);
        }
        Ok(Some(Reply::Decline)) => {
            log::line(format!("hook id={id} not shown — terminal takes over"));
            return None;
        }
        Ok(None) => return None,
        Err(_) => {
            log::line(format!("hook id={id} island never acknowledged — terminal takes over"));
            return None;
        }
    }

    match tokio::time::timeout(DECISION_TIMEOUT, rx.recv()).await {
        Ok(Some(Reply::Decision(d))) => {
            log::line(format!("hook id={id} answered {d}"));
            Some(d)
        }
        Ok(Some(Reply::Decline)) => {
            log::line(format!("hook id={id} released without a decision"));
            None
        }
        _ => {
            log::line(format!("hook id={id} timed out — terminal takes over"));
            None
        }
    }
}

fn send(app: &AppHandle, request_id: &str, reply: Reply, keep: bool) {
    let sender = {
        let pending = app.state::<Pending>();
        let mut map = pending.0.lock().unwrap();
        if keep { map.get(request_id).cloned() } else { map.remove(request_id) }
    };
    match sender {
        Some(tx) => {
            let _ = tx.try_send(reply);
        }
        None => log::line(format!("reply for id={request_id} — no pending request")),
    }
}

/// The island has the card on screen; the long wait may begin.
pub fn acknowledge(app: &AppHandle, request_id: &str) {
    if app.state::<crate::Shared>().settings.lock().unwrap().quiet_active() || crate::integrations::PAUSED.load(Ordering::Relaxed){decline(app,request_id);return;}
    send(app, request_id, Reply::Ack, true);
}

pub fn release_all(app:&AppHandle){
    let senders:Vec<_>=app.state::<Pending>().0.lock().unwrap().drain().map(|(_,tx)|tx).collect();
    for sender in senders {let _=sender.try_send(Reply::Decline);}
}

/// Nobody can act on this one — paused, or another card already holds the view.
pub fn decline(app: &AppHandle, request_id: &str) {
    log::line(format!("decline id={request_id}"));
    send(app, request_id, Reply::Decline, false);
}

/// Called by the island's Allow / Deny buttons. Only ever a bare word: turning
/// it into Claude Code's JSON is coucou-hook's job.
pub fn answer(app: &AppHandle, request_id: &str, decision: &str) {
    if app.state::<crate::Shared>().settings.lock().unwrap().quiet_active() || crate::integrations::PAUSED.load(Ordering::Relaxed){decline(app,request_id);return;}
    let word = match decision {
        "allow" | "always" => "allow",
        _ => "deny",
    };
    log::line(format!("decision id={request_id} {word}"));
    send(app, request_id, Reply::Decision(word.to_string()), false);
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn permission_fallback_and_only_explicit_decisions(){
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async{
            let (tx,mut rx)=mpsc::channel(4);tx.send(Reply::Decline).await.unwrap();assert!(wait_for_decision("quiet",&mut rx).await.is_none());
            let (tx,mut rx)=mpsc::channel(4);tx.send(Reply::Ack).await.unwrap();tx.send(Reply::Decision("allow".into())).await.unwrap();assert_eq!(wait_for_decision("clicked",&mut rx).await.as_deref(),Some("allow"));
            let (tx,mut rx)=mpsc::channel(4);tx.send(Reply::Ack).await.unwrap();tx.send(Reply::Decline).await.unwrap();assert!(wait_for_decision("paused",&mut rx).await.is_none());
            let (tx,mut rx)=mpsc::channel(4);drop(tx);assert!(wait_for_decision("closed",&mut rx).await.is_none());
        });
    }
}
