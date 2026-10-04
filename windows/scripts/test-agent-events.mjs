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
const saved = new Map();
globalThis.localStorage = {getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v)};
const inboxUrl = module('core/inbox.ts');
const stateUrl = module('core/state.ts', {'./inbox': inboxUrl});
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
State.settings.showIntegrationPills = true;
State.settings.hooksInstalled = true;
State.integrations.integration_claude={configured:true,loaded:true,data:{},error:null};
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
const task = State.tasks.find(t => t.id === 'codex:x1');
assert.equal(task.sessionId,'x1');
assert.equal(task.name,'CodexProject');
assert.equal(task.state,'thinking');
codex('session_metadata', {title:'Real chat title'});
codex('command',{tool_name:'Command',tool_input:{command:'cargo test'}});
assert.equal(task.name,'Real chat title','activity does not overwrite a real title');
assert.match(task.steps.at(-1),/cargo test/);
codex('file_edit',{message:'src/main.rs'});
codex('session_started',{session_id:'x2',cwd:'C:/OtherProject'});
const second=State.tasks.find(t=>t.id==='codex:x2');
assert.notEqual(second,task);
assert.equal(second.state,'thinking');
assert.equal(task.state,'working','interleaved chats remain independent');
assert.deepEqual([alerts.length,reveals,sounds.length],beforeCodex,'routine work and title updates stay quiet');
codex('approval_requested',{request_id:'never-approve'});
assert.equal(State.pendingApproval,null);
codex('session_completed',{message:'All done'});
assert.equal(task.state,'finished');
assert.equal(second.state,'thinking');
assert.equal(task.pillBadge,'finished');
assert.equal(State.recentAlerts[0].sessionId,'x1','history opens the correct chat');
const historyLength=State.recentAlerts.length;
State.setFocus(task.id);
State.mode='expanded';State.view='finished';
const resumedSounds=sounds.length;
codex('command',{tool_name:'Command'});
assert.equal(alerts.at(-1),'overview');
assert.equal(sounds.length,resumedSounds);
assert.equal(task.pillBadge,null);
assert.equal(State.recentAlerts.length,historyLength,'resuming keeps alert history');
codex('waiting',{message:'Approval needed inside Codex'});
assert.equal(task.state,'question');
assert.equal(State.pendingApproval,null);
State.pendingApproval={requestId:'keep-card',sessionId:'c1'};
const pinnedAlerts=alerts.length;
codex('waiting',{session_id:'x2'});
assert.equal(alerts.length,pinnedAlerts);
assert.equal(State.pendingApproval.requestId,'keep-card');
State.pendingApproval=null;
State.paused=true;
const paused=[alerts.length,reveals,sounds.length];
codex('error');
assert.deepEqual([alerts.length,reveals,sounds.length],paused);
State.paused=false;
codex('error',{session_id:'x2',message:'Turn interrupted'});
assert.equal(second.state,'error');
codex('session_completed',{message:'Completed'});
State.dismissChat(task.id);
assert.ok(!State.visibleTasks.includes(task));
assert.ok(State.recentAlerts.some(a=>a.sessionId==='x1'));
codex('session_started');
assert.ok(State.visibleTasks.includes(task),'new work restores a dismissed chat');
for(let i=0;i<8;i++)codex('session_completed',{session_id:'done'+i});
assert.equal(State.visibleTasks.filter(t=>t.source==='codex'&&t.state==='finished').length,5);
assert.ok(State.visibleTasks.includes(task));
assert.ok(State.visibleTasks.includes(second),'unresolved errors are never evicted');
State.settings.showIntegrationPills=false;
State.tasks.find(t=>t.id==='integration_claude').state='idle';
State.tasks.find(t=>t.id==='integration_claude').pillBadge=null;
State.tasks.find(t=>t.id==='integration_github').state='finished';
State.tasks.find(t=>t.id==='integration_github').pillBadge='finished';
assert.ok(!State.visibleTasks.some(t=>t.id==='integration_github'),'hidden service alerts never replace chat Mochis');
assert.ok(State.tasks.some(t=>t.id==='integration_github'),'legacy integration remains configured');
State.pendingApproval={requestId:'visible',sessionId:'c1'};
assert.ok(State.visibleTasks.some(t=>t.id==='integration_claude'),'Claude approvals remain visible');
State.pendingApproval=null;
const persistedAlerts=State.recentAlerts.length;
State.persistSessions();State.tasks=[];State.recentAlerts=[];
const quiet=[alerts.length,reveals,sounds.length];
State.restoreSessions();State.loadIntegrationTasks();
assert.equal(State.recentAlerts.length,persistedAlerts);
assert.deepEqual([alerts.length,reveals,sounds.length],quiet,'restore does not replay alerts');
codex('session_snapshot',{session_id:'x1',snapshot_state:'finished',title:'Updated title'});
assert.equal(State.tasks.find(t=>t.id==='codex:x1').name,'Updated title');
assert.deepEqual([alerts.length,reveals,sounds.length],quiet,'startup reconciliation stays quiet');
const dismissed=State.recentAlerts[0].id;State.dismissAlert(dismissed);
assert.ok(!JSON.parse(saved.get('coucou-sessions')).alerts.some(a=>a.id===dismissed));
State.settings.showIntegrationPills=true;State.loadIntegrationTasks();
const guardianAlerts = State.recentAlerts.length;
codex('session_started',{session_id:'guardian-review',title:'Guardian review'});
assert.ok(State.tasks.some(t=>t.id==='codex:guardian-review'));
codex('session_metadata',{session_id:'guardian-review',internal_review:true});
assert.ok(!State.tasks.some(t=>t.id==='codex:guardian-review'),'restored internal reviews are removed quietly');
assert.equal(State.recentAlerts.length,guardianAlerts);
for(const id of originalIds)assert.ok(State.tasks.some(t=>t.id===id),`preserved ${id}`);

