// Integration pollers — the Rust side of StripePoller / GithubPoller /
// VercelPoller / N8nPoller / ResendPoller / NotionPoller / CalcomPoller.
//
// Same endpoints, same first-run delays and intervals as the Swift pollers. Each
// one emits an `integration` event; the island owns the badge, the sound and the
// 60 s auto-clear, exactly as the Swift handlers do.
//
// Nothing is polled until its key exists in the Credential Manager, and no
// request goes anywhere the user has not configured.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::island::WINDOW_LABEL;
use crate::log;
use crate::secrets;

const TIMEOUT: Duration = Duration::from_secs(10);

/// What the island receives. `event` is only set when something actually changed,
/// which is what drives the pill badge and the sound.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationUpdate {
    pub id: &'static str,
    pub data: Value,
    pub error: Option<String>,
    pub event: Option<IntegrationEvent>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationEvent {
    pub success: bool,
    pub label: String,
    pub detail: Option<String>,
}

fn emit(app: &AppHandle, update: IntegrationUpdate) {
    let mut value=serde_json::to_value(&update).unwrap_or_default();
    let now=now_ms();
    value["checkedAt"]=json!(now);
    if update.error.is_none() { value["lastSuccess"]=json!(now); }
    if let Some(event)=value.get_mut("event").filter(|v|v.is_object()) {
        let key=update.id.trim_start_matches("integration_");
        if let Some(id)=SEEN.0.lock().unwrap().get(key) {event["eventId"]=json!(format!("{id}:{}",event["success"]));}
    }
    let _ = app.emit_to(WINDOW_LABEL, "integration", value);
}

fn now_ms()->u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }

fn credential(app:&AppHandle,id:&'static str,key:&str)->Option<String>{
    match secrets::status(key){Ok(true)=>secrets::get(key),Ok(false)=>None,Err(err)=>{connection_error(app,id,err);None}}
}
fn connection_error(app:&AppHandle,id:&'static str,message:impl Into<String>) {
    let message=message.into();
    if id=="integration_github"{GITHUB.lock().unwrap().error=Some(message.clone());}
    emit(app,IntegrationUpdate{id,data:json!({}),error:Some(message),event:None});
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .unwrap_or_default()
}

fn github_poll_delay(headers:&reqwest::header::HeaderMap,now:u64)->u64{
    let number=|name:&str|headers.get(name).and_then(|v|v.to_str().ok()).and_then(|v|v.parse::<u64>().ok());
    let interval=number("x-poll-interval").unwrap_or(60).max(60);
    let retry=number("retry-after").or_else(||headers.get("retry-after").and_then(|v|v.to_str().ok()).and_then(|v|chrono::DateTime::parse_from_rfc2822(v).ok()).map(|date|(date.timestamp().max(0) as u64).saturating_sub(now))).unwrap_or(0);
    let limited=number("x-ratelimit-remaining")==Some(0);
    interval.max(retry).max(if limited{number("x-ratelimit-reset").unwrap_or(now).saturating_sub(now)}else{0})
}

fn github_headers(token:&str,modified:Option<&str>)->reqwest::header::HeaderMap{
    use reqwest::header::*;
    let mut headers=HeaderMap::new();
    if let Ok(value)=HeaderValue::from_str(&format!("Bearer {token}")){headers.insert(AUTHORIZATION,value);}
    headers.insert(ACCEPT,HeaderValue::from_static("application/vnd.github+json"));
    headers.insert(USER_AGENT,HeaderValue::from_static("Coucou"));
    headers.insert("X-GitHub-Api-Version",HeaderValue::from_static("2022-11-28"));
    if let Some(value)=modified.and_then(|v|HeaderValue::from_str(v).ok()){headers.insert(IF_MODIFIED_SINCE,value);}
    headers
}

/// Set from the tray's Pause item. While it is on, nothing reaches the network:
/// pausing Coucou has to mean pausing Coucou, not just hiding the island.
pub static PAUSED: AtomicBool = AtomicBool::new(false);
pub static PAUSE_GENERATION:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);

pub fn set_paused(on: bool) {
    if PAUSED.swap(on,Ordering::Relaxed)!=on{PAUSE_GENERATION.fetch_add(1,Ordering::Relaxed);crate::platform::watch::wake();}
}

