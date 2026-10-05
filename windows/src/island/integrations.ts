import { onEvent, Bridge, type IntegrationUpdate } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { Island } from "./island";

const KEY_FOR: Record<string, string> = {
  integration_stripe:"stripe-api-key", integration_github:"github-token", integration_vercel:"vercel-token",
  integration_n8n:"n8n-api-key", integration_resend:"resend-api-key",integration_notion:"notion-api-key",
  integration_calcom:"calcom-api-key",integration_clickup:"clickup-api-token",
};
const OPEN_URLS:Record<string,string> = {
  integration_github:"https://github.com/notifications",integration_vercel:"https://vercel.com/dashboard",
  integration_resend:"https://resend.com/emails",integration_stripe:"https://dashboard.stripe.com/payments",
};
const clearTimers = new Map<string,number>();

export function registerIntegrationHandlers(island:Island) {
  void onEvent<IntegrationUpdate>("integration",update=>handleIntegration(island,update));
  void refreshConfigured();
}

export async function refreshConfigured() {
  await Promise.all(Object.entries(KEY_FOR).map(async ([id,key])=>{
    const status = await Bridge.secretStatus(key);
    const previous = State.integrations[id] ?? {data:{},error:null,loaded:false,configured:false};
    const urlStatus=id==="integration_n8n" ? await Bridge.secretStatus("n8n-url"):null;
    const configured = !!status?.present && (id !== "integration_clickup" || !!(State.settings.clickupWorkspace && State.settings.clickupList)) && (id!=="integration_n8n" || !!urlStatus?.present);
    State.integrations[id] = {...previous,configured,error:status?.error ?? (configured ? previous.error : null)};
  }));
  State.integrations.integration_claude = {data:{},error:null,loaded:true,configured:State.settings.hooksInstalled};
  const chat = await Bridge.chatStatus();
  State.chatConfigured = chat?.configured ?? false;
  if(chat?.error)State.chatError=chat.error;
  State.notify();
}

export async function refreshIntegration(id:string) {
  const info = State.integrations[id];
  if (!info || State.paused || info.refreshing) return;
  info.refreshing=true;State.notify();
  try { await Bridge.refreshIntegration(id); } finally { const current=State.integrations[id];if(current)current.refreshing=false;State.notify(); }
}

export function handleIntegration(island:Island,update:IntegrationUpdate) {
  if (State.paused) return;
  const previous = State.integrations[update.id];
  State.integrations[update.id] = {
    data:update.error ? (previous?.data ?? {}) : update.data,error:update.error,
    loaded:update.error ? (previous?.loaded ?? false) : true,configured:previous?.configured ?? true,
    checkedAt:update.checkedAt ?? Date.now(),lastSuccess:update.error ? previous?.lastSuccess : update.lastSuccess ?? Date.now(),refreshing:false,
  };
  const task = State.tasks.find(t=>t.id===update.id);
  const title=task?.name ?? update.id.replace("integration_","");
  const preference=State.notificationPreference(update.id);
  if(task && preference==="off"){
    task.pillBadge=null;task.state="idle";task.steps=[];
    const timer=clearTimers.get(task.id);if(timer!=null)window.clearTimeout(timer);clearTimers.delete(task.id);
  }
  const connectionNew=State.connectionUpdate(update.id,title,update.error);
  if(update.error && task && preference!=="off")task.pillBadge="error";
  if(!update.error && previous?.error && task && task.steps.length===0)task.pillBadge=null;
  if(connectionNew && !State.quiet){Sound.play("error");island.reveal();}
  const events=update.events ?? (update.event ? [update.event] : []);
  for(const event of events) {
    const actionable=!event.success || event.category==="input" || event.category==="update";
    const isNew = preference === "off" || (preference==="actionable" && !actionable) ? false : State.recordInbox({
      taskId:update.id,source:update.id,eventId:event.eventId ?? `${event.label}:${event.detail ?? ""}`,
      kind:event.category ?? (event.success ? "finished" : "error"),title,message:[event.label,event.detail].filter(Boolean).join(" · "),
      time:event.timestamp ?? Date.now(),
      action:update.id==="integration_clickup" ? {kind:"clickup"} : event.url || OPEN_URLS[update.id]
        ? {kind:"url",url:event.url ?? OPEN_URLS[update.id]} : {kind:"settings"},
    }, !event.silent);
    if(task && preference!=="off" && !event.silent) {
      task.state=event.success ? "finished":"error";
      task.steps=[event.label,...(event.detail ? [event.detail]:[])];task.stepIndex=task.steps.length-1;
      task.pillBadge=event.success ? "finished":"error";
      const old=clearTimers.get(task.id);if(old!=null)window.clearTimeout(old);
      clearTimers.set(task.id,window.setTimeout(()=>{clearTimers.delete(task.id);task.state="idle";task.pillBadge=null;State.notify();},60_000));
    }
    if(isNew && actionable && !State.quiet && !event.silent) {
      if(actionable) Sound.play(event.success ? "question":"error");
      island.reveal();
    }
  }
  State.persistSessions();State.notify();
}
