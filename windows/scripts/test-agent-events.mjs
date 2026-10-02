// No DOM/test framework: exercise the real adapter, session state and approval flow.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const url = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
function module(file, imports = {}) {
  let code = ts.transpileModule(fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  for (const [name, target] of Object.entries(imports)) code = code.replaceAll(`"${name}"`, JSON.stringify(target));
  return url(code);
}
const stateUrl = module('core/state.ts');
const eventUrl = module('core/agent-events.ts');
const bridgeUrl = url(`export const calls = [];
  export const Bridge = {
    approvalAck: id => calls.push(["ack", id]),
    approvalDecline: id => calls.push(["decline", id]),
    startCodexMonitor: async () => {},
  };
  export const onEvent = async () => () => {};`);
const soundUrl = url('export const sounds = []; export const Sound = { play(name) { sounds.push(name); } };');
const hooksUrl = module('island/hooks.ts', {
  '../core/state': stateUrl, '../core/agent-events': eventUrl,
  '../core/bridge': bridgeUrl, '../core/sound': soundUrl,
});
const { State } = await import(stateUrl);
const { claudeEvent } = await import(eventUrl);
const { handleAgentEvent } = await import(hooksUrl);
const { calls } = await import(bridgeUrl);
const { sounds } = await import(soundUrl);
const timers = new Map();
let nextTimer = 0;
globalThis.window = {
  setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; },
  clearTimeout: id => timers.delete(id),
};
const alerts = [];
let reveals = 0;
const island = { alert: view => alerts.push(view), reveal() { reveals++; }, setView: view => alerts.push(view), dropPin() {} };
State.loadIntegrationTasks();
const originalIds = State.tasks.map(t => t.id);
const claude = (name, fields = {}) => {
  const event = claudeEvent({ hook_event_name: name, session_id: 'c1', cwd: 'C:/ClaudeProject', ...fields });
  assert.ok(event, name);
  handleAgentEvent(island, event);
  return event;
};
claude('SessionStart');
assert.equal(State.focusTask.name, 'ClaudeProject');
claude('UserPromptSubmit', { prompt: 'Keep all features' });
assert.equal(State.focusTask.state, 'thinking');
assert.equal(State.focusTask.steps.at(-1), 'Keep all features');
assert.equal(claude('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git status' } }).type, 'command');
assert.match(State.focusTask.steps.at(-1), /git status/);
assert.equal(claude('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'C:/file.ts' } }).type, 'file_edit');
claude('PostToolUse');
assert.equal(alerts.length, 0, 'routine Claude activity never opens a card');
assert.equal(reveals, 0, 'routine Claude activity never reveals the island');
assert.equal(sounds.length, 0, 'routine Claude activity is silent');
claude('PostToolUseFailure');
assert.equal(alerts.at(-1), 'error', 'recoverable tool errors still alert');
assert.equal(State.focusTask.state, 'working');
claude('SubagentStart');
assert.equal(State.focusTask.steps.at(-1), '+ subagent');
claude('SubagentStop');
assert.equal(State.focusTask.steps.at(-1), '• subagent done');
const routineAlerts = alerts.length;
claude('Notification', { message: 'Authentication successful' });
assert.equal(alerts.length, routineAlerts, 'informational notifications are quiet');
claude('Notification', { message: 'rate limit' });
assert.equal(alerts.at(-1), 'question');
assert.equal(State.focusTask.state, 'ratelimit');
claude('Notification', { notification_type: 'idle_prompt', message: 'Waiting for input' });
assert.equal(State.focusTask.state, 'question');
assert.equal(alerts.at(-1), 'question');
assert.equal(claude('PreToolUse', { tool_name: 'AskUserQuestion' }).type, 'waiting');
claude('PermissionRequest', { request_id: 'r1', tool_name: 'Write', tool_input: { file_path: 'C:/.env' } });
assert.equal(State.pendingApproval.command, 'Write · C:/.env');
assert.ok(calls.some(([kind, id]) => kind === 'ack' && id === 'r1'));
claude('PermissionRequest', { request_id: 'r2' });
assert.equal(State.pendingApproval.requestId, 'r1');
assert.ok(calls.some(([kind, id]) => kind === 'decline' && id === 'r2'));
State.paused = true;
claude('PermissionRequest', { request_id: 'r3' });
assert.ok(calls.some(([kind, id]) => kind === 'decline' && id === 'r3'));
State.paused = false;
State.pendingApproval = null;
claude('Stop', { message: 'Done' });
assert.equal(State.focusTask.state, 'finished');
claude('UserPromptSubmit', { prompt: 'Next turn' });
for (const callback of timers.values()) callback();
assert.equal(State.focusTask.state, 'thinking', 'a previous completion timer cannot idle new work');
claude('StopFailure');
assert.equal(State.focusTask.state, 'error');
claude('SessionEnd');
assert.equal(State.focusTask.name, 'VS Code');
assert.equal(State.focusTask.steps.length, 0);
assert.equal(claudeEvent({ hook_event_name: 'Unknown' }), null);

const codex = (type, fields = {}) => handleAgentEvent(island, {
  source: 'codex', type, session_id: 'x1', cwd: 'C:/CodexProject', ...fields,
});
const beforeCodex = [alerts.length, reveals, sounds.length];
codex('session_started');
assert.equal(State.focusId, 'integration_claude', 'Codex never steals focus');
const task = State.tasks.find(t => t.id === 'integration_codex');
assert.equal(task.name, 'CodexProject');
assert.equal(task.sessionId, 'x1');
assert.equal(task.state, 'thinking');
codex('command', { tool_name: 'Command', tool_input: { command: 'cargo test' } });
assert.equal(task.state, 'working');
assert.match(task.steps.at(-1), /cargo test/);
codex('file_edit', { tool_name: 'Edit', message: 'src/main.rs' });
assert.equal(task.steps.at(-1), 'src/main.rs');
assert.deepEqual([alerts.length, reveals, sounds.length], beforeCodex, 'Codex starts, commands and edits are quiet');
codex('approval_requested', { request_id: 'never-approve' });
assert.equal(State.pendingApproval, null);
codex('session_completed', { session_id: 'old-session' });
assert.equal(task.state, 'working', 'another session cannot finish the active pill');
codex('session_completed', { message: 'All done' });
assert.equal(task.pillBadge, 'finished');
assert.equal(reveals, beforeCodex[1] + 1, 'unfocused completion reveals its badge');
State.setFocus(task.id);
codex('session_completed');
assert.equal(alerts.at(-1), 'finished');
codex('session_started', { session_id: 'x2', cwd: 'C:/OtherProject' });
assert.equal(task.steps.length, 0, 'a different session gets a fresh ticker');
assert.equal(task.name, 'OtherProject');
assert.equal(task.sessionId, 'x2', 'open-chat target follows the displayed session');
for (const callback of timers.values()) callback();
assert.equal(task.state, 'thinking');
State.mode = 'expanded';
State.view = 'finished';
const resumedSounds = sounds.length;
codex('command', { session_id: 'x2', tool_name: 'Command' });
assert.equal(alerts.at(-1), 'overview', 'resumed work clears a stale completion card without opening a new one');
assert.equal(sounds.length, resumedSounds);
State.mode = 'hidden';
State.view = 'overview';
codex('waiting', { session_id: 'x2', message: 'Approval needed inside Codex' });
assert.equal(task.state, 'question');
assert.equal(alerts.at(-1), 'question');
assert.equal(State.pendingApproval, null, 'Codex waiting is observational');
State.paused = true;
const pausedAlerts = [alerts.length, reveals, sounds.length];
codex('waiting', { session_id: 'x2' });
assert.deepEqual([alerts.length, reveals, sounds.length], pausedAlerts, 'pause suppresses attention alerts too');
State.paused = false;
State.pendingApproval = { requestId: 'keep-card', sessionId: 'c1' };
const pinnedAlerts = alerts.length;
codex('waiting', { session_id: 'x2' });
assert.equal(alerts.length, pinnedAlerts, 'another attention event cannot replace a Claude decision card');
assert.equal(State.pendingApproval.requestId, 'keep-card');
State.pendingApproval = null;
codex('error', { session_id: 'x2', fatal: false, message: 'command failed' });
assert.equal(task.state, 'working');
assert.equal(alerts.at(-1), 'error');
codex('error', { session_id: 'x2', message: 'Turn interrupted' });
assert.equal(task.state, 'error');
State.loadIntegrationTasks();
for (const id of originalIds) assert.ok(State.tasks.some(t => t.id === id), `preserved ${id}`);
assert.ok(State.tasks.includes(task));
console.log('Claude + Codex normalization, approval fallback, independent state, completion timers and integrations passed.');

// A completion may be the first new record after startup skipped the history.
State.tasks = State.tasks.filter(t => t.source !== 'codex');
codex('session_completed', { message: 'Completed while starting Coucou' });
assert.equal(State.tasks.find(t => t.source === 'codex').state, 'finished');
