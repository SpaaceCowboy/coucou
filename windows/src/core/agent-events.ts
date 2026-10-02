// Adapters feed these events into the existing island session UI.
export type SessionSource = "claudeCode" | "codex";
export type AgentEventType =
  | "session_started" | "activity" | "command" | "file_edit"
  | "approval_requested" | "session_completed" | "session_ended"
  | "notification" | "waiting" | "error" | "session_metadata" | "session_snapshot";

export interface AgentEvent {
  source: SessionSource;
  type: AgentEventType;
  session_id?: string;
  cwd?: string;
  title?: string;
  snapshot_state?: "idle" | "thinking" | "working" | "question" | "error" | "finished";
  message?: string;
  state?: "thinking" | "working";
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  request_id?: string;
  /** Tool failures keep the session running; fatal failures show the error view. */
  fatal?: boolean;
}

export interface ClaudeHookPayload {
  hook_event_name?: string;
  notification_type?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

export function claudeEvent(payload: ClaudeHookPayload): AgentEvent | null {
  const base = { ...payload, source: "claudeCode" as const };
  switch (payload.hook_event_name) {
    case "SessionStart": return { ...base, type: "session_started" };
    case "UserPromptSubmit":
      return { ...base, type: "activity", state: "thinking", message: payload.prompt ?? payload.message };
    case "PreToolUse": {
      const tool = payload.tool_name ?? "";
      if (tool === "AskUserQuestion") return { ...base, type: "waiting", message: "Waiting for your answer in Claude Code." };
      const type = ["Bash", "PowerShell"].includes(tool) ? "command"
        : ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool) ? "file_edit" : "activity";
      return { ...base, type, state: "working", tool_name: payload.tool_name ?? "Tool" };
    }
    case "PostToolUse": return { ...base, type: "activity", state: "working", tool_name: undefined };
    case "PostToolUseFailure": return { ...base, type: "error", fatal: false, message: "⚠ failed" };
    case "Notification": return { ...base, type: ["idle_prompt", "permission_prompt"].includes(payload.notification_type ?? "") ? "waiting" : "notification" };
    case "Stop": return { ...base, type: "session_completed" };
    case "StopFailure": return { ...base, type: "error", fatal: true };
    case "SessionEnd": return { ...base, type: "session_ended" };
    case "SubagentStart": return { ...base, type: "activity", tool_name: undefined, message: "+ subagent" };
    case "SubagentStop": return { ...base, type: "activity", tool_name: undefined, message: "• subagent done" };
    case "PermissionRequest": return { ...base, type: "approval_requested" };
    default: return null;
  }
}

export const sessionSourceLabel = (source?: string): string =>
  source === "codex" ? "Codex" : source === "n8n" ? "n8n" : "Claude Code";