// Expiry is based on each chat's last completed work, not selection or title updates.
const realNow = Date.now;
let now = realNow() + 10_000;
Date.now = () => now;
const expiryQuiet = () => [alerts.length, reveals, sounds.length];
codex('session_completed', {session_id:'expires', message:'Keep this in history'});
const expires = State.tasks.find(t=>t.id==='codex:expires');
State.setFocus(expires.id);
const completedAt = expires.updatedAt;
now += 60_000;
codex('session_completed', {session_id:'later'});
codex('waiting', {session_id:'waiting-forever'});
codex('error', {session_id:'error-forever'});
now = completedAt + 5*60*1000 - 1;
codex('session_metadata', {session_id:'expires', title:'New title'});
codex('session_snapshot', {session_id:'expires', snapshot_state:'finished'});
assert.equal(expires.updatedAt, completedAt, 'titles and unchanged snapshots do not extend expiry');
State.expireCompletedChats();
assert.ok(State.visibleTasks.includes(expires), 'visible until the full 5 minutes');
const beforeExpiry = expiryQuiet();
now++;
State.expireCompletedChats();
assert.ok(!State.visibleTasks.includes(expires), 'finished chat leaves the active list at 5 minutes');
assert.equal(State.focusId, null);
assert.equal(expires.pillBadge, null);
assert.ok(State.visibleTasks.some(t=>t.sessionId==='later'), 'each completion has its own clock');
assert.ok(State.recentAlerts.some(a=>a.sessionId==='expires'), 'expiry keeps history');
assert.deepEqual(expiryQuiet(), beforeExpiry, 'expiry does not alert');
codex('command', {session_id:'expires', message:'New work'});
assert.ok(State.visibleTasks.includes(expires), 'resumed work restores an expired chat');
State.persistSessions(); State.tasks=[]; State.recentAlerts=[];
now += 6*60*1000;
const beforeRestore = expiryQuiet();
State.restoreSessions(); State.loadIntegrationTasks();
assert.ok(!State.visibleTasks.some(t=>t.sessionId==='later'), 'restart clears old completions');
for (const id of ['expires','waiting-forever','error-forever'])
  assert.ok(State.visibleTasks.some(t=>t.sessionId===id), 'work, waiting and errors stay active');
assert.ok(State.recentAlerts.some(a=>a.sessionId==='later'));
assert.deepEqual(expiryQuiet(), beforeRestore, 'expiry on restart is quiet');
codex('session_snapshot', {session_id:'expires', snapshot_state:'finished'});
State.expireCompletedChats();
assert.ok(State.visibleTasks.some(t=>t.sessionId==='expires'), 'newly observed completion gets its own 5 minutes');
Date.now = realNow;

// The expanded panel can collapse, but idle time never hides its compact Mochi.
timers.clear();
const { IslandStateMachine } = await import(module('island/fsm.ts'));
const fsm = new IslandStateMachine();
const runTimers = () => { for(const [id, fn] of [...timers]) { timers.delete(id); fn(); } };
fsm.launch(); fsm.greetComplete(); runTimers();
assert.equal(fsm.state, 'petit', 'greeting still collapses');
fsm.mouseLeft(); runTimers();
assert.equal(fsm.state, 'petit', 'compact stays visible without interaction');
assert.equal(timers.size, 0, 'compact has no automatic hide timer');
fsm.click(); fsm.mouseLeft(); runTimers();
assert.equal(fsm.state, 'petit', 'expanded panel still auto-collapses');
fsm.pinned=true; fsm.forceHome(); fsm.mouseLeft(); runTimers();
assert.equal(fsm.state, 'home', 'pinned approvals stay expanded');
fsm.forceHidden(); runTimers();
assert.equal(fsm.state, 'hidden', 'explicit pause still hides');
fsm.reveal(); fsm.mouseLeft(); runTimers();
assert.equal(fsm.state, 'petit', 'resuming restores the persistent compact Mochi');

console.log('Claude compatibility, Codex chats, 5-minute expiry, persistent compact Mochi and quiet history passed.');
