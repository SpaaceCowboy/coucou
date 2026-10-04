// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { preservePosition, h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { sessionSourceLabel } from "../core/agent-events";
import { State, type AgentTask } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { createMiniBot, pruneMiniBots } from "../mochi/minibots";
import { Bridge } from "../core/bridge";
import { buildClickup } from "./clickup";
import { buildPrompt } from "./chat";
import { relativeTime } from "../core/inbox";
import { setQuiet,releasePendingApproval } from "../core/quiet";
import { openSession, sessionOpenLabel, copySessionId } from "../core/session";
import { buildNextTasks } from "./next-tasks";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  reveal(): void;
  setFocus(id: string): void;
  openSession(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  decide(d: "allow" | "deny"): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  blip(): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", { class: "tab", title: "Overview", onclick: () => go("overview") }, svg(ICONS.house, 13));
  const tabChat = h("button", { class: "tab", title: "Ask a quick question", onclick: () => go("prompt") }, svg(ICONS.bubble, 13));
  const tabHistory = h("button", { class: "tab inbox-tab", title: "Attention inbox", onclick: () => go("history"), text: "◷" });
  const unread=h("span",{class:"unread-count","aria-hidden":"true"});tabHistory.append(unread);
  const tabDrop = h("button", { class: "tab", title: "Help with a file", onclick: () => go("upload") }, svg(ICONS.plus, 13));

  const gearBtn = h("button", { title: "Settings", onclick: () => go("settings") }, svg(ICONS.gear, 14));
  const soundBtn = h("button", { title: "Mute", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, 14));

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabDrop, tabHistory),
    h("div", { class: "header-actions" }, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      unread.textContent=State.unreadCount ? String(Math.min(99,State.unreadCount)) : "";
      tabHistory.setAttribute("aria-label",`Attention inbox, ${State.unreadCount} unread`);
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabHistory.classList.toggle("on", v === "history");
      tabChat.classList.toggle("on", v === "prompt");
      tabDrop.classList.toggle("on", v === "upload");
      gearBtn.classList.toggle("on", v === "settings");
      for(const button of [tabHome,tabHistory,tabChat,tabDrop,gearBtn])button.setAttribute("aria-pressed",String(button.classList.contains("on")));
      clear(gearBtn);
      gearBtn.append(svg(v === "settings" ? ICONS.gearFill : ICONS.gear, 14));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
      soundBtn.setAttribute("aria-label",State.settings.soundEnabled ? "Mute sounds":"Enable sounds");
      soundBtn.title=State.settings.soundEnabled ? "Mute sounds":"Enable sounds";
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };
}

// ── Overview ──────────────────────────────────────────────────────────────────

function buildOverview(actions: ViewActions): ViewHost {
  const ticker = new Ticker();
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: "Open", onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8),
  );
  const left = card(null, leftBody, jump);
  const pills = h("div", { class: "pills" });
  const right = card(null, pills);

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    h("div", { class: "right" }, right),
  );

  let pillIds = "";
  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "card" | null = null;
  let cardKey = "";
  let whoKey = "";

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
  };

  return {
    el,
    tick(nowMs: number) {
      if (mode === "ticker") ticker.tick(nowMs);
    },
    sync() {
      const task = State.focusTask;
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        cardKey = "";
        mode = null;
      }

      // Coding-agent sessions share the ticker; service integrations keep their cards.
      const sessionActive =
        (task?.source === "claudeCode" || task?.source === "codex")
        && (task.state !== "idle" || task.steps.length > 0 || task.source === "codex");

      if (task?.source === "clickup") {
        if(mode!=="card"){mode="card";cardKey="";}
        const nextKey=JSON.stringify(State.integrations.integration_clickup);
        if(cardKey!==nextKey){cardKey=nextKey;preservePosition(leftBody,()=>{clear(leftBody);leftBody.append(buildNextTasks(()=>actions.setView("clickup")));});}
      } else if (task && sessionActive) {
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "ticker";
          cardKey = "";
        }
        const newWhoKey=[task.id,task.name,task.state,task.sessionCwd,task.steps.at(-1),State.capabilities.codexLinks].join("|");
        if(newWhoKey!==whoKey){whoKey=newWhoKey;preservePosition(who,()=>{clear(who);
        const codex = task.source === "codex";
        tickerBody.classList.toggle("codex-summary", codex);
        who.append(dot(task.color, 7), h("span", { class: "name", text: task.name, title: task.name }));
        if (codex) {
          who.append(h("span", { class: "project", text: task.sessionCwd?.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Codex", title: task.sessionCwd || "" }));
          const status = ({ thinking: "Thinking…", working: "Working…", question: "Waiting for you", approval: "Needs your decision", ratelimit: "Waiting for usage limit", error: "Needs attention", finished: "Finished", idle: "Idle" } as Record<string, string>)[task.state] || "Working…";
          // Keep activity available on hover without presenting tool names as task progress.
          who.append(h("div", { class: "session-status" },
            h("span", { class: "tool", text: "Codex · " + status, title: task.steps.at(-1) || status }),
          h("button", { class: "link-btn open-chat", text: sessionOpenLabel(), onclick: () => actions.openSession() }),
          !State.capabilities.codexLinks ? h("button",{class:"link-btn",text:"Copy ID",title:task.sessionId ?? "",onclick:(event:Event)=>void copySessionId(event.currentTarget as HTMLElement,task.sessionId)}):null));

        } else {
          who.append(h("span", { class: "tool", text: sessionSourceLabel(task.source) }));
          if (task.steps.length > 1) who.append(h("span", {
            class: "count", text: `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}`,
          }));
        }
        });}
        ticker.sync(task);
      } else if (task) {
        const info = State.integrations[task.id];
        const key = [
          task.id, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured, info?.refreshing, info?.lastSuccess,State.notificationRevision,
          JSON.stringify(info?.data ?? {}),
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          preservePosition(leftBody,()=>{clear(leftBody);leftBody.append(renderIntegrationCard(task, hooks));});
        }
      }

      jump.style.display = detailOpen ? "none" : "";

      const others = State.otherTasks;
      const pillKey = others.map((t) => `${t.id}:${t.name}:${t.sessionCwd}:${t.state}:${t.pillBadge ?? ""}`).join("|");
      if (pillKey !== pillIds) {
        pillIds = pillKey;
        preservePosition(pills,()=>{clear(pills);for (const t of others) pills.append(buildPill(t, actions));});
        pruneMiniBots();
      }
    },
  };
}