/// Spawns every poller with the macOS delays and intervals.
pub fn start(app: AppHandle) {
    spawn(app.clone(), "integration_n8n", 3, 15, poll_n8n);
    spawn(app.clone(), "integration_vercel", 5, 30, poll_vercel);
    spawn(app.clone(), "integration_stripe", 6, 30, poll_stripe);
    spawn(app.clone(), "integration_resend", 6, 60, poll_resend);
    spawn(app.clone(), "integration_github", 7, 60, poll_github);
    spawn(app.clone(), "integration_clickup", 4, 300, poll_clickup);
    spawn(app.clone(), "integration_calcom", 8, 300, poll_calcom);
    spawn(app, "integration_notion", 9, 300, poll_notion);
}

/// True when the user has this integration switched on in settings.
fn enabled(app: &AppHandle, id: &str) -> bool {
    app.try_state::<crate::Shared>()
        .map(|shared| {
            let settings = shared.settings.lock().unwrap();
            if id=="integration_clickup" { !settings.clickup_workspace.is_empty() && !settings.clickup_list.is_empty() }
            else { settings.active_integrations.iter().any(|x| x == id) }
        })
        .unwrap_or(false)
}

fn spawn<F, Fut>(app: AppHandle, id: &'static str, delay_secs: u64, every_secs: u64, poll: F)
where
    F: Fn(AppHandle) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send,
{
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(delay_secs)).await;
        let mut ticker = tokio::time::interval(Duration::from_secs(every_secs));
        loop {
            ticker.tick().await;
            // The ticker keeps its cadence; we just decline to do the work. An
            // integration the user switched off, or a paused app, must make no
            // network calls at all — CLAUDE.md allows talking only to services
            // the user configured, and a disabled one is not configured.
            if PAUSED.load(Ordering::Relaxed) || !enabled(&app, id) {
                continue;
            }
            poll(app.clone()).await;
        }
    });
}

/// One-shot refresh from the Refresh buttons in the island.
pub async fn poll_once(app: AppHandle, id: &str) {
    if PAUSED.load(Ordering::Relaxed) || !enabled(&app,id) { return; }
    match id {
        "integration_stripe" => poll_stripe(app).await,
        "integration_github" => poll_github(app).await,
        "integration_vercel" => poll_vercel(app).await,
        "integration_n8n" => poll_n8n(app).await,
        "integration_resend" => poll_resend(app).await,
        "integration_notion" => poll_notion(app).await,
        "integration_calcom" => poll_calcom(app).await,
        "integration_clickup" => poll_clickup(app).await,
        _ => {}
    }
}

async fn poll_clickup(app:AppHandle) {
    if credential(&app,"integration_clickup","clickup-api-token").is_none(){return;}
    let settings=app.state::<crate::Shared>().settings.lock().unwrap().clone();
    match crate::clickup::next_tasks(&settings).await {
        Ok(data)=>emit(&app,IntegrationUpdate{id:"integration_clickup",data,error:None,event:None}),
        Err(err)=>connection_error(&app,"integration_clickup",err),
    }
}

