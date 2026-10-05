// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import { Island } from "./island/island";
import { registerHookHandlers } from "./island/hooks";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";
import { releaseQuietApproval,releasePendingApproval } from "./core/quiet";

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
    State.capabilities = boot.capabilities;
    State.chatScreenHeight=boot.screen.height;
    State.chatScreenWidth=boot.screen.width;
    document.body.classList.toggle("floating-window",boot.capabilities.floatingWindow);
  }
  island.applySettings();
  State.subscribe(()=>{
    const alerts=State.pendingDesktopNotifications.splice(0);
    for(const alert of alerts) void Bridge.desktopNotify({source:alert.source,title:alert.title,message:alert.message});
  });
  State.restoreSessions();
  State.loadIntegrationTasks();
  let maintenance:number|undefined;
  const scheduleMaintenance=()=>{
    if(maintenance!==undefined) window.clearTimeout(maintenance);
    const now=Date.now();
    const deadlines=State.tasks.filter(t=>t.source==="codex" && !t.dismissed && ["idle","finished"].includes(t.state) && !["approval","error"].includes(t.pillBadge ?? ""))
      .map(t=>(t.updatedAt ?? now)+5*60_000);
    if(State.settings.quietUntil && State.settings.quietUntil>now) deadlines.push(State.settings.quietUntil);
    if(State.recentAlerts.length) deadlines.push(Math.min(...State.recentAlerts.map(a=>a.time))+30*86400_000+1);
    if(!deadlines.length)return;
    maintenance=window.setTimeout(()=>{
    const focused = State.focusTask?.id;
    if(State.settings.quietUntil && State.settings.quietUntil<=Date.now()) {
      State.settings.quietUntil=null;void Bridge.saveSettings(State.settings);
    }
    State.expireCompletedChats();
    State.persistSessions();State.notify();
    if (focused !== State.focusTask?.id && State.view === "finished" && !State.pendingApproval)
      island.setView(State.defaultView());
    scheduleMaintenance();
    },Math.max(50,Math.min(2_147_483_647,Math.min(...deadlines)-now)));
  };
  State.subscribe(scheduleMaintenance);
  scheduleMaintenance();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    if(on)releasePendingApproval("Paused");
    void Bridge.setPaused(on);
  };

  await onEvent<string>("tray", (what) => {
    switch (what) {
      case "settings":
        island.alert("settings");
        break;
      case "open":
        island.alert(State.defaultView());
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
      case "hide":
        releasePendingApproval("Window closed");island.dropPin();
        island.fsm.forceHidden();
        break;
    }
  });

  await onEvent<null>("screen-changed", () => void Bridge.reposition().then(screen=>{
    if(screen){State.chatScreenHeight=screen.height-(State.capabilities.floatingWindow ? 24:0);State.chatScreenWidth=screen.width-(State.capabilities.floatingWindow ? 16:80);State.notify();}
  }));

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    if(s.chatProvider!==State.settings.chatProvider){State.chatError=null;State.chatLastSuccess=null;}
    State.settings = { ...State.settings, ...s };
    releaseQuietApproval();
    if(State.quiet) island.dropPin();
    island.applySettings();
    State.loadIntegrationTasks();
    void refreshConfigured();
  });

  await registerHookHandlers(island);
  registerIntegrationHandlers(island);

  const preview=import.meta.env.DEV && !IS_TAURI ? (await import("./dev-preview")).preview(island):false;
  if(!preview){if(boot?.showRequested)island.alert(State.defaultView());else island.launch();}

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
