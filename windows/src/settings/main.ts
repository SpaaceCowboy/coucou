// Settings window — the place where anything that writes to disk is confirmed.
// Stage 2 covers the Claude Code hooks and the general preferences; API keys and
// integrations land here too in a later stage.

import "./settings.css";
import { Bridge, onEvent, type HookStatus } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { h, clear } from "../views/dom";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";
let credentialStore="system credential store";
let floatingWindow=false;
let desktopPlatform="windows";

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void, label:string): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on,"aria-label":label });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    el.setAttribute("aria-pressed",String(next));
    onChange(next);
  });
  return el;
}

function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}

function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

// ── Claude Code section ───────────────────────────────────────────────────────

function claudeSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h(
    "section",
    {},
    h("h2", {}, statusDot(status.installed), h("span", { text: "Claude Code" })),
    body,
  );

  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    clear(body);
    draw();
    const head = section.querySelector("h2")!;
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: "Claude Code" }));
  };

  function draw() {
    body.append(
      h("div", {
        class: "hint",
        text: status.installed
          ? "Coucou is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there."
          : "Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing.",
      }),
      h("div", { class: "row" },
        h("label", { text: "settings.json" }),
        h("span", { class: "path", text: status.settingsPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: "Relay" }),
        h("span", { class: "path", text: status.hookPath }),
        statusDot(status.hookReady),
      ),
    );

    if (!status.hookReady) {
      body.append(h("div", {
        class: "notice warn",
        text: "coucou-hook.exe is not in place yet. Restart Coucou; if it still fails, build it with `cargo build -p coucou-hook`.",
      }));
    }

    const actions = h("div", { class: "row" });
    const install = h("button", {
      class: "primary",
      text: status.installed ? "Reinstall hooks…" : "Install hooks…",
      onclick: () => showPreview(true),
    });
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook and nothing to show for it.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = "The relay isn't installed yet.";
    }
    actions.append(install);
    if (status.installed) {
      actions.append(h("button", {
        class: "danger",
        text: "Uninstall hooks…",
        onclick: () => showPreview(false),
      }));
    }
    body.append(actions);
  }

  async function showPreview(install: boolean) {
    let preview;
    try {
      preview = await Bridge.hooksPreview(install);
    } catch (err) {
      // An unreadable or invalid settings.json stops here rather than being
      // treated as empty and written over.
      clear(body);
      body.append(
        h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
        h("div", { class: "row" }, h("button", {
          text: "Back",
          onclick: () => { clear(body); draw(); },
        })),
      );
      return;
    }
    if (!preview) return;
    clear(body);
    body.append(
      h("div", {
        class: "hint",
        text: install
          ? "This is exactly what will change in your settings.json. Your own hooks are left untouched."
          : "This removes Coucou's entries only. Your own hooks are left untouched.",
      }),
      renderDiff(preview.diff),
      h("div", { class: "row" },
        h("span", { class: "path", text: `Backup → ${preview.backup}` }),
      ),
    );
    const confirm = h("button", {
      class: install ? "primary" : "danger",
      text: install ? "Back up and write" : "Back up and remove",
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        const backup = await Bridge.hooksApply(install, preview.fingerprint);
        clear(body);
        body.append(h("div", {
          class: "notice ok",
          text: `Done. Previous settings saved as ${backup}. Open a new Claude Code session to pick the hooks up.`,
        }));
        window.setTimeout(() => void rebuild(), 2600);
      } catch (err) {
        confirm.disabled = false;
        body.append(h("div", { class: "notice err", text: `Could not write: ${String(err)}` }));
      }
    });
    body.append(h("div", { class: "row" }, confirm, h("button", {
      text: "Cancel",
      onclick: () => { clear(body); draw(); },
    })));
  }

  draw();
  return section;
}

// ── Claude API section ────────────────────────────────────────────────────────

const MODELS: [string, string][] = [
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
];