/// Remembers the newest id per integration so an event fires once, not on every poll.
struct Seen(Mutex<std::collections::HashMap<&'static str, String>>);

static SEEN: std::sync::LazyLock<Seen> =
    std::sync::LazyLock::new(|| Seen(Mutex::new(std::collections::HashMap::new())));

/// Returns true the first time a given id is seen (and false on the very first
/// load, which only fills the card).
fn is_new(key: &'static str, id: &str) -> bool {
    let mut map = SEEN.0.lock().unwrap();
    match map.insert(key, id.to_string()) {
        Some(previous) => previous != id,
        None => false, // first poll: populate silently, like the Swift pollers
    }
}

fn status_error(code: u16, unauthorised_hint: &str) -> String {
    match code {
        401 => "Invalid API key (401)".into(),
        403 => unauthorised_hint.into(),
        _ => format!("API error {code}"),
    }
}

// ── Stripe ────────────────────────────────────────────────────────────────────

async fn poll_stripe(app: AppHandle) {
    let Some(key) = credential(&app,"integration_stripe","stripe-api-key") else { return };
    let auth = format!("Basic {}", crate::claude::base64_for(format!("{key}:").as_bytes()));
    let http = client();

    let balance = http
        .get("https://api.stripe.com/v1/balance")
        .header("Authorization", &auth)
        .send()
        .await;

    let (amount, currency) = match balance {
        Ok(r) if r.status().is_success() => {
            let json: Value = r.json().await.unwrap_or(json!({}));
            let mut buckets: Vec<Value> = Vec::new();
            for k in ["available", "pending"] {
                if let Some(arr) = json.get(k).and_then(Value::as_array) {
                    buckets.extend(arr.iter().cloned());
                }
            }
            let currency = buckets
                .first()
                .and_then(|b| b.get("currency"))
                .and_then(Value::as_str)
                .unwrap_or("eur")
                .to_string();
            let amount: i64 = buckets
                .iter()
                .filter_map(|b| b.get("amount").and_then(Value::as_i64))
                .sum();
            (amount, currency)
        }
        Ok(r) => {
            let code = r.status().as_u16();
            emit(&app, IntegrationUpdate {
                id: "integration_stripe",
                data: json!({}),
                error: Some(status_error(code, "Use a secret key (sk_live_… not pk_live_…)")),
                event: None,
            });
            return;
        }
        Err(e) => {
            emit(&app, IntegrationUpdate {
                id: "integration_stripe",
                data: json!({}),
                error: Some(format!("No connection: {e}")),
                event: None,
            });
            return;
        }
    };

    let charges = http
        .get("https://api.stripe.com/v1/charges?limit=3")
        .header("Authorization", &auth)
        .send()
        .await;
    let Ok(response) = charges else {connection_error(&app,"integration_stripe","Could not load payments. Refresh when your connection returns.");return;};
    if !response.status().is_success() {
        return;
    }
    let json: Value = match response.json().await {Ok(v)=>v,Err(_)=>{connection_error(&app,"integration_stripe","The service returned an unreadable response. Refresh or check connection settings.");return;}};
    let payments: Vec<Value> = json
        .get("data")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|c| {
                    let description = c
                        .get("description")
                        .and_then(Value::as_str)
                        .or_else(|| {
                            c.get("billing_details")
                                .and_then(|b| b.get("name"))
                                .and_then(Value::as_str)
                        })
                        .map(str::to_string);
                    Some(json!({
                        "id": c.get("id")?.as_str()?,
                        "amount": c.get("amount")?.as_i64()?,
                        "currency": c.get("currency")?.as_str()?,
                        "description": description,
                        "createdAt": c.get("created").and_then(Value::as_i64).unwrap_or(0) * 1000,
                        "status": c.get("status").and_then(Value::as_str).unwrap_or("succeeded"),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();

    let newest = payments
        .first()
        .and_then(|p| p.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let event = if !newest.is_empty() && is_new("stripe", &newest) {
        let label = payments[0]
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                let cents = payments[0].get("amount").and_then(Value::as_i64).unwrap_or(0);
                format!("{:.2}", cents as f64 / 100.0)
            });
        Some(IntegrationEvent { success: true, label, detail: None })
    } else {
        None
    };

    emit(&app, IntegrationUpdate {
        id: "integration_stripe",
        data: json!({ "balance": amount, "currency": currency, "payments": payments }),
        error: None,
        event,
    });
}

// ── GitHub ────────────────────────────────────────────────────────────────────

#[derive(Default)]
struct GithubState { error:Option<String>,checked_at:Option<u64>,last_success:Option<u64>,modified:Option<String>, next_poll:Option<std::time::Instant>, seen:std::collections::HashSet<String>, initialized:bool, data:Value }
static GITHUB:std::sync::LazyLock<Mutex<GithubState>>=std::sync::LazyLock::new(||Mutex::new(GithubState::default()));
pub fn reset_github(){*GITHUB.lock().unwrap()=GithubState::default();}

fn github_target(item:&Value)->Option<String>{
    let source=item["subject"]["url"].as_str()?;
    let path=source.strip_prefix("https://api.github.com/repos/")?;
    let parts:Vec<_>=path.split('/').collect();
    if parts.len()!=4 || !["issues","pulls"].contains(&parts[2]) || !parts[3].bytes().all(|b|b.is_ascii_digit()) || parts[3].is_empty(){return None;}
    Some(format!("https://github.com/{}/{}/{}/{}",parts[0],parts[1],if parts[2]=="pulls"{"pull"}else{"issues"},parts[3]))
}

async fn poll_github(app: AppHandle) {
    let Some(token)=credential(&app,"integration_github","github-token") else{return;};
    if token.starts_with("github_pat_"){connection_error(&app,"integration_github","Fine-grained tokens cannot read notifications. Connect a classic token with notifications access in Settings.");return;}
    let modified={let mut state=GITHUB.lock().unwrap();if state.next_poll.is_some_and(|next|next>std::time::Instant::now()) {
        if state.initialized || state.error.is_some(){let _=app.emit_to(WINDOW_LABEL,"integration",json!({"id":"integration_github","data":state.data,"error":state.error,"event":null,"checkedAt":state.checked_at,"lastSuccess":state.last_success}));}return;
    }state.next_poll=Some(std::time::Instant::now()+Duration::from_secs(60));state.modified.clone()};
    let request=client().get("https://api.github.com/notifications?per_page=100").headers(github_headers(&token,modified.as_deref()));
    let response=match request.send().await {Ok(r)=>r,Err(_)=>{connection_error(&app,"integration_github","Could not reach GitHub. Refresh when your connection returns.");return;}};
    let status=response.status();
    GITHUB.lock().unwrap().checked_at=Some(now_ms());
    let delay=github_poll_delay(response.headers(),now_ms()/1000);
    let modified=response.headers().get("Last-Modified").and_then(|v|v.to_str().ok()).map(str::to_owned);
    GITHUB.lock().unwrap().next_poll=std::time::Instant::now().checked_add(Duration::from_secs(delay));
    if status.as_u16()==304 {
        let mut state=GITHUB.lock().unwrap();state.error=None;state.last_success=Some(now_ms());let data=state.data.clone();drop(state);
        emit(&app,IntegrationUpdate{id:"integration_github",data,error:None,event:None});return;
    }
    if !status.is_success(){connection_error(&app,"integration_github",status_error(status.as_u16(),"Notifications require a classic personal access token with notifications access. Fine-grained tokens are unsupported."));return;}
    let mut next=github_next_page(response.headers());
    let value:Value=match response.json().await {Ok(value)=>value,Err(_)=>{connection_error(&app,"integration_github","GitHub returned an unreadable response.");return;}};
    let Some(mut list)=value.as_array().cloned()else{connection_error(&app,"integration_github","GitHub returned an unreadable response.");return;};
    for _ in 0..9 {
        let Some(url)=next.take()else{break};
        if PAUSED.load(Ordering::Relaxed){return;}
        let response=match client().get(url).headers(github_headers(&token,None)).send().await{Ok(r)=>r,Err(_)=>{connection_error(&app,"integration_github","Could not load the next notifications page. Refresh when your network returns.");return}};
        let next_poll=std::time::Instant::now().checked_add(Duration::from_secs(github_poll_delay(response.headers(),now_ms()/1000)));
        {let mut state=GITHUB.lock().unwrap();state.next_poll=state.next_poll.max(next_poll);}
        if !response.status().is_success(){connection_error(&app,"integration_github",status_error(response.status().as_u16(),"GitHub notification access was rejected. Check your classic token in Settings."));return;}
        next=github_next_page(response.headers());
        let value:Value=match response.json().await{Ok(v)=>v,Err(_)=>{connection_error(&app,"integration_github","GitHub returned an unreadable notifications page.");return}};
        let Some(page)=value.as_array()else{connection_error(&app,"integration_github","GitHub returned an unreadable notifications page.");return};
        list.extend(page.iter().cloned());
    }
    let notifications:Vec<Value>=list.iter().filter(|n|["mention","team_mention","assign","review_requested"].contains(&n["reason"].as_str().unwrap_or("")))
        .filter_map(|n|Some(json!({"id":n["id"],"title":n["subject"]["title"],"repository":n["repository"]["full_name"],"reason":n["reason"],"updatedAt":n["updated_at"],"url":github_target(n)?}))).collect();
    let mut state=GITHUB.lock().unwrap();
    let mut events=Vec::new();
    for item in &notifications {
        let id=format!("{}:{}",item["id"],item["updatedAt"]);
        let new=state.seen.insert(id.clone());
        if new {events.push(json!({"silent":!state.initialized,"success":true,"eventId":id,"label":item["title"],"detail":item["repository"],"url":item["url"],"category":"update","timestamp":item["updatedAt"].as_str().and_then(|time|chrono::DateTime::parse_from_rfc3339(time).ok()).map(|time|time.timestamp_millis())}));}
    }
    if state.seen.len()>1000{state.seen=notifications.iter().map(|n|format!("{}:{}",n["id"],n["updatedAt"])).collect();}
    state.initialized=true;state.error=None;state.last_success=Some(now_ms());state.modified=modified;state.data=json!({"notifications":notifications});
    let data=state.data.clone();drop(state);
    let now=now_ms();
    let _=app.emit_to(WINDOW_LABEL,"integration",json!({"id":"integration_github","data":data,"error":null,"event":null,"events":events,"checkedAt":now,"lastSuccess":now}));
}

fn github_next_page(headers:&reqwest::header::HeaderMap)->Option<reqwest::Url>{
    let value=headers.get("link")?.to_str().ok()?;
    let part=value.split(',').find(|s|s.contains("rel=\"next\""))?;
    let url=reqwest::Url::parse(part.trim().strip_prefix('<')?.split('>').next()?).ok()?;
    (url.scheme()=="https" && url.host_str()==Some("api.github.com") && url.path()=="/notifications" && url.username().is_empty() && url.password().is_none()).then_some(url)
}

// ── Vercel ────────────────────────────────────────────────────────────────────

async fn poll_vercel(app: AppHandle) {
    let Some(token) = credential(&app,"integration_vercel","vercel-token") else { return };
    let response = client()
        .get("https://api.vercel.com/v6/deployments?limit=5")
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .send()
        .await;
    let Ok(response) = response else { connection_error(&app,"integration_vercel","Connection failed. Refresh when your network returns."); return };
    if !response.status().is_success() {
        emit(&app, IntegrationUpdate {
            id: "integration_vercel",
            data: json!({}),
            error: Some(status_error(response.status().as_u16(), "Token lacks access")),
            event: None,
        });
        return;
    }
    let json: Value = match response.json().await {Ok(v)=>v,Err(_)=>{connection_error(&app,"integration_vercel","The service returned an unreadable response. Refresh or check connection settings.");return;}};
    let terminal = ["READY", "ERROR", "CANCELED"];
    let deployments: Vec<Value> = json
        .get("deployments")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|d| {
                    let state = d.get("state")?.as_str()?;
                    if !terminal.contains(&state) {
                        return None;
                    }
                    let meta = d.get("meta");
                    let pick = |keys: [&str; 3]| {
                        meta.and_then(|m| keys.iter().find_map(|k| m.get(*k).and_then(Value::as_str)))
                            .map(str::to_string)
                    };
                    Some(json!({
                        "id": d.get("uid")?.as_str()?,
                        "projectName": d.get("name")?.as_str()?,
                        "url": d.get("url").and_then(Value::as_str).unwrap_or(""),
                        "state": state,
                        "createdAt": d.get("createdAt").and_then(Value::as_f64).unwrap_or(0.0),
                        "commitMessage": pick(["githubCommitMessage", "gitlabCommitMessage", "bitbucketCommitMessage"]),
                        "branch": pick(["githubCommitRef", "gitlabCommitRef", "bitbucketBranch"]),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();

    let event = deployments.first().and_then(|latest| {
        let id = latest.get("id")?.as_str()?;
        if !is_new("vercel", id) {
            return None;
        }
        let success = latest.get("state")?.as_str()? == "READY";
        Some(IntegrationEvent {
            success,
            label: latest.get("projectName")?.as_str()?.to_string(),
            detail: None,
        })
    });

    emit(&app, IntegrationUpdate {
        id: "integration_vercel",
        data: json!({ "deployments": deployments }),
        error: None,
        event,
    });
}

// ── Resend ────────────────────────────────────────────────────────────────────

async fn poll_resend(app: AppHandle) {
    let Some(key) = credential(&app,"integration_resend","resend-api-key") else { return };
    let response = client()
        .get("https://api.resend.com/emails?limit=100")
        .header("Authorization", format!("Bearer {key}"))
        .header("Accept", "application/json")
        .send()
        .await;
    let Ok(response) = response else { connection_error(&app,"integration_resend","Connection failed. Refresh when your network returns."); return };
    if !response.status().is_success() {
        emit(&app, IntegrationUpdate {
            id: "integration_resend",
            data: json!({}),
            error: Some(status_error(response.status().as_u16(), "Key lacks access")),
            event: None,
        });
        return;
    }
    let json: Value = match response.json().await {Ok(v)=>v,Err(_)=>{connection_error(&app,"integration_resend","The service returned an unreadable response. Refresh or check connection settings.");return;}};
    let total = json
        .get("total")
        .or_else(|| json.get("count"))
        .and_then(Value::as_i64);
    let emails: Vec<Value> = json
        .get("data")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .take(5)
                .filter_map(|e| {
                    let to = match e.get("to") {
                        Some(Value::Array(a)) => a.clone(),
                        Some(Value::String(s)) => vec![Value::String(s.clone())],
                        _ => vec![],
                    };
                    Some(json!({
                        "id": e.get("id")?.as_str()?,
                        "to": to,
                        "subject": e.get("subject").and_then(Value::as_str).unwrap_or(""),
                        "createdAt": e.get("created_at").and_then(Value::as_str).unwrap_or(""),
                        "lastEvent": e.get("last_event").and_then(Value::as_str).unwrap_or(""),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();

    emit(&app, IntegrationUpdate {
        id: "integration_resend",
        data: json!({ "emails": emails, "total": total }),
        error: None,
        event: None,
    });
}

// ── Notion ────────────────────────────────────────────────────────────────────

async fn poll_notion(app: AppHandle) {
    let Some(token) = credential(&app,"integration_notion","notion-api-key") else { return };
    let response = client()
        .post("https://api.notion.com/v1/search")
        .header("Authorization", format!("Bearer {token}"))
        .header("Notion-Version", "2022-06-28")
        .header("Content-Type", "application/json")
        .json(&json!({
            "sort": { "direction": "descending", "timestamp": "last_edited_time" },
            "page_size": 3
        }))
        .send()
        .await;
    let Ok(response) = response else { connection_error(&app,"integration_notion","Connection failed. Refresh when your network returns."); return };
    if !response.status().is_success() {
        emit(&app, IntegrationUpdate {
            id: "integration_notion",
            data: json!({}),
            error: Some(status_error(response.status().as_u16(), "Integration lacks access")),
            event: None,
        });
        return;
    }
    let json: Value = match response.json().await {Ok(v)=>v,Err(_)=>{connection_error(&app,"integration_notion","The service returned an unreadable response. Refresh or check connection settings.");return;}};
    let pages: Vec<Value> = json
        .get("results")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(parse_notion_page).collect())
        .unwrap_or_default();

    emit(&app, IntegrationUpdate {
        id: "integration_notion",
        data: json!({ "pages": pages }),
        error: None,
        event: None,
    });
}

fn parse_notion_page(obj: &Value) -> Option<Value> {
    let id = obj.get("id")?.as_str()?;
    let is_database = obj.get("object").and_then(Value::as_str) == Some("database");

    let mut title = "Untitled".to_string();
    if is_database {
        if let Some(text) = obj
            .get("title")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(|t| t.get("plain_text"))
            .and_then(Value::as_str)
        {
            if !text.is_empty() {
                title = text.to_string();
            }
        }
    } else if let Some(props) = obj.get("properties").and_then(Value::as_object) {
        for prop in props.values() {
            if prop.get("type").and_then(Value::as_str) != Some("title") {
                continue;
            }
            if let Some(text) = prop
                .get("title")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(|t| t.get("plain_text"))
                .and_then(Value::as_str)
            {
                if !text.is_empty() {
                    title = text.to_string();
                    break;
                }
            }
        }
    }

    let emoji = obj
        .get("icon")
        .filter(|i| i.get("type").and_then(Value::as_str) == Some("emoji"))
        .and_then(|i| i.get("emoji"))
        .and_then(Value::as_str);

    Some(json!({
        "id": id,
        "title": title,
        "emoji": emoji,
        "lastEditedAt": obj.get("last_edited_time").and_then(Value::as_str)?,
        "url": obj.get("url").and_then(Value::as_str).unwrap_or("https://notion.so"),
    }))
}

// ── Cal.com ───────────────────────────────────────────────────────────────────

async fn poll_calcom(app: AppHandle) {
    let Some(key) = credential(&app,"integration_calcom","calcom-api-key") else { return };
    let response = client()
        .get("https://api.cal.com/v2/bookings?status=upcoming")
        .header("Authorization", format!("Bearer {key}"))
        .header("cal-api-version", "2024-08-13")
        .send()
        .await;
    let Ok(response) = response else { connection_error(&app,"integration_calcom","Connection failed. Refresh when your network returns."); return };
    if !response.status().is_success() {
        emit(&app, IntegrationUpdate {
            id: "integration_calcom",
            data: json!({}),
            error: Some(status_error(response.status().as_u16(), "Key lacks access")),
            event: None,
        });
        return;
    }
    let json: Value = match response.json().await {Ok(v)=>v,Err(_)=>{connection_error(&app,"integration_calcom","The service returned an unreadable response. Refresh or check connection settings.");return;}};
    let bookings: Vec<Value> = json
        .get("data")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|b| {
                    let start = b
                        .get("start")
                        .or_else(|| b.get("startTime"))
                        .and_then(Value::as_str)?;
                    let attendee = b.get("attendees").and_then(Value::as_array).and_then(|a| a.first());
                    let notes = b
                        .get("responses")
                        .and_then(|r| r.get("notes"))
                        .and_then(|n| n.get("value"))
                        .and_then(Value::as_str)
                        .or_else(|| b.get("description").and_then(Value::as_str))
                        .filter(|s| !s.is_empty());
                    Some(json!({
                        "id": b.get("id").map(|v| v.to_string()).unwrap_or_default(),
                        "title": b.get("title").and_then(Value::as_str).unwrap_or("Meeting"),
                        "start": start,
                        "status": b.get("status").and_then(Value::as_str).unwrap_or("accepted"),
                        "attendeeName": attendee.and_then(|a| a.get("name")).and_then(Value::as_str),
                        "attendeeEmail": attendee.and_then(|a| a.get("email")).and_then(Value::as_str),
                        "attendeeNotes": notes,
                    }))
                })
                .collect()
        })
        .unwrap_or_default();

    emit(&app, IntegrationUpdate {
        id: "integration_calcom",
        data: json!({ "bookings": bookings }),
        error: None,
        event: None,
    });
}

// ── n8n ───────────────────────────────────────────────────────────────────────

async fn poll_n8n(app: AppHandle) {
    let (Some(key), Some(raw_base)) = (credential(&app,"integration_n8n","n8n-api-key"),credential(&app,"integration_n8n","n8n-url")) else {
        return;
    };
    let base = raw_base.trim_end_matches('/').to_string();
    let http = client();

    // Same two shapes as the Swift poller: the public API first, then /rest.
    let list_urls = [
        format!("{base}/api/v1/executions?limit=1&includeData=false"),
        format!("{base}/rest/executions?limit=1&includeData=false"),
    ];

    let mut items: Option<Vec<Value>> = None;
    for url in &list_urls {
        if PAUSED.load(Ordering::Relaxed){return;}
        let Ok(response) = http.get(url).header("X-N8N-API-KEY", &key).header("Accept", "application/json").send().await
        else {
            continue;
        };
        if !response.status().is_success() {
            // Only the status: a self-hosted base URL can carry credentials.
            log::line(format!("n8n list HTTP {}", response.status()));
            continue;
        }
        let Ok(json) = response.json::<Value>().await else { continue };
        items = match &json {
            Value::Object(o) => o.get("data").and_then(Value::as_array).cloned(),
            Value::Array(a) => Some(a.clone()),
            _ => None,
        };
        if items.is_some() {
            break;
        }
    }

    let Some(items)=items else {connection_error(&app,"integration_n8n","Could not read n8n executions. Check the instance URL and API key in Settings.");return;};
    let Some(first)=items.into_iter().next() else {emit(&app,IntegrationUpdate{id:"integration_n8n",data:json!({}),error:None,event:None});return;};
    let id = match first.get("id") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => return,
    };

    let status = first.get("status").and_then(Value::as_str).unwrap_or("");
    if !["success", "error", "crashed", "canceled", "failed"].contains(&status) {
        emit(&app,IntegrationUpdate{id:"integration_n8n",data:json!({"status":status}),error:None,event:None});
        return;
    }
    if !is_new("n8n", &id) {
        emit(&app,IntegrationUpdate{id:"integration_n8n",data:json!({"status":status}),error:None,event:None});
        return;
    }
    let success = status == "success";

    let detail_urls = [
        format!("{base}/api/v1/executions/{id}?includeData=true"),
        format!("{base}/api/v1/executions/{id}"),
        format!("{base}/rest/executions/{id}?includeData=true"),
        format!("{base}/rest/executions/{id}"),
    ];
    let mut name = "Workflow".to_string();
    let mut detail = None;
    for url in &detail_urls {
        if PAUSED.load(Ordering::Relaxed){return;}
        let Ok(response) = http.get(url).header("X-N8N-API-KEY", &key).header("Accept", "application/json").send().await
        else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        let Ok(json) = response.json::<Value>().await else { continue };
        name = json
            .get("workflowData")
            .and_then(|w| w.get("name"))
            .and_then(Value::as_str)
            .or_else(|| json.get("name").and_then(Value::as_str))
            .unwrap_or("Workflow")
            .to_string();
        detail = n8n_detail(&json, success);
        break;
    }

    log::line(format!("n8n execution {id} {status} · {name}"));
    emit(&app, IntegrationUpdate {
        id: "integration_n8n",
        data: json!({ "workflow": name, "status": status }),
        error: None,
        event: Some(IntegrationEvent { success, label: name, detail }),
    });
}

fn n8n_detail(json: &Value, success: bool) -> Option<String> {
    let result = json.get("data")?.get("resultData")?;
    if !success {
        if let Some(error) = result.get("error") {
            let message = error.get("message").and_then(Value::as_str).unwrap_or("");
            if let Some(node) = error.get("node").and_then(|n| n.get("name")).and_then(Value::as_str) {
                if !node.is_empty() {
                    return Some(format!("{node}\n{message}"));
                }
            }
            return Some(message.to_string());
        }
        let runs = result.get("runData")?.as_object()?;
        for (node, value) in runs {
            if let Some(message) = value
                .as_array()
                .and_then(|a| a.first())
                .and_then(|r| r.get("error"))
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
            {
                return Some(format!("{node}\n{message}"));
            }
        }
        return None;
    }

    let last_node = result.get("lastNodeExecuted")?.as_str()?;
    let items = result
        .get("runData")?
        .get(last_node)?
        .as_array()?
        .first()?
        .get("data")?
        .get("main")?
        .as_array()?
        .first()?
        .as_array()?;
    let count = items.len();
    let header = format!("→ {last_node} · {count} item{}", if count == 1 { "" } else { "s" });

    let fields = items
        .first()
        .and_then(|i| i.get("json"))
        .and_then(Value::as_object)
        .map(|obj| {
            obj.iter()
                .take(4)
                .map(|(k, v)| format!("{k}: {}", fmt_value(v)))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|s| !s.is_empty());

    Some(match fields {
        Some(f) => format!("{header}\n{f}"),
        None => header,
    })
}

fn fmt_value(v: &Value) -> String {
    match v {
        Value::String(s) => s.chars().take(50).collect(),
        Value::Array(a) => format!("[{}]", a.len()),
        Value::Object(_) => "{…}".into(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod notification_tests {
    use super::*;
    #[test]
    fn conditional_headers_polling_and_credential_errors(){
        let request=github_headers("test-token",Some("Sat, 03 Oct 2026 10:00:00 GMT"));
        assert_eq!(request["if-modified-since"],"Sat, 03 Oct 2026 10:00:00 GMT");
        assert_eq!(request["accept"],"application/vnd.github+json");
        let mut headers=reqwest::header::HeaderMap::new();
        assert_eq!(github_poll_delay(&headers,1000),60);
        headers.insert("x-poll-interval","120".parse().unwrap());assert_eq!(github_poll_delay(&headers,1000),120);
        headers.insert("retry-after","600".parse().unwrap());assert_eq!(github_poll_delay(&headers,1000),600);
        headers.insert("x-ratelimit-remaining","0".parse().unwrap());headers.insert("x-ratelimit-reset","1900".parse().unwrap());assert_eq!(github_poll_delay(&headers,1000),900);
        assert!(status_error(401,"classic token needed").contains("Invalid"));assert_eq!(status_error(403,"classic token needed"),"classic token needed");
    }
    #[test]
    fn notification_targets_and_pagination_never_leave_github(){
        assert_eq!(github_target(&json!({"subject":{"url":"https://api.github.com/repos/example/project/pulls/12"}})).as_deref(),Some("https://github.com/example/project/pull/12"));
        assert!(github_target(&json!({"subject":{"url":"https://evil.example/repos/example/project/pulls/12"}})).is_none());
        let mut headers=reqwest::header::HeaderMap::new();
        headers.insert("link",r#"<https://api.github.com/notifications?page=2>; rel="next""#.parse().unwrap());assert!(github_next_page(&headers).is_some());
        headers.insert("link",r#"<https://evil.example/notifications?page=2>; rel="next""#.parse().unwrap());assert!(github_next_page(&headers).is_none());
    }
}
