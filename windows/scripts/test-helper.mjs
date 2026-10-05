import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const url=code=>`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
function module(file,imports={}){
  let code=ts.transpileModule(fs.readFileSync(new URL(`../src/${file}`,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  for(const [name,target] of Object.entries(imports))code=code.replaceAll(`"${name}"`,JSON.stringify(target));
  return url(code);
}
const storage=new Map();globalThis.localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)};
let timer=0;globalThis.window={setTimeout:()=>++timer,clearTimeout:()=>{}};
const inboxUrl=module('core/inbox.ts');
const {restoreInbox,trimInbox,upsertInbox,quietActive,safeAction,INBOX_RETENTION}=await import(inboxUrl);
const now=Date.now();
const item=(i,fields={})=>({id:`item-${i}`,source:'integration_github',eventId:`event-${i}`,taskId:'integration_github',kind:'update',title:'Review requested',message:'Please review',time:now-i,read:false,...fields});
assert.equal(trimInbox(Array.from({length:210},(_,i)=>item(i))).length,200);
assert.equal(trimInbox([item(1,{time:now-INBOX_RETENTION-1}),item(2)]).length,1);
const legacy=item(1,{source:'codex',sessionId:'11111111-1111-1111-1111-111111111111',cwd:'C:/Project'});delete legacy.eventId;
const restored=restoreInbox([legacy,{bad:true}]);assert.equal(restored.length,1);assert.equal(restored[0].eventId,legacy.id);assert.equal(restored[0].action.kind,'session');
const original=item(1,{read:true});const repeated=upsertInbox([original],item(1));assert.equal(repeated.isNew,false);assert.equal(repeated.items[0].read,true);
const changed=upsertInbox(repeated.items,item(1,{message:'New request'}));assert.equal(changed.isNew,true);assert.equal(changed.items[0].read,false);
for(const address of ['javascript:alert(1)','file:///etc/passwd','https://user:password@example.com'])assert.equal(safeAction({kind:'url',url:address}),undefined);
assert.equal(safeAction({kind:'session',sessionId:'--execute-anything'}),undefined);
assert.equal(safeAction({kind:'folder',path:'--help'}),undefined);
assert.equal(safeAction({kind:'folder',path:'/home/user/project'}).path,'/home/user/project');
assert.equal(restoreInbox([item(1),item(1)]).length,1);
assert.equal(quietActive(null,now),false);assert.equal(quietActive(0,now),true);assert.equal(quietActive(now+1,now),true);assert.equal(quietActive(now,now),false);

const stateUrl=module('core/state.ts',{'./inbox':inboxUrl});const {State,DEFAULT_SETTINGS}=await import(stateUrl);
const bridgeUrl=url('export const calls=[];export const Bridge={approvalDecline:id=>calls.push(["decline",id]),saveSettings:async()=>{},secretStatus:async()=>({present:true,error:null}),chatStatus:async()=>({configured:true}),refreshIntegration:async()=>{}};export const onEvent=async()=>()=>{};');
const soundUrl=url('export const sounds=[];export const Sound={play:name=>sounds.push(name),idle:()=>{}};');
const hooksUrl=module('island/hooks.ts',{'../core/state':stateUrl,'../core/agent-events':module('core/agent-events.ts'),'../core/bridge':bridgeUrl,'../core/sound':soundUrl});
const integrationsUrl=module('island/integrations.ts',{'../core/state':stateUrl,'../core/bridge':bridgeUrl,'../core/sound':soundUrl});
const quietUrl=module('core/quiet.ts',{'./state':stateUrl,'./bridge':bridgeUrl,'./sound':soundUrl});
const {handleAgentEvent}=await import(hooksUrl);const {handleIntegration}=await import(integrationsUrl);const {setQuiet}=await import(quietUrl);
const {calls}=await import(bridgeUrl);const {sounds}=await import(soundUrl);
State.settings={...DEFAULT_SETTINGS,notificationPreferences:{},quietUntil:0};State.loadIntegrationTasks();
const island={opened:0,alert(){this.opened++;},reveal(){this.opened++;},dropPin(){},setView(){this.opened++;}};
handleAgentEvent(island,{source:'claudeCode',type:'approval_requested',request_id:'quiet-request',session_id:'session',cwd:'C:/Project',tool_name:'Write'});
assert.ok(calls.some(([kind,id])=>kind==='decline'&&id==='quiet-request'));assert.equal(State.pendingApproval,null);assert.equal(island.opened,0);assert.equal(sounds.length,0);assert.equal(State.recentAlerts[0].kind,'approval');
State.pendingApproval={requestId:'visible-request',sessionId:'session',tool:'Write',command:'Write file'};setQuiet(0);
assert.equal(State.pendingApproval,null);assert.ok(calls.some(([,id])=>id==='visible-request'));
const update={id:'integration_github',data:{notifications:[]},error:null,event:{success:true,label:'Please review',detail:'repo',eventId:'provider-1',category:'update',url:'https://github.com/example/project/pull/1'},lastSuccess:now};
handleIntegration(island,update);assert.ok(State.recentAlerts.some(a=>a.eventId==='provider-1'));assert.equal(island.opened,0);assert.equal(sounds.length,0);
const count=State.recentAlerts.length;handleIntegration(island,update);assert.equal(State.recentAlerts.length,count);
const alert=State.recentAlerts.find(a=>a.eventId==='provider-1');State.markAlertRead(alert.id);handleIntegration(island,update);assert.equal(State.recentAlerts.find(a=>a.id===alert.id).read,true);
State.dismissAlert(alert.id);handleIntegration(island,update);assert.equal(State.recentAlerts.some(a=>a.eventId==='provider-1'),false);
handleIntegration(island,{...update,event:null,error:'Network unavailable'});handleIntegration(island,{...update,event:null,error:'Network unavailable'});
assert.equal(State.recentAlerts.filter(a=>a.source==='integration_github'&&a.kind==='connection').length,1);
const connection=State.recentAlerts.find(a=>a.kind==='connection');State.dismissAlert(connection.id);handleIntegration(island,{...update,event:null,error:'Network unavailable'});assert.equal(State.recentAlerts.some(a=>a.kind==='connection'),false);
handleIntegration(island,{...update,event:null,error:null});await new Promise(resolve=>setTimeout(resolve,2));handleIntegration(island,{...update,event:null,error:'Network unavailable'});assert.equal(State.recentAlerts.filter(a=>a.kind==='connection').length,1,'a new outage is available after reconnection');
State.settings.notificationPreferences.integration_github='off';handleIntegration(island,{...update,event:{...update.event,eventId:'off-event'}});assert.equal(State.recentAlerts.some(a=>a.eventId==='off-event'),false);
State.settings.notificationPreferences.integration_github='all';State.settings.quietUntil=null;
const baselineTask=State.tasks.find(task=>task.id==='integration_github');baselineTask.state='idle';baselineTask.pillBadge=null;
const beforeBaselineOpen=island.opened;
handleIntegration(island,{...update,event:{...update.event,eventId:'silent-baseline',silent:true}});
assert.equal(baselineTask.state,'idle');assert.equal(baselineTask.pillBadge,null);assert.equal(island.opened,beforeBaselineOpen,'restored provider updates do not replay motion');
const opened=island.opened;handleIntegration(island,{...update,event:{...update.event,eventId:'routine',category:'finished'}});assert.equal(island.opened,opened,'successful routine updates stay subtle');assert.ok(State.recentAlerts.some(a=>a.eventId==='routine'));
State.persistSessions();const saved=JSON.parse(storage.get('coucou-sessions'));State.tasks=[];State.recentAlerts=[];State.restoreSessions();assert.equal(State.recentAlerts.length,saved.alerts.length);assert.equal(island.opened,opened,'restoration does not replay attention');
State.settings.quietUntil=now-1;assert.equal(State.quiet,false,'expired quiet mode stops suppressing updates');
State.paused=true;const pausedCount=State.recentAlerts.length;handleIntegration(island,{...update,event:{...update.event,eventId:'paused'}});assert.equal(State.recentAlerts.length,pausedCount);State.paused=false;

// Desktop alerts follow inbox deduplication and never replay restored history.
State.pendingDesktopNotifications=[];
State.settings={...State.settings,desktopNotifications:true,quietUntil:null,notificationPreferences:{}};
handleIntegration(island,{...update,event:{...update.event,eventId:'desktop-new'}});
assert.equal(State.pendingDesktopNotifications.length,1);
handleIntegration(island,{...update,event:{...update.event,eventId:'desktop-new'}});
assert.equal(State.pendingDesktopNotifications.length,1,'a repeated poll produces one native alert');
handleIntegration(island,{...update,event:{...update.event,eventId:'desktop-baseline',silent:true}});
assert.equal(State.pendingDesktopNotifications.length,1,'baseline provider events are silent');
State.settings.quietUntil=0;
handleIntegration(island,{...update,event:{...update.event,eventId:'desktop-quiet'}});
assert.equal(State.pendingDesktopNotifications.length,1,'quiet mode still records the inbox without a native alert');
State.settings.quietUntil=null;State.settings.desktopNotifications=false;
handleIntegration(island,{...update,event:{...update.event,eventId:'desktop-off'}});
assert.equal(State.pendingDesktopNotifications.length,1);
State.settings.desktopNotifications=true;
handleIntegration(island,{...update,event:{...update.event,eventId:'desktop-old',timestamp:now-120_000}});
assert.equal(State.pendingDesktopNotifications.length,1,'late history is not replayed as a desktop notification');
State.pendingDesktopNotifications=[];State.persistSessions();State.restoreSessions();
assert.equal(State.pendingDesktopNotifications.length,0);

// Closing a running pill hides it across activity and restart without stopping it.
const runningId='codex:11111111-1111-1111-1111-111111111111';
const runningEvent={source:'codex',session_id:'11111111-1111-1111-1111-111111111111',type:'session_started'};
handleAgentEvent(island,runningEvent);
const runningTask=State.tasks.find(t=>t.id===runningId);
State.focusId=runningId;State.dismissChat(runningId);
assert.equal(runningTask.state,'thinking');assert.equal(State.focusId,null);
assert.equal(State.visibleTasks.includes(runningTask),false);
handleAgentEvent(island,{...runningEvent,type:'command',message:'Working'});
assert.equal(State.visibleTasks.includes(runningTask),false,'background commands do not reopen closed active pills');
State.persistSessions();State.tasks=[];State.restoreSessions();
assert.ok(State.tasks.some(t=>t.id===runningId),'closed sessions are kept for restoring');
assert.equal(State.visibleTasks.some(t=>t.id===runningId),false);
State.restoreClosedPills();assert.ok(State.visibleTasks.some(t=>t.id===runningId));
State.loadIntegrationTasks();State.settings.showIntegrationPills=true;
State.integrations.integration_github={data:{},error:null,loaded:true,configured:true};
State.dismissChat('integration_github');
handleIntegration(island,{...update,event:null});
assert.equal(State.visibleTasks.some(t=>t.id==='integration_github'),false,'polls do not reopen service pills');
State.restoreClosedPills();assert.ok(State.visibleTasks.some(t=>t.id==='integration_github'));
State.dismissChat('integration_claude');
handleAgentEvent(island,{source:'claudeCode',type:'approval_requested',request_id:'closed-request',session_id:'closed-session',tool_name:'Write'});
assert.equal(State.pendingApproval,null);assert.ok(calls.some(([,id])=>id==='closed-request'));
State.restoreClosedPills();

// Clearing is persistent; old provider events stay dismissed and new ones arrive.
const clearedEvent=State.recentAlerts.find(a=>a.eventId==='desktop-new');assert.ok(clearedEvent);
State.clearInbox();assert.equal(State.recentAlerts.length,0);assert.equal(State.pendingDesktopNotifications.length,0);
State.restoreSessions();assert.equal(State.recentAlerts.length,0);
handleIntegration(island,{...update,event:{...update.event,eventId:'desktop-new'}});
assert.equal(State.recentAlerts.length,0,'Clear inbox suppresses repeats of dismissed alerts');
handleIntegration(island,{...update,event:{...update.event,eventId:'after-clear'}});
assert.equal(State.recentAlerts.length,1);assert.equal(State.pendingDesktopNotifications.length,1);

const {islandSize,EXPANDED_W}=await import(module('core/layout.ts'));
assert.deepEqual(islandSize('expanded','prompt',0,{height:1080,width:1920}),{w:EXPANDED_W*1.5,h:1080});
assert.deepEqual(islandSize('expanded','prompt',0,{height:720,width:800}),{w:800,h:720},'expanded chat fits smaller screens');
assert.deepEqual(islandSize('expanded','prompt',0),{w:640,h:240},'restore brings back normal chat dimensions');
assert.deepEqual(islandSize('expanded','overview',0,{height:1080,width:1920}),{w:640,h:160},'other sections keep their dimensions');
assert.deepEqual(islandSize('compact','prompt',0,{height:1080,width:1920}),{w:288,h:32});
assert.deepEqual(islandSize('hidden','prompt',0,{height:1080,width:1920}),{w:184,h:0});
globalThis.document={hidden:false};
const audioSources=[];
class FakeAudioContext{
  state='running';destination={};
  createGain(){return {gain:{value:0},connect(){}};}
  async decodeAudioData(){return {};}
  createBufferSource(){const source={connect(){},disconnect(){},start(){this.started=true;},stop(){this.stopped=true;}};audioSources.push(source);return source;}
  async resume(){this.state='running';}
  async suspend(){this.state='suspended';}
}
window.AudioContext=FakeAudioContext;
globalThis.fetch=async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(0)});
const {Sound:actualSound}=await import(module('core/sound.ts',{'./state':stateUrl}));
await actualSound.preload();State.settings.quietUntil=null;State.paused=false;State.mode='expanded';
actualSound.play('finish');assert.equal(audioSources[0].started,true);
State.settings.quietUntil=0;actualSound.idle();assert.equal(audioSources[0].stopped,true,'quiet mode stops an existing sound immediately');
actualSound.play('finish');assert.equal(audioSources.length,1,'quiet mode does not start another sound');
State.settings.quietUntil=null;actualSound.play('finish');actualSound.setEnabled(false);assert.equal(audioSources[1].stopped,true,'muting stops a playing sound');
console.log('Inbox migration, retention, clear/dismiss persistence, active pill closing/restoration, desktop alert suppression/deduplication, expanded chat sizing, permission fallback and immediate audio stopping passed.');