function chatSection(): HTMLElement {
  const provider = h("select", {"aria-label":"Chat provider"}) as HTMLSelectElement;
  provider.append(h("option",{value:"codex",text:"Codex · ChatGPT sign-in"}),h("option",{value:"claude",text:"Claude · API key"}));
  provider.value = settings.chatProvider;
  provider.onchange = () => {settings.chatProvider = provider.value as Settings["chatProvider"];void save();};
  return h("section",{},h("h2",{text:"Chat"}),h("div",{class:"row"},h("label",{text:"Use"}),provider),
    h("div",{class:"hint",text:"Codex uses your existing ChatGPT sign-in and included Codex allowance. No OpenAI API key is needed. Claude keeps its own API key and model below. Changing provider starts a new conversation. PDF attachments use Claude; Codex supports text and images."}));
}

function apiSection(hasKey: boolean): HTMLElement {
  const dot = statusDot(hasKey);
  const state = h("span", { class: "hint", text: hasKey ? "Key saved securely." : "No Claude key yet. Codex chat uses your ChatGPT sign-in." });

  const field = h("input", {
    type: "password",
    placeholder: hasKey ? "••••••••••••  (stored)" : "sk-ant-...",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const saveBtn = h("button", { class: "primary", text: "Save key" });
  const clearBtn = h("button", { class: "danger", text: "Remove" });
  const feedback = h("div", {});

  async function refresh() {
    const present = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
    dot.style.background = present ? "#22c55e" : "#f4505e";
    state.textContent = present
      ? "Key saved securely."
      : "No Claude key yet. Codex chat uses your ChatGPT sign-in.";
    field.placeholder = present ? "••••••••••••  (stored)" : "sk-ant-...";
    clearBtn.style.display = present ? "" : "none";
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet("anthropic-api-key", value);
      field.value = "";
      feedback.append(h("div", { class: "notice ok", text: "Saved. It never touches disk." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not save: ${String(err)}` }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear("anthropic-api-key");
      feedback.append(h("div", { class: "notice ok", text: "Key removed." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not remove: ${String(err)}` }));
    }
  });

  const model = h("select", {}) as HTMLSelectElement;
  for (const [id, label] of MODELS) model.append(h("option", { value: id, text: label }));
  if (!MODELS.some(([id]) => id === settings.model)) {
    model.append(h("option", { value: settings.model, text: settings.model }));
  }
  model.value = settings.model;
  model.addEventListener("change", () => {
    settings.model = model.value;
    void save();
  });

  clearBtn.style.display = hasKey ? "" : "none";

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: "Claude" })),
    state,
    h("div", { class: "row" }, h("label", { text: "API key" }), field, saveBtn, clearBtn),
    h("div", { class: "row" }, h("label", { text: "Model" }), model),
    feedback,
  );
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: "Secret key", placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: "Token", placeholder: "ghp_…", secret: true }] },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: "Token", placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: "Instance URL", placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: "API key", placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: "API key", placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: "Integration token", placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: "API key", placeholder: "cal_…", secret: true }] },
];

const MAX_ACTIVE = 4;

function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  function updateNote() {
    const used = settings.activeIntegrations.length;
    note.textContent = `Pick up to ${MAX_ACTIVE} pills to show next to Mochi — ${used}/${MAX_ACTIVE} in use. Keys are stored in ${credentialStore}, never in preferences.`;
  }

  for (const def of INTEGRATIONS) {
    const active = settings.activeIntegrations.includes(def.id);
    const sw = h("button", { class: active ? "switch on" : "switch", "aria-label":def.name+" monitoring", "aria-pressed":active });
    sw.addEventListener("click", () => {
      const on = settings.activeIntegrations.includes(def.id);
      if (on) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        if (settings.activeIntegrations.length >= MAX_ACTIVE) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      sw.classList.toggle("on", !on);sw.setAttribute("aria-pressed",String(!on));
      updateNote();
      void save();
    });

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? "••••••••  (stored)" : field.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0", "aria-label":def.name+" "+field.label,
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: "Save" });
      const dotEl = statusDot(present[field.key] ?? false);
      const connectionMessage=h("div",{class:"hint",role:"status"});
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0; await save();
          input.value = "";
          input.placeholder = value ? "••••••••  (stored)" : field.placeholder;
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch (error) {
          connectionMessage.textContent=String(error).replace(/^Error:\s*/,"");
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: field.label }),
          input, saveBtn, dotEl,
        ),
      );
      rows.append(connectionMessage);
      void Bridge.secretStatus(field.key).then(status=>{if(status?.error)connectionMessage.textContent=status.error;});
    }

    list.append(
      h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
        h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
          sw,
          h("i", { class: "dot", style: `background:${def.color}` }),
          h("span", { style: "font-size:12.5px", text: def.name }),
        ),
        rows,
      ),
    );
  }

  list.append(h("div",{class:"hint",text:"GitHub notifications need a classic personal access token with notifications access; fine-grained tokens are unsupported. Existing tokens are never replaced automatically."}));
  updateNote();
  return h("section", {}, h("h2", {}, h("span", { text: "Integrations" })), note, list);
}

