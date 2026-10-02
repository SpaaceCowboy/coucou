// App state — mirror of AppState.swift (the parts the island needs).

import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import type { EyeShape } from "../mochi/engine";

export type AgentSource = "claudeCode" | "codex" | "n8n" | "clickup";
export type PillBadge = "approval" | "finished" | "error";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
  sessionId?: string | null;
  title?: string;
  updatedAt?: number;
  dismissed?: boolean;
}

export interface RecentAlert {
  id: string; taskId: string; sessionId?: string | null; cwd?: string | null;
  source: AgentSource; kind: "finished" | "error" | "approval";
  title: string; message: string; time: number;
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  tool: string;
  command: string;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

export type PromptContext =
  | { kind: "window"; appName: string; title: string; url?: string }
  | { kind: "file"; name: string; path?: string };

export interface ResultItem {
  label: string;
  detail: string;
  url?: string;
}

export interface SearchResult {
  title: string;
  items: ResultItem[];
  note?: string;
}

const task = (
  id: string, name: string, color: string, source: AgentSource,
): AgentTask => ({
  id, name, color, state: "idle", stepIndex: 0, steps: [], source, isIntegration: true,
});

/** AgentTask.integrationAgents — same ids, names and colours as macOS. */
export const INTEGRATION_AGENTS: AgentTask[] = [
  task("integration_claude", "VS Code", "#F5F6F8", "claudeCode"),
  task("integration_resend", "Resend", "#22C55E", "n8n"),
  task("integration_n8n", "n8n", "#F29B38", "n8n"),
  task("integration_vercel", "Vercel", "#7C5CFF", "n8n"),
  task("integration_github", "GitHub", "#F4505E", "n8n"),
  task("integration_notion", "Notion", "#8C8C8C", "n8n"),
  task("integration_calcom", "Cal.com", "#C9956A", "n8n"),
  task("integration_stripe", "Stripe", "#0570DE", "n8n"),
];

export const TOGGLEABLE_INTEGRATION_IDS = [
  "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  "integration_notion", "integration_calcom", "integration_stripe",
];

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  absenceInterval: number;
  activeIntegrations: string[];
  screen: "primary" | "cursor";
  autostart: boolean;
  hooksInstalled: boolean;
  /** Claude model used by the chat. */
  model: string;
  showIntegrationPills: boolean;
  clickupWorkspace: string;
  clickupList: string;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  absenceInterval: 180,
  activeIntegrations: [
    "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  ],
  screen: "primary",
  autostart: false,
  hooksInstalled: false,
  model: "claude-opus-5",
  showIntegrationPills: false,
  clickupWorkspace: "",
  clickupList: "",
};

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;
  recentAlerts: RecentAlert[] = [];
  historyStorageError = "";

  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

  uploadProgress = 0;
  uploadDuration = 2.4;
  fileDragOver = false;

  promptContext: PromptContext | null = null;
  droppedFile: { name: string; path: string } | null = null;
  noteMessage: string | null = null;
  searchResult: SearchResult | null = null;
  chatHistory: ChatMessage[] = [];
  pendingApproval: ApprovalInfo | null = null;

  integrations: Record<string, IntegrationInfo> = {};

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get focusTask(): AgentTask | null {
    return this.visibleTasks.find((t) => t.id === this.focusId) ?? this.visibleTasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusTask?.state ?? "idle";
  }

