import { Bridge } from "../core/bridge";
import { State } from "../core/state";
import { Sound } from "../core/sound";
import { h } from "./dom";
import type { ViewActions, ViewHost } from "./views";

export interface ClickupProposal {
  id: number; action: "create" | "edit" | "delete"; workspace: string; listId: string;
  taskId: string | null; target: string; before: Record<string, unknown> | null;
  fields: Record<string, unknown>; listName: string;
  members: { user: { id: number; username?: string; email?: string } }[];
}
export interface ClickupSetup { workspaces: {id: string; name: string}[]; lists: {id: string; name: string}[]; }

export function buildClickup(actions: ViewActions): ViewHost {
  const messages = h("div", { class: "clickup-messages", "aria-live": "polite" });
  const field = h("input", { placeholder: "Ask ClickUp…", "aria-label": "ClickUp request", autocomplete: "off" }) as HTMLInputElement;
  const send = h("button", { class: "btn primary", text: "Send" });
  const status = h("span", { class: "sub", text: "Every change waits for your review." });
  const el = h("div", { class: "view" }, h("div", { class: "card" }, h("div", { class: "utility-body" },
    h("div", { class: "actions" }, h("span", { class: "title", text: "ClickUp" }), status,
      h("button", { class: "link-btn", text: "Connect / Settings", onclick: () => actions.openSettingsWindow() })),
    messages, h("form", { class: "clickup-compose", onsubmit: (e: Event) => { e.preventDefault(); void submit(); } }, field, send))));
  let busy = false;
  let pending: ClickupProposal | null = null;

  function line(text: string, role = "assistant") {
    messages.append(h("div", { class: `clickup-line ${role}`, text }));
    messages.scrollTop = messages.scrollHeight;
  }
  function update(state: "working" | "question" | "finished" | "error", message: string) {
    State.updateTask("integration_clickup", state);
    State.appendStep("integration_clickup", message.slice(0,60));
    if (state !== "working" && !State.paused) {
      const kind = state === "question" ? "approval" : state;
      State.recordAlert("integration_clickup", kind, message);
      if (State.focusTask?.id !== "integration_clickup" || State.view !== "clickup") State.setPillBadge("integration_clickup", kind);
      if (State.view !== "clickup" || State.mode !== "expanded") actions.reveal();
      Sound.play(state === "question" ? "approval" : state === "finished" ? "finish" : "error");
    }
  }
  function controls() { send.disabled = busy || !!pending || State.paused; field.disabled = busy || !!pending || State.paused; }
  function value(key: string, data: unknown, proposal: ClickupProposal): string {
    if (data == null) return "None";
    if (key === "due_date") return new Date(Number(data)).toLocaleString();
    if (key === "priority") return ({1:"Urgent",2:"High",3:"Normal",4:"Low"} as Record<string,string>)[String(data)] || String(data);
    if (key === "assignees" && Array.isArray(data)) return data.map(id => {
      const member = proposal.members?.find(m => m.user.id === id)?.user;
      return member?.username || member?.email || String(id);
    }).join(", ") || "None";
    return typeof data === "string" ? data : JSON.stringify(data);
  }
  function review(proposal: ClickupProposal) {
    const details = h("pre");
    const list = proposal.action === "create" ? proposal.listName : proposal.before?.list;
    details.textContent = `Task: ${proposal.target}${proposal.taskId ? ' (' + proposal.taskId + ')' : ''}\nList: ${String(list || proposal.listName)}\n`;
    if (proposal.action === "delete") details.textContent += "This will delete the task.";
    else for (const [key, next] of Object.entries(proposal.fields)) {
      details.textContent += `\n${key.replaceAll('_',' ')}: ${proposal.action === "edit" ? value(key, proposal.before?.[key], proposal) + ' → ' : ''}${value(key, next, proposal)}`;
    }
    const confirm = h("button", { class: "btn primary", text: proposal.action === "delete" ? "Confirm delete" : "Confirm change" });
    const cancel = h("button", { class: "btn secondary", text: "Cancel" });
    const box = h("div", { class: "clickup-review" }, h("strong", {text: "Review " + proposal.action}), details, h("div", {class:"actions"},confirm,cancel));
    const act = async (approved: boolean) => {
      if (busy || State.paused || pending?.id !== proposal.id) return;
      busy = true; confirm.disabled = cancel.disabled = true; controls();
      try {
        if (approved) {
          const result = await Bridge.clickupConfirm(proposal.id);
          line(result.message);
          if (result.url) messages.append(h("button", {class:"link-btn",text:"Open task in ClickUp",onclick:()=>actions.openUrl(result.url!)}));
          update("finished", result.message);
        } else { await Bridge.clickupCancel(proposal.id); line("Cancelled. No change made."); State.updateTask("integration_clickup", "idle"); }
        pending = null; box.remove();
      } catch (err) {
        line(String(err).replace(/^Error:\s*/,"")); update("error", String(err));
        // Confirm consumes the proposal before attempting a write, including uncertain failures.
        if (approved) { pending = null; box.remove(); }
        else { confirm.disabled = cancel.disabled = false; }
      } finally { busy = false; controls(); }
    };
    confirm.onclick = () => void act(true); cancel.onclick = () => void act(false);
    messages.append(box); messages.scrollTop = messages.scrollHeight;
  }
  async function submit(selectedTask: string | null = null, request?: string) {
    const query = request ?? field.value.trim();
    if (!query || busy || pending || State.paused) return;
    field.value = ""; busy = true; controls(); line(query, "user"); update("working", "Reading your ClickUp request…");
    status.textContent = "Thinking…";
    try {
      const reply = await Bridge.clickupSend(query, `${new Date().toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone}), Unix milliseconds ${Date.now()}`, selectedTask);
      line(reply.text); pending = reply.proposal;
      if (!pending && reply.choices.length) {
        line("Select the exact task to continue:");
        const choices = h("div", {class:"actions",style:"flex-wrap:wrap"});
        for (const task of reply.choices) choices.append(h("button",{class:"btn secondary",text:task.name+" · "+task.list+" ("+task.id+")",
          onclick:()=>{if(!busy&&!pending&&!State.paused){choices.remove();void submit(task.id,query+"\nUse the task I selected: "+task.name+" ("+task.id+").");}}}));
        messages.append(choices);
      }
      if (pending) { review(pending); update("question", `Review ${pending.action}: ${pending.target}`); }
      else update(reply.choices.length || reply.text.trim().endsWith("?") ? "question" : "finished", reply.text);
    } catch (err) { const text = String(err).replace(/^Error:\s*/,""); line(text); update("error", text); }
    finally { busy = false; status.textContent = "Every change waits for your review."; controls(); }
  }
  return { el, sync: controls, focus: () => { if (!field.disabled) field.focus(); } };
}