function clickupSection(): HTMLElement {
  const token = h("input", {type:"password",placeholder:"ClickUp personal API token",autocomplete:"off",style:"flex:1;min-width:0","aria-label":"ClickUp token"}) as HTMLInputElement;
  const feedback = h("div", {class:"hint",text:"Connect ClickUp, then choose a workspace and default list. Commands use your Codex ChatGPT sign-in."});
  const workspace = h("select", {"aria-label":"ClickUp workspace"}) as HTMLSelectElement;
  const list = h("select", {"aria-label":"ClickUp default list"}) as HTMLSelectElement;
  const connect = h("button", {class:"primary",text:"Connect / Refresh"});
  const saveToken = h("button",{text:"Save token"});
  const remove = h("button",{class:"danger",text:"Disconnect"});
  const option = (value:string,text:string) => h("option",{value,text});
  workspace.append(option("","Choose workspace")); list.append(option("","Choose default list"));
  async function loadLists() {
    list.disabled = true; feedback.textContent = "Loading ClickUp lists…";
    try {
      const data = await Bridge.clickupSetup(workspace.value);
      clear(list); list.append(option("","Choose default list"));
      for (const item of data.lists) list.append(option(item.id,item.name));
      list.value = settings.clickupList;
      feedback.textContent = data.lists.length ? "Choose a default list. Every create, edit and delete requires your review." : "No accessible lists in this workspace.";
    } catch (err) { feedback.textContent = String(err); }
    finally { list.disabled = false; }
  }
  connect.onclick = async () => {
    connect.disabled = true;
    try {
      const data = await Bridge.clickupSetup();
      clear(workspace); workspace.append(option("","Choose workspace"));
      for (const item of data.workspaces) workspace.append(option(item.id,item.name));
      workspace.value = settings.clickupWorkspace;
      if (workspace.value) await loadLists();
      else feedback.textContent = "Choose your ClickUp workspace.";
    } catch (err) { feedback.textContent = String(err); }
    finally { connect.disabled = false; }
  };
  saveToken.onclick = async () => {
    if (!token.value.trim()) return;
    saveToken.disabled = true;
    try { await Bridge.secretSet("clickup-api-token",token.value.trim()); token.value=""; token.placeholder="Token saved securely"; connect.click(); }
    catch (err) { feedback.textContent=String(err); }
    finally { saveToken.disabled=false; }
  };
  remove.onclick = async () => {
    try { await Bridge.secretClear("clickup-api-token"); settings.clickupWorkspace=""; settings.clickupList=""; await save();
      clear(workspace);workspace.append(option("","Choose workspace"));clear(list);list.append(option("","Choose default list"));token.placeholder="ClickUp personal API token";feedback.textContent="Disconnected.";
    } catch (err) { feedback.textContent=String(err); }
  };
  workspace.onchange = async () => { settings.clickupWorkspace=workspace.value;settings.clickupList="";await save();if(workspace.value) await loadLists(); };
  list.onchange = () => { settings.clickupList=list.value;void save(); };
  void Bridge.secretPresent("clickup-api-token").then(present=>{if(present){token.placeholder="Token stored securely";connect.click();}});
  return h("section",{},h("h2",{text:"ClickUp"}),feedback,h("div",{class:"row"},token,saveToken,remove),
    h("div",{class:"row"},workspace,connect),h("div",{class:"row"},list));
}

