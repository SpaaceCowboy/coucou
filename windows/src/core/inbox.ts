export type InboxCategory = "finished" | "error" | "approval" | "input" | "connection" | "update";
export type NotificationPreference = "actionable" | "all" | "off";
export type InboxAction =
  | { kind: "url"; url: string }
  | { kind: "session"; sessionId: string; cwd?: string }
  | { kind: "folder"; path: string }
  | { kind: "settings" }
  | { kind: "clickup" };

export interface InboxItem {
  id: string;
  eventId: string;
  taskId: string;
  source: string;
  kind: InboxCategory;
  title: string;
  message: string;
  time: number;
  read: boolean;
  resolved?: boolean;
  action?: InboxAction;
  sessionId?: string | null;
  cwd?: string | null;
}

const CATEGORIES = new Set(["finished", "error", "approval", "input", "connection", "update"]);
const absoluteFolder=(path:unknown):path is string=>typeof path==="string" && !path.includes("\0") && (/^\//.test(path) || /^[a-z]:[\\/]/i.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path));
export const INBOX_RETENTION = 30 * 24 * 60 * 60 * 1000;
export const INBOX_LIMIT = 200;
export function safeAction(value: unknown): InboxAction | undefined {
  if (!value || typeof value !== "object") return;
  const a = value as Record<string, unknown>;
  switch (a.kind) {
    case "url":
      if (typeof a.url !== "string") return;
      try { const u = new URL(a.url); if (["http:", "https:"].includes(u.protocol) && !u.username && !u.password) return {kind:"url",url:u.href}; } catch { /* Invalid target. */ }
      return;
    case "session":
      if (typeof a.sessionId === "string" && /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(a.sessionId))
        return {kind:"session",sessionId:a.sessionId,...(absoluteFolder(a.cwd) ? {cwd:a.cwd} : {})};
      return;
    case "folder": if (absoluteFolder(a.path)) return {kind:"folder",path:a.path}; return;
    case "settings": return {kind:"settings"};
    case "clickup": return {kind:"clickup"};
  }
}

/** Validate both the new inbox and legacy Recent alerts without replaying events. */
export function restoreInbox(value: unknown, now = Date.now()): InboxItem[] {
  if (!Array.isArray(value)) return [];
  const items: InboxItem[] = [];
  for (const a of value) {
    if (!a || typeof a !== "object" || typeof a.id !== "string" || typeof a.taskId !== "string"
      || typeof a.title !== "string" || typeof a.message !== "string" || !Number.isFinite(a.time)
      || !CATEGORIES.has(a.kind)) continue;
    const legacyAction = a.source === "codex" ? {kind:"session",sessionId:a.sessionId,cwd:a.cwd}
      : a.source === "clickup" ? {kind:"clickup"} : a.cwd ? {kind:"folder",path:a.cwd} : undefined;
    items.push({...a, eventId:typeof a.eventId === "string" ? a.eventId : a.id,
      source:typeof a.source === "string" ? a.source : "Coucou",read:a.read === true,
      title:a.title.slice(0,200),message:a.message.slice(0,500),action:safeAction(a.action ?? legacyAction)});
  }
  const seen=new Set<string>();
  return trimInbox(items,now).filter(item=>{const key=JSON.stringify([item.source,item.eventId]);if(seen.has(key))return false;seen.add(key);return true;});
}

export function trimInbox(items: InboxItem[], now = Date.now()): InboxItem[] {
  return items.filter(a => a.time >= now - INBOX_RETENTION && a.time <= now + 60_000)
    .sort((a,b) => b.time - a.time).slice(0,INBOX_LIMIT);
}

export function upsertInbox(items: InboxItem[], item: InboxItem): {items:InboxItem[]; isNew:boolean} {
  const previous = items.find(a => a.source === item.source && a.eventId === item.eventId);
  // A dismissed/read event must not become unread again on every poll.
  if (previous) {
    const changed = previous.message !== item.message;
    Object.assign(previous, item, {id:previous.id,read:changed ? false : previous.read,time:changed ? item.time : previous.time});
    return {items:trimInbox(items),isNew:changed};
  }
  return {items:trimInbox([item,...items]),isNew:true};
}

export function relativeTime(time: number, now = Date.now()): string {
  const mins = Math.max(0,Math.floor((now-time)/60_000));
  return mins === 0 ? "Just now" : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.floor(mins/60)}h ago` : `${Math.floor(mins/1440)}d ago`;
}

export function quietActive(until: number | null, now = Date.now()): boolean {
  return until === 0 || (typeof until === "number" && until > now);
}