  get visibleTasks(): AgentTask[] {
    const chats = this.tasks.filter(t => t.source === "codex" && !t.dismissed)
      .sort((a,b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const finished = chats.filter(t => t.state === "finished" || t.state === "idle").slice(0,5);
    return this.tasks.filter(t => t.source === "clickup"
      || (t.source === "codex" ? !t.dismissed && (finished.includes(t) || !["finished","idle"].includes(t.state))
        : this.settings.showIntegrationPills || (t.source === "claudeCode" && (t.state !== "idle" || !!t.pillBadge || !!this.pendingApproval))))
      .sort((a,b) => Number(!!b.pillBadge && b.pillBadge !== "finished") - Number(!!a.pillBadge && a.pillBadge !== "finished")
        || Number(b.source === "codex") - Number(a.source === "codex") || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  get otherTasks(): AgentTask[] {
    return this.visibleTasks.filter(t => t.id !== this.focusTask?.id);
  }

  persistSessions() {
    try {
      localStorage.setItem("coucou-sessions", JSON.stringify({
        tasks: this.visibleTasks.filter(t => t.source === "codex").map(t => ({...t, steps:t.steps.slice(-1),stepIndex:0})), alerts: this.recentAlerts,
      }));
      this.historyStorageError = "";
    } catch (err) { this.historyStorageError = "Recent history could not be saved. Free up local storage or dismiss older alerts."; console.error("Could not save recent chats/alerts", err); }
  }

  restoreSessions() {
    try {
      const saved = JSON.parse(localStorage.getItem("coucou-sessions") ?? "{}");
      if (Array.isArray(saved.tasks)) this.tasks.push(...saved.tasks.filter((t: AgentTask) =>
        t.source === "codex" && typeof t.sessionId === "string" && t.id === 'codex:' + t.sessionId
        && typeof t.name === "string" && Array.isArray(t.steps)
        && ["idle","thinking","working","question","ratelimit","error","finished"].includes(t.state)));
      if (Array.isArray(saved.alerts)) this.recentAlerts = saved.alerts.filter((a: RecentAlert) =>
        typeof a.id === "string" && typeof a.taskId === "string" && typeof a.title === "string"
        && typeof a.message === "string" && typeof a.time === "number" && ["finished","error","approval"].includes(a.kind));
    } catch (err) { console.error("Could not restore recent chats/alerts", err); }
  }

  recordAlert(id: string, kind: RecentAlert["kind"], message: string) {
    const t = this.tasks.find(t => t.id === id);
    if (!t) return;
    const last = this.recentAlerts[0];
    if (last?.taskId === id && last.kind === kind && last.message === message && Date.now() - last.time < 2000) return;
    const time = Date.now();
    this.recentAlerts.unshift({ id: time + ':' + Math.random().toString(36).slice(2), taskId: id,
      sessionId: t.sessionId, cwd: t.sessionCwd, source: t.source, kind, title: t.name, message: message.slice(0,500), time });
    this.persistSessions();
  }

  dismissAlert(id: string) {
    this.recentAlerts = this.recentAlerts.filter(a => a.id !== id);
    this.persistSessions(); this.notify();
  }

  dismissChat(id: string) {
    const t = this.tasks.find(t => t.id === id);
    if (!t || t.source !== "codex" || !["finished","idle"].includes(t.state)) return;
    t.dismissed = true;
    if (this.focusId === id) this.focusId = null;
    this.persistSessions(); this.notify();
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    t.pillBadge = null;
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.steps.push(step);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  /** loadIntegrationTasks() — VS Code always on, the rest opt-in (max 4). */
  loadIntegrationTasks() {
    for (const proto of INTEGRATION_AGENTS) {
      const shouldLoad =
        proto.id === "integration_claude" || this.settings.activeIntegrations.includes(proto.id);
      const idx = this.tasks.findIndex((t) => t.id === proto.id);
      if (shouldLoad && idx < 0) this.tasks.push({ ...proto, steps: [] });
      if (!shouldLoad && idx >= 0) this.tasks.splice(idx, 1);
    }
    // Keep the declared order so pills never shuffle.
    const order = INTEGRATION_AGENTS.map((t) => t.id);
    this.tasks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    if (!this.tasks.some(t => t.id === "integration_clickup"))
      this.tasks.push(task("integration_clickup", "ClickUp", "#AF78FF", "clickup"));
    if (!this.visibleTasks.some(t => t.id === this.focusId)) this.focusId = this.visibleTasks[0]?.id ?? null;
    this.notify();
  }

  toggleIntegration(id: string) {
    if (id === "integration_claude") return;
    const active = this.settings.activeIntegrations;
    if (active.includes(id)) {
      this.settings.activeIntegrations = active.filter((x) => x !== id);
      if (this.focusId === id) this.focusId = "integration_claude";
    } else {
      if (active.length >= 4) return;
      this.settings.activeIntegrations = [...active, id];
    }
    this.loadIntegrationTasks();
  }

  defaultView(): IslandViewName {
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