// ── General section ───────────────────────────────────────────────────────────

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005", "aria-label":"Sound volume",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  const autoClose = h("input", {
    type: "number", min: "5", max: "120", step: "1", "aria-label":"Auto-close after seconds",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  const screen = h("select", {"aria-label":"Island display",disabled:floatingWindow}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: "Main display" }),
  );
  if(desktopPlatform==="windows")screen.append(h("option",{value:"cursor",text:"Display under the cursor"}));
  screen.value = desktopPlatform==="windows" ? settings.screen:"primary";
  screen.addEventListener("change", () => {
    settings.screen = screen.value as Settings["screen"];
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "General" })),
    h("div",{class:"row"},h("label",{text:"Reduced motion"}),toggle(settings.reducedMotion,v=>{settings.reducedMotion=v;void save();},"Reduced motion")),
    h("div", { class: "row" },
      h("label", { text: "Show integration pills" }),
      toggle(settings.showIntegrationPills, v => { settings.showIntegrationPills = v; void save(); },"Show integration pills"),
    ),
    h("div", { class: "row" },
      h("label", { text: "Sound" }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); },"Sound"),
      volume,
    ),
    h("div", { class: "row" },
      h("label", { text: "Auto-close" }),
      autoClose,
      h("span", { class: "hint", text: "seconds after you leave the island" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Island lives on" }),
      screen,
      floatingWindow ? h("span",{class:"hint",text:"Move the window to your preferred display."}):null,
    ),
    h("div", { class: "row" },
      h("label", { text: "Launch at startup" }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); },"Launch at startup"),
    ),
  );
}

function notificationsSection():HTMLElement {
  const quiet=h("select",{"aria-label":"Quiet mode"}) as HTMLSelectElement;
  const choices=[["off","Off"],["0","Until I turn it off"],["30","30 minutes"],["60","1 hour"],["120","2 hours"]];
  for(const [value,text]of choices)quiet.append(h("option",{value,text}));
  const remaining=(settings.quietUntil ?? 0)-Date.now();
  quiet.value=settings.quietUntil===0 ? "0" : remaining>0 ? String([30,60,120].find(m=>remaining<=m*60_000) ?? 120) : "off";
  quiet.onchange=()=>{settings.quietUntil=quiet.value==="off" ? null : quiet.value==="0" ? 0 : Date.now()+Number(quiet.value)*60_000;void save();};
  const section=h("section",{},h("h2",{text:"Notifications"}),
    h("div",{class:"row"},h("label",{text:"Quiet mode"}),quiet),
    h("div",{class:"hint",text:"Quiet mode keeps monitoring and saves updates in your inbox. No sounds or automatic opening. Permissions return to the terminal. Pause stops monitoring."}));
  for(const def of [...INTEGRATIONS,{id:"integration_clickup",name:"ClickUp"}]) {
    const select=h("select",{"aria-label":`${def.name} notifications`}) as HTMLSelectElement;
    for(const [value,text]of [["actionable","Actionable updates"],["all","All updates"],["off","Off"]])select.append(h("option",{value,text}));
    select.value=settings.notificationPreferences[def.id] ?? "actionable";
    select.onchange=()=>{settings.notificationPreferences={...settings.notificationPreferences,[def.id]:select.value as "actionable"|"all"|"off"};void save();};
    section.append(h("div",{class:"row"},h("label",{text:def.name}),select));
  }
  section.append(h("div",{class:"hint",text:"Inbox items are kept on this device for 30 days, up to 200 items. Dismissing a GitHub update only changes Coucou."}));
  return section;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
    credentialStore=boot.capabilities.credentialStore;
    floatingWindow=boot.capabilities.floatingWindow;
    desktopPlatform=boot.capabilities.platform;
  }
  const status = (await Bridge.hooksStatus()) ?? {
    installed: false, settingsPath: "", hookPath: "", hookReady: false,
  };

  const hasKey = (await Bridge.secretPresent("anthropic-api-key")) ?? false;

  const keys = [
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;

  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Coucou" }), h("span", { class: "version", text: version })),
    claudeSection(status),
    chatSection(),
    apiSection(hasKey),
    clickupSection(),
    integrationsSection(present),
    generalSection(),
    notificationsSection(),
    h("section",{},h("button",{class:"btn",text:"Quit Coucou",onclick:()=>void Bridge.quit()})),
    h("div", {
      class: "hint",
      text: "No telemetry. Network requests only go to the services you configure yourself.",
    }),
  );

  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, ...s };
  });
}

void main();