function buildPill(task: AgentTask, actions: ViewActions): HTMLElement {
  const label = task.id === "integration_claude" ? "VS Code" : task.name;
  const canvas = createMiniBot(task, 24);
  const pill = h(
    "div",
    { class: "pill", "data-task-id":task.id, role: "button", tabindex: "0", title: task.name + (task.sessionCwd ? " · " + task.sessionCwd : ""), onclick: () => actions.setFocus(task.id), onkeydown: (event: Event) => { const e = event as KeyboardEvent; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); actions.setFocus(task.id); } } },
    canvas,
    h("span", { class: "lbl" }, h("span", {text:label}),
      task.source === "codex" ? h("small",{text:task.sessionCwd?.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Codex"}) : null),
  );
  if (task.source === "codex" && ["finished","idle"].includes(task.state)) {
    pill.append(h("button", { class: "dismiss-chat", title: "Dismiss chat", text: "×", onclick: (e: Event) => { e.stopPropagation(); State.dismissChat(task.id); } }));
  }
  pill.style.borderColor = `${task.color}24`;
  pill.addEventListener("mouseenter", () => {
    pill.style.background = `${task.color}2e`;
    pill.style.borderColor = `${task.color}8c`;
    pill.style.boxShadow = `0 2px 10px ${task.color}59`;
    (pill.querySelector(".lbl") as HTMLElement).style.color = lighten(task.color, 0.3);
  });
  pill.addEventListener("mouseleave", () => {
    pill.style.background = "";
    pill.style.borderColor = `${task.color}24`;
    pill.style.boxShadow = "";
    (pill.querySelector(".lbl") as HTMLElement).style.color = "";
  });

  if (task.pillBadge) {
    const colors = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" } as const;
    const icons = { approval: ICONS.bang, finished: ICONS.check, error: ICONS.xmark } as const;
    const inner = h("i", { style: `background:${colors[task.pillBadge]}` }, svg(icons[task.pillBadge], 6, { stroke: task.pillBadge === "finished" ? 3 : 0 }));
    const badge = h("div", { class: "pill-badge" }, inner);
    badge.style.boxShadow = `0 0 4px ${colors[task.pillBadge]}99`;
    pill.append(badge);
  }
  return pill;
}

function lighten(hex: string, amount: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) =>
    Math.min(255, Math.round(x + amount * 255)),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: "Nothing running right now." }),
      h("div", { class: "sub", text: "Drop a file, check your inbox, or ask a quick question." }),
    ),
    h("div", { class: "grow" }),
    btn("Ask Mochi", "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Approval ──────────────────────────────────────────────────────────────────

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("amber", stack(116, 16, who, code, row)));
  let rowKey = "";
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "needs permission"));
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = State.pendingApproval?.command || State.pendingApproval?.tool || "…";
      // Two buttons, built once. Rebuilding them between a mouse-down and a
      // mouse-up would swallow the click, and there is nothing left to vary:
      // "Always" is gone until the remembered-rules list exists to back it.
      if (rowKey === "built") return;
      rowKey = "built";
      clear(row);
      row.append(
        btn("Deny", "secondary", () => actions.decide("deny"), "N"),
        btn("Allow", "primary", () => actions.decide("allow"), "Y"),
      );
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const open = btn("Open chat", "primary", () => actions.openSession());
  const copy=h("button",{class:"link-btn",text:"Copy ID",onclick:(event:Event)=>void copySessionId(event.currentTarget as HTMLElement,State.focusTask?.sessionId)});
  const note = h("div", { class: "sub", text: "Answer in your terminal — Coucou can't reply for you yet." });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("cyan", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, `${sessionSourceLabel(State.focusTask?.source)} needs attention`));
      const task = State.focusTask;
      open.querySelector("span")!.textContent=sessionOpenLabel();
      title.textContent = task?.steps.at(-1) ?? "Waiting for your input.";
      const content = task?.source === "codex" ? open : note;
      if (row.firstChild !== content) row.replaceChildren(content);
      if(task?.source==="codex" && !State.capabilities.codexLinks && !copy.parentElement)row.append(copy);
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title", text: "Workflow stopped." });
  const detail = h("div", { class: "detail" });
  const open = btn("Open in n8n", "secondary", () => actions.openTarget());
  const copy=h("button",{class:"link-btn",text:"Copy ID",onclick:(event:Event)=>void copySessionId(event.currentTarget as HTMLElement,State.focusTask?.sessionId)});
  const row = h("div", { class: "actions" },
    open,
    copy,
  );
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));
  return {
    el,
    sync() {
      const task = State.focusTask;
      copy.hidden=task?.source!=="codex" || State.capabilities.codexLinks;
      clear(who);
      who.append(agentWho(task, sessionSourceLabel(task?.source)));
      title.textContent = task?.source === "n8n" ? "Workflow stopped."
        : task?.state === "working" ? "A command or tool failed." : "Session stopped on an error.";
      detail.textContent = task?.steps.at(-1) ?? "No detail available.";
      open.querySelector("span")!.textContent = task?.source === "codex" ? sessionOpenLabel()
        : task?.source === "n8n" ? "Open in n8n" : "Open terminal";
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const open = btn("Open terminal", "primary", () => actions.openSession());
  const copy=h("button",{class:"link-btn",text:"Copy ID",onclick:(event:Event)=>void copySessionId(event.currentTarget as HTMLElement,State.focusTask?.sessionId)});
  const row = h("div", { class: "actions" },
    open,
    copy,
    btn("OK", "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, `${sessionSourceLabel(State.focusTask?.source)} finished`));
      copy.hidden=State.focusTask?.source!=="codex" || State.capabilities.codexLinks;
      open.querySelector("span")!.textContent = State.focusTask?.source === "codex" ? sessionOpenLabel() : "Open terminal";
      title.textContent = State.focusTask?.steps.at(-1) ?? "Session finished";
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: "Too many hits at once." }),
    h("div", { class: "sub", text: "Give me a sec — back to work in three seconds." }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(actions:ViewActions): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title,h("button",{class:"link-btn",text:"Back",onclick:()=>actions.setView(State.defaultView())}))));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", "aria-label":"Sound", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005", "aria-label":"Sound volume",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const segButtons = [10, 15, 30].map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`),
  );
  const claudeBadge = h("span", { class: "status-badge" });
  const apiBadge = h("span", { class: "status-badge" });
  const quiet=h("select",{"aria-label":"Quiet mode",class:"quiet-select"}) as HTMLSelectElement;
  for(const [value,text] of [["off","Quiet mode off"],["0","Until I turn it off"],["30","Quiet for 30 minutes"],["60","Quiet for 1 hour"],["120","Quiet for 2 hours"]])quiet.append(h("option",{value,text}));
  quiet.onchange=()=>setQuiet(quiet.value==="off" ? null : quiet.value==="0" ? 0 : Date.now()+Number(quiet.value)*60_000);

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div",{class:"settings-row"},quiet),
    h("div",{class:"settings-row"},h("button",{class:"link-btn",text:"Pause / Resume monitoring",onclick:()=>{
      State.paused=!State.paused;if(State.paused)releasePendingApproval("Paused");void Bridge.setPaused(State.paused);State.notify();
    }}),h("span",{class:"monitoring-status"})),
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: "Sound" }), volume),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.timer, 12),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      claudeBadge,
      apiBadge,
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: "Settings…",
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      rows.querySelector(".monitoring-status")!.textContent=State.paused ? "Paused":"Monitoring";
      if(document.activeElement!==quiet)quiet.value=State.quiet ? s.quietUntil===0 ? "0" : String([30,60,120].find(m=>(s.quietUntil!-Date.now())/60_000<=m) ?? 120) : "off";
      soundSwitch.classList.toggle("on", s.soundEnabled);
      soundSwitch.setAttribute("aria-pressed",String(s.soundEnabled));
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      autoLabel.textContent = `Auto-close · ${Math.round(s.autoCloseInterval)}s`;
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));
      clear(claudeBadge);
      claudeBadge.append(
        dot(s.hooksInstalled ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Claude Code" }),
      );
      clear(apiBadge);
      apiBadge.append(dot(State.chatError ? "#F4505E":State.chatConfigured ? "#22C55E":"#F5A524", 6), h("span", { text: `${s.chatProvider === "codex" ? "Codex":"Claude"} · ${State.chatError ? "Failed":State.chatLastSuccess ? "Connected":State.chatConfigured ? "Configured":"Connect in Settings"}` }));
      apiBadge.title=State.chatError ?? (State.chatLastSuccess ? `Last reply ${new Date(State.chatLastSuccess).toLocaleString()}`:"Provider configuration status");
    },
  };
}

// ── Placeholders filled in later stages ───────────────────────────────────────

function buildPlaceholder(title: string, sub: string): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px" },
    h("div", { class: "title", text: title }),
    h("div", { class: "sub", text: sub }),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

function buildHistory(actions: ViewActions): ViewHost {
  const list = h("div", { class: "history-list" });
  let key = "";
  return { el: h("div", { class: "view" }, card(null, h("div", { class: "utility-body" },
    h("div", { class: "title", text: "Attention inbox" }), list))), sync() {
    const next = State.historyStorageError + Math.floor(Date.now()/60_000) + JSON.stringify(State.recentAlerts);
    if (key === next) return; key = next;
    const scroll=list.scrollTop;
    const active=document.activeElement as HTMLElement|null;
    const focusKey=active?.dataset.inboxFocus;
    clear(list);
    if (State.historyStorageError) list.append(h("div",{class:"sub",text:State.historyStorageError}));
    if (!State.recentAlerts.length) list.append(h("div", { class: "sub", text: "All caught up. Useful updates will appear here." }));
    for (const a of State.recentAlerts) {
      const open=h("button",{class:"btn secondary",text:a.action?.kind==="session" ? sessionOpenLabel():"Open",disabled:!a.action || (a.action.kind==="session" && !State.capabilities.codexLinks && !a.action.cwd),"data-inbox-focus":a.id+":open",onclick:()=>{
        State.markAlertRead(a.id);
        const target=a.action;
        if(target?.kind==="url")void Bridge.openUrl(target.url);
        else if(target?.kind==="session")openSession(target.sessionId,target.cwd);
        else if(target?.kind==="folder")void Bridge.openInVSCode(target.path);
        else if(target?.kind==="settings")actions.openSettingsWindow();
        else if(target?.kind==="clickup"){State.setFocus("integration_clickup");actions.setView("clickup");}
      }});
      const read=h("button",{class:"link-btn",text:"Mark read",disabled:a.read,"data-inbox-focus":a.id+":read",onclick:()=>State.markAlertRead(a.id)});
      list.append(h("div", { class: `history-row ${a.read ? "":"unread"}` },
      h("div", { class: "grow" }, h("div", { class: "name", text: a.title + " · " + a.kind }),
        h("div", { class: "sub", text: a.message }), h("small", { text: `${({integration_github:"GitHub",integration_clickup:"ClickUp",integration_claude:"Claude Code",claudeCode:"Claude Code",codex:"Codex",integration_calcom:"Cal.com"} as Record<string,string>)[a.source] ?? a.title} · ${relativeTime(a.time)}`,title:new Date(a.time).toLocaleString() })),
      h("div",{class:"inbox-actions"},open,read,a.action?.kind==="session" && !State.capabilities.codexLinks ? h("button",{class:"link-btn",text:"Copy ID","data-inbox-focus":a.id+":copy",title:a.action.sessionId,onclick:(event:Event)=>void copySessionId(event.currentTarget as HTMLElement,a.action?.kind==="session" ? a.action.sessionId:null)}):null),
      h("button", { class: "link-btn", text: "×", title: "Dismiss alert","data-inbox-focus":a.id+":dismiss", onclick: () => State.dismissAlert(a.id) })));
    }
    list.scrollTop=scroll;
    if(focusKey)Array.from(list.querySelectorAll<HTMLElement>("[data-inbox-focus]")).find(el=>el.dataset.inboxFocus===focusKey)?.focus({preventScroll:true});
  }};
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("clickup", buildClickup(actions));
  map.set("history", buildHistory(actions));
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestion(actions));
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote(actions));
  map.set("settings", buildSettings(actions));
  map.set("prompt", buildPrompt(onChatHeightChange));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  // Not in the Windows v1: sending a file by email, window attach + web result.
  map.set("mail", buildPlaceholder("Sending by email isn't in this version.", ""));
  map.set("searching", buildPlaceholder("Claude is searching…", ""));
  map.set("result", buildPlaceholder("Result", ""));
  return map;
}
