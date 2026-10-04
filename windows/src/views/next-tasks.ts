import { h } from "./dom";
import { State } from "../core/state";
import { Bridge } from "../core/bridge";
import { refreshIntegration } from "../island/integrations";
import { timeAgo } from "./integrations";

export function buildNextTasks(openCommands:()=>void):HTMLElement {
  const info=State.integrations.integration_clickup;
  const body=h("div",{class:"int-card next-tasks"},h("div",{class:"int-head"},h("b",{text:"ClickUp"}),h("span",{text:"My next tasks"})));
  const status=info?.error ? "Failed":!info?.configured ? "Not connected":info?.refreshing || !info?.loaded ? "Loading":info.lastSuccess && Date.now()-info.lastSuccess>10*60_000 ? "Stale":"Connected";
  body.setAttribute("aria-label",`ClickUp · ${status}`);
  const tasks=Array.isArray(info?.data.tasks) ? info.data.tasks as {id:string;name:string;status:string;dueDate:number|null;url:string}[] : [];
  if(info?.error)body.append(h("div",{class:"int-status error",text:info.error}));
  if(!tasks.length && !info?.error)body.append(h("div",{class:"int-empty",text:info?.loaded ? "No open tasks assigned to you in this list." : "Loading your tasks…"}));
  for(const task of tasks.slice(0,3)) {
    const due=task.dueDate ? new Date(task.dueDate) : null;
    const overdue=due && due.getTime()<Date.now();
    body.append(h("button",{class:`next-task ${overdue ? "overdue":""}`,"data-focus-key":task.id,title:task.name,"aria-label":`Open in ClickUp: ${task.name}`,onclick:()=>void Bridge.openUrl(task.url)},
      h("span",{class:"int-name",text:task.name}),h("small",{text:`${task.status} · ${due ? `${overdue ? "Overdue · ":""}${due.toLocaleDateString()}`:"No due date"}`})));
  }
  body.append(h("div",{class:"int-actions"},
    h("button",{class:"link-btn",text:info?.refreshing ? "Refreshing…":"Refresh",disabled:!!info?.refreshing || State.paused,onclick:()=>void refreshIntegration("integration_clickup")}),
    h("button",{class:"link-btn",text:"Ask ClickUp",onclick:openCommands}),
    info?.lastSuccess ? h("small",{text:`${status} · ${timeAgo(info.lastSuccess)}`,title:new Date(info.lastSuccess).toLocaleString()}) : h("small",{text:status})));
  if(info?.error)body.append(h("button",{class:"link-btn",text:"Connection settings",onclick:()=>void Bridge.openSettingsWindow()}));
  return body;
}
