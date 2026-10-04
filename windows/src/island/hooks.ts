// Normalized Claude Code and Codex events → existing island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { Island } from "./island";

import { claudeEvent, type AgentEvent, type ClaudeHookPayload } from "../core/agent-events";

let lastUpdate = 0;
const settleTimers = new Map<string, number>();

/** Clears the approval card if no decision was made before the hook gave up. */
let pendingTimeout: number | null = null;

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** frenchStep() — same labels as the macOS app. */
const TOOL_LABELS: Record<string, string> = {
  Bash: "Exécute",
  Read: "Lit",
  Write: "Écrit",
  Edit: "Modifie",
  Glob: "Cherche",
  Grep: "Recherche",
  WebSearch: "Recherche web",
  WebFetch: "Récupère",
  TodoWrite: "Tâches",
  Task: "Agent",
  LS: "Liste",
  MultiEdit: "Modifie",
  NotebookEdit: "Notebook",
  PowerShell: "Exécute",
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

function upsert(id: string, event: AgentEvent, projectName: string, cwd: string) {
  let t = State.tasks.find((x) => x.id === id);
  if (!t && event.source === "codex") {
    t = { id, name: "Codex", color: "#F5F6F8", source: "codex", isIntegration: true,
      state: "idle", steps: [], stepIndex: 0 };
    State.tasks.push(t);
  }
  if (!t) return;
  if (event.source === "codex" && event.session_id && t.sessionId !== event.session_id) {
    t.steps = [];
    t.stepIndex = 0;
    t.pillBadge = null;
  }
  if (event.session_id) t.sessionId = event.session_id;
  if (event.title) t.title = event.title;
  t.name = t.title || projectName;
  t.updatedAt = lastUpdate = Math.max(Date.now(), lastUpdate + 1);
  if (!["session_metadata","session_snapshot"].includes(event.type)) t.dismissed = false;
  if (cwd) t.sessionCwd = cwd;
}

function clearSession(id: string) {
  const t = State.tasks.find((x) => x.id === id);
  if (!t) return;
  t.steps = [];
  t.stepIndex = 0;
  t.name = t.source === "codex" ? "Codex" : "VS Code";
  t.sessionId = null;
  t.sessionCwd = null;
  t.pillBadge = null;
}

export async function registerHookHandlers(island: Island) {
  await onEvent<ClaudeHookPayload>("hook", (payload) => {
    const event = claudeEvent(payload);
    if (event) handleAgentEvent(island, event);
  });
  await onEvent<AgentEvent>("agent", (event) => handleAgentEvent(island, event));
  await Bridge.startCodexMonitor(State.tasks.filter(t => t.source === "codex").map(t => t.sessionId!).filter(Boolean));
}

export function handleAgentEvent(island: Island, payload: AgentEvent) {
  if (payload.source !== "claudeCode" && payload.source !== "codex") return;
  // Codex monitoring is observational; only the existing Claude relay can approve.
  if (payload.type === "approval_requested" && payload.source !== "claudeCode") return;
  if (payload.source === "codex" && !payload.session_id) return;
  const id = payload.source === "codex" ? `codex:${payload.session_id}` : "integration_claude";
  const current = State.tasks.find((t) => t.id === id);
  if (["session_completed", "session_ended", "error"].includes(payload.type)
      && payload.session_id && current?.sessionId && payload.session_id !== current.sessionId) return;
  if (payload.type === "session_metadata" || payload.type === "session_snapshot") {
    if (payload.internal_review) {
      State.tasks = State.tasks.filter(t => t.id !== id);
      if (State.focusId === id) State.focusId = null;
      State.persistSessions(); State.notify(); return;
    }
    if (!current) return;
    if (payload.title) {
      current.title = payload.title;
      current.name = payload.title;
      for (const a of State.recentAlerts) if (a.taskId === id) a.title = payload.title;
    }
    if (payload.cwd) current.sessionCwd = payload.cwd;
    if (payload.snapshot_state) {
      if (current.state !== payload.snapshot_state && ["finished", "idle"].includes(payload.snapshot_state))
        current.updatedAt = Date.now();
      current.state = payload.snapshot_state;
      current.pillBadge = ["thinking","working","idle"].includes(current.state) ? null : current.pillBadge;
    }
    State.persistSessions(); State.notify(); return;
  }
  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.type;
  if (["session_started", "activity", "command", "file_edit", "session_completed", "session_ended", "error", "approval_requested", "waiting"].includes(name)) {
    const settle = settleTimers.get(id);
    if (settle != null) {
      window.clearTimeout(settle);
      settleTimers.delete(id);
    }
  }
  const cwd = payload.cwd ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = aliasProjectName(raw || "Session");
  const focused = State.focusTask?.id === id;

  // Routine activity updates the ticker quietly. Only attention events surface.
  const attention = (view: Parameters<Island["alert"]>[0], badge: "approval" | "finished" | "error") => {
    State.recordAlert(id, badge, payload.message || State.tasks.find(t => t.id === id)?.steps.at(-1) || (badge === "finished" ? "Task finished" : "Needs attention"));
    if (State.pendingApproval || (State.mode === "expanded" && State.view === "clickup")) {
      if (id !== "integration_claude") State.setPillBadge(id, badge);
      return; // Keep the existing Claude decision card available until answered.
    }
    if (focused) {
      if (State.mode === "expanded") island.setView(view);
      else island.alert(view);
    } else {
      State.setPillBadge(id, badge);
      island.reveal();
    }
  };
  const resumeView = () => {
    if (focused && State.mode === "expanded" && !State.pendingApproval
        && ["finished", "error", "question"].includes(State.view)) island.setView(State.defaultView());
  };
  const waiting = (state: "question" | "ratelimit") => {
    const settle = settleTimers.get(id);
    if (settle != null) window.clearTimeout(settle);
    settleTimers.delete(id);
    upsert(id, payload, projectName, cwd);
    State.updateTask(id, state);
    State.appendStep(id, payload.message || "Waiting for your input in the agent app.");
    Sound.play(state === "ratelimit" ? "rate" : "approval");
    attention("question", "approval");
  };

  switch (name) {
    case "session_started":
      upsert(id, payload, projectName, cwd);
      if (payload.source === "codex") State.updateTask(id, "thinking");
      State.setPillBadge(id, null);
      resumeView();
      break;

    case "activity":
    case "command":
    case "file_edit": {
      upsert(id, payload, projectName, cwd);
      if (payload.state) State.updateTask(id, payload.state);
      else if (name !== "activity") State.updateTask(id, "working");
      State.setPillBadge(id, null);
      if (payload.message) State.appendStep(id, payload.message.slice(0, 60));
      else if (payload.tool_name) State.appendStep(id, stepLabel(payload.tool_name, payload.tool_input ?? {}));
      resumeView();
      break;
    }

    case "notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        waiting("ratelimit");
      } else if (message.endsWith("?")) {
        waiting("question");
      }
      break;
    }

    case "waiting":
      waiting("question");
      break;

    case "session_completed":
      upsert(id, payload, projectName, cwd);
      State.updateTask(id, "finished");
      if (payload.message) State.appendStep(id, payload.message.slice(0, 60));
      Sound.play("finish");
      attention("finished", "finished");
      if (payload.source !== "codex") settleTimers.set(id, window.setTimeout(() => {
        settleTimers.delete(id);
        State.updateTask(id, "idle");
        State.setPillBadge(id, null);
      }, 5200));
      break;

    case "error":
      upsert(id, payload, projectName, cwd);
      if (payload.fatal === false) {
        State.updateTask(id, "working");
        State.appendStep(id, payload.message || "⚠ failed");
        Sound.play("error");
        attention("error", "error");
        break;
      }
      if (payload.message) State.appendStep(id, payload.message.slice(0, 60));
      State.updateTask(id, "error");
      Sound.play("error");
      attention("error", "error");
      break;

    case "session_ended":
      State.updateTask(id, "idle");
      clearSession(id);
      break;

    case "approval_requested": {
      const requestId = payload.request_id ?? "";
      // One card, one request. A second one must never quietly replace the first
      // — that would leave a human staring at request B while request A waits for
      // a decision nobody can give. Hand it straight back to the terminal.
      if (State.pendingApproval && State.pendingApproval.requestId !== requestId) {
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }
      upsert(id, payload, projectName, cwd);
      if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      State.pendingApproval = {
        requestId,
        sessionId: payload.session_id ?? "",
        tool,
        command: approvalTarget(tool, input),
      };
      // The relay's short ack window closes in 800 ms; everything below this
      // line is synchronous, so the card really is up by the time it lands.
      if (requestId) void Bridge.approvalAck(requestId);
      State.updateTask(id, "approval");
      State.isPinned = true;
      Sound.play("approval");
      if (focused) {
        island.alert("approval");
      } else {
        // Another agent holds the view, so the card would yank it away. The badge
        // is the signal instead — but it has to be on screen for that to mean
        // anything, hence the reveal. We just told the relay a human can act.
        State.setPillBadge(id, "approval");
        island.reveal();
      }
      // Coucou answers within 108 s or not at all; after that the terminal has
      // taken over and the card would be lying.
      pendingTimeout = window.setTimeout(() => {
        pendingTimeout = null;
        if (!State.pendingApproval) return;
        State.pendingApproval = null;
        State.isPinned = false;
        island.dropPin();
        State.updateTask(id, "working");
        State.setPillBadge(id, null);
        if (State.view === "approval") island.setView(State.defaultView());
        State.notify();
      }, 110_000);
      break;
    }

    default:
      break;
  }
  State.persistSessions();
  State.notify();
}
