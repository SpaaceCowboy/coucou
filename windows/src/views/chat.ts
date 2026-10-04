// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView from
// IslandViewContent.swift.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge, type ChatContext } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import type { ViewHost } from "./views";

let nextId = 1;

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  const copy=h("button",{class:"link-btn copy-reply",text:"Copy reply",onclick:async()=>{
    try {await navigator.clipboard.writeText(message.content);copy.textContent="Copied";}catch{copy.textContent="Select text to copy";}
  }});
  return h("div", { class: "chat-row" }, h("div",{class:"reply-group"},h("div", { class: "reply", text: message.content }),copy));
}

function typingDots(): HTMLElement {
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
  );
}

/** The coloured chip showing what the question is about (a dropped file). */
function contextChip(label: string): HTMLElement {
  const chip = h("div", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

export function buildPrompt(onHeightChange: () => void): ViewHost {
  const providerLabel = h("span");
  const errorBox = h("div", {class:"chat-error",role:"alert"});
  const fresh = h("button",{class:"link-btn",text:"New chat",onclick:()=>void reset(true)});
  const toolbar = h("div",{class:"chat-toolbar"},providerLabel,h("button",{class:"link-btn",text:"Settings",onclick:()=>void Bridge.openSettingsWindow()}),fresh);
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "Ask me anything…",
    spellcheck: "false",
    "aria-label": "Chat message",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: "Send" }, svg(ICONS.arrowUp, 11));
  const bar = h("div", { class: "chat-bar" }, input, send);

  const el = h(
    "div",
    { class: "view" },
    h("div", { class: "card wash chat-card" }, h("div", { class: "chat-body" }, toolbar, chipRow, log, errorBox, bar)),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  let sending = false;
  let renderedCount = -1;
  let resetting = false;
  let conversationProvider = State.settings.chatProvider;
  let attachmentPath="";

  async function reset(clearFile = false) {
    if (sending || resetting) return;
    resetting = true; conversationProvider = State.settings.chatProvider;
    State.chatHistory = []; State.stateOverride = null; renderedCount = -1; errorBox.textContent = "";
    if (clearFile) {input.value = ""; State.droppedFile = null; State.promptContext = null;}
    State.notify(); onHeightChange();
    try { await Bridge.chatReset(); } finally {resetting = false; State.notify(); if(State.view==="prompt" && State.mode==="expanded")input.focus();}
  }

  async function submit() {
    const query = input.value.trim();
    if (!query || sending || resetting || State.paused) return;
    const provider = conversationProvider;
    let requested=false;
    const messageId = nextId++;
    errorBox.textContent = "";
    input.value = "";
    sending = true;
    Sound.play("send");

    State.chatHistory.push({ id: messageId, role: "user", content: query });
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();

    const file = State.droppedFile;
    const context: ChatContext | null =
      State.chatHistory.length === 1 && file ? { kind: "file", name: file.name, path: file.path } : null;

    try {
      if(file && State.chatHistory.length===1)await Bridge.attachmentCheck(file.path,provider);
      requested=true;
      const reply = await Bridge.chatSend(query, context);
      if (provider !== State.settings.chatProvider) return;
      State.chatHistory.push({ id: nextId++, role: "assistant", content: reply.text });
      State.chatError=null;State.chatLastSuccess=Date.now();State.chatConfigured=true;
      State.stateOverride = null;
      Sound.play("finish");
    } catch (err) {
      State.stateOverride = null;
      if (provider !== State.settings.chatProvider) return;
      State.chatHistory = State.chatHistory.filter(message => message.id !== messageId);
      errorBox.textContent = String(err).replace(/^Error:\s*/, "");
      if(requested)State.chatError=errorBox.textContent;
      if (!input.value) input.value = query;
      Sound.play("error");
    } finally {
      sending = false;
      State.stateOverride = null;
      State.notify();
      onHeightChange();
      if(State.view==="prompt" && State.mode==="expanded")input.focus();
    }
  }

  send.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      void submit();
    }
    if((e as KeyboardEvent).key!=="Escape")e.stopPropagation();
  });

  return {
    el,
    sync() {
      providerLabel.textContent = State.settings.chatProvider === "codex" ? "Codex · ChatGPT" : "Claude";
      fresh.disabled = sending || resetting;
      if (!sending && !resetting && conversationProvider !== State.settings.chatProvider) void reset();
      const file = State.droppedFile;
      if(!sending && !resetting && attachmentPath!==(file?.path ?? "")) {
        attachmentPath=file?.path ?? "";
        if(State.chatHistory.length)void reset();
      }
      if(State.promptDraft!==null) {input.value=State.promptDraft;State.promptDraft=null;}
      const wantChip = file?.name ?? "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (wantChip) {
          const chip=contextChip(wantChip);
          chip.append(h("button",{class:"remove-context",text:"×",title:"Remove attachment and start a new chat",onclick:()=>{
            if(sending || resetting)return;
            State.droppedFile=null;State.promptContext=null;attachmentPath="";void reset();
          }}));
          chipRow.append(chip);
        }
      }

      const thinking = State.stateOverride === "thinking";
      const count = State.chatHistory.length + (thinking ? 0.5 : 0);
      if (count !== renderedCount) {
        const atBottom=log.scrollHeight-log.scrollTop-log.clientHeight<32;
        const scroll=log.scrollTop;
        renderedCount = count;
        clear(log);
        for (const m of State.chatHistory) log.append(bubble(m));
        if (thinking) log.append(typingDots());
        log.scrollTop = atBottom ? log.scrollHeight : scroll;
      }

      input.placeholder = State.chatHistory.length === 0 ? "Ask me anything…" : "Continue…";
      input.disabled = send.disabled = sending || resetting || State.paused;
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
