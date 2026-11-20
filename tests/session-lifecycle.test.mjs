import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveRoute,bindRoute,storedRoute,routeFile} from '../session-binding.mjs';
import {beginSessionTurn,migrateBinding,serverTerminal} from '../session-migration.mjs';
import {desktopScope,atomicJson,readJson} from '../desktop-state.mjs';
import {mkdtemp,realpath,rm,readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {titleForRequest,installTitleRepair} from '../session-title.mjs';
import {stream} from '../index.js';
import {VMManager} from '../vm-manager.mjs';
import {POWER_VERSION} from '../vm-power.mjs';

const proposed={host:'example',project:'app',identity:'',localRoot:'C:/project',vmTools:false,structuredChat:false};
test('new chats always use VM; reconnect cannot change an established execution mode',()=>{
 const first=resolveRoute(null,proposed);assert.equal(first.vmTools,true);assert.equal(first.structuredChat,true);
 assert.equal(resolveRoute(first,{...proposed,vmTools:false}).vmTools,true);
 const legacy={...proposed,structuredChat:true,vmTools:false};
 assert.equal(resolveRoute(legacy,{...proposed,vmTools:true}).executionMode,'legacy-server');
 assert.throws(()=>resolveRoute(first,{...proposed,project:'different'}),/已绑定/);
});
test('DSH title plugin JSON is decoded without accepting environment messages',async()=>{
 const human='检查 CodeDrill 的测试与验证流程';
 const request={purpose:'session-title',messages:[
  {role:'user',source:{kind:'runtime-context'},content:[{type:'text',text:'PRIVATE_HOST_METADATA'}]},
  {role:'user',source:{kind:'dsh-session-title-llm'},content:[{type:'text',text:'Generate the session title from this JSON array of human messages:\n'+JSON.stringify([{seq:5,text:human}])}]}
 ]};
 assert.equal(titleForRequest(request),human);
 const chunks=[];for await(const chunk of stream(request))chunks.push(chunk);
 assert.equal(chunks.find(c=>c.type==='text-delta').text,human);
 assert.equal(titleForRequest({messages:[{role:'user',source:{kind:'dsh-session-title-llm'},content:[{type:'text',text:'Update the session title from this JSON object:\n'+JSON.stringify({currentTitle:'Claude 远程任务',messages:[{seq:5,text:human}]})}]}]}),human);
});
test('title repair refreshes only this plugin’s generated placeholder, never a manual name',async()=>{
 const sessions=[{id:'own'},{id:'manual'},{id:'other'}],calls=[];
 const ctx={on(){},sessions:{list:()=>sessions},sessionTitle:{get:s=>({title:'Claude 远程任务',source:{kind:s.id==='manual'?'user':'provider'}}),refresh:async s=>calls.push(s.id)}};
 installTitleRepair(ctx,async id=>id!=='other');await new Promise(setImmediate);
 assert.deepEqual(calls,['own']);
});

test('parallel bind requests all read the first complete persisted route',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const path=await import('node:path');
 const previous=process.env.LOCALAPPDATA,base=await mkdtemp(path.join(tmpdir(),'vm-duplicate-bind-'));
 process.env.LOCALAPPDATA=base;
 t.after(async()=>{if(previous===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=previous;await rm(base,{recursive:true,force:true});});
 const routes=await Promise.all(Array.from({length:12},()=>bindRoute('same-chat',proposed)));
 const saved=await storedRoute('same-chat');
 assert.ok(routes.every(route=>route.vmTools===saved.vmTools&&route.localRoot===saved.localRoot));
});

async function legacyChat(t,id,structuredChat=true){
 const base=await realpath(await mkdtemp(path.join(tmpdir(),'dsh-chat-fork-')));
 assert.equal(path.dirname(base),await realpath(tmpdir()));
 t.after(()=>rm(base,{recursive:true,force:true}));
 const route={host:'test',project:'proj',localRoot:base,structuredChat};
 const file=routeFile(id,base);
 await atomicJson(file,route);
 const cfg={sessionId:id,scope:desktopScope(id,'test','proj'),project:'proj',localRoot:base,cloud:{host:'test'}};
 return {base,route,cfg,file};
}
const proof={source:'0a55f079-5a35-46f4-85fc-46497ab604af',id:'15a60740-58cf-4c9c-b843-c2e20f99af72',messages:2};
test('one verified fork per DSH chat; a late legacy write cannot revert it',async t=>{
 const {cfg,base,file,route}=await legacyChat(t,'fork-chat');
 let connects=0,release,entered;
 const started=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
 const connect=async()=>{connects++;entered();await wait;return {forkHistory:async name=>{assert.equal(name,'dsh-native-'+cfg.scope);return proof}}};
 const first=migrateBinding(cfg,connect,base),duplicate=migrateBinding(cfg,connect,base);
 await started;
 assert.throws(()=>beginSessionTurn(cfg.sessionId),/正在切换/);
 const endOther=beginSessionTurn('another-chat');endOther();
 assert.deepEqual(await storedRoute(cfg.sessionId,base),route);
 release();const [a,b]=await Promise.all([first,duplicate]);
 assert.deepEqual(a,b);assert.equal(a.vmTools,true);assert.equal(a.historyFork.id,proof.id);assert.equal(connects,1);
 assert.deepEqual(await readJson(file),route);
 await atomicJson(file,{...route,desktopTools:true});
 assert.deepEqual(await storedRoute(cfg.sessionId,base),a);
 assert.deepEqual(await migrateBinding(cfg,connect,base),a);assert.equal(connects,1);
});
test('busy chat, failed verification and wrong project cannot redirect messages',async t=>{
 const {cfg,base,route}=await legacyChat(t,'recover-chat');
 const end=beginSessionTurn(cfg.sessionId);
 await assert.rejects(migrateBinding(cfg,()=>assert.fail(),base),/本轮结束/);end();
 let stopped=false;
 const fail=async()=>({forkHistory:async()=>({...proof,id:proof.source}),stop:async()=>{stopped=true}});
 await assert.rejects(migrateBinding(cfg,fail,base),/分叉确认/);assert.ok(stopped);
 await assert.rejects(migrateBinding({...cfg,scope:'0'.repeat(32)},()=>assert.fail(),base),/绑定/);
 assert.deepEqual(await storedRoute(cfg.sessionId,base),route);
 const done=await migrateBinding(cfg,async()=>({forkHistory:async()=>proof}),base);
 assert.equal(done.vmTools,true);
});
test('project-wide legacy tmux names must identify a single chat',async t=>{
 const {cfg,base,file,route}=await legacyChat(t,'shared-chat',false);
 // The earliest bindings stored only SSH options and project name.
 await atomicJson(file,{host:route.host,project:route.project,identity:''});
 await atomicJson(routeFile('other-chat',base),route);
 await assert.rejects(migrateBinding(cfg,()=>assert.fail(),base),/共用/);
 await atomicJson(routeFile('other-chat',base),{...route,structuredChat:true});
 const result=await migrateBinding(cfg,async()=>({forkHistory:async name=>{assert.equal(name,serverTerminal(route));return proof}}),base);
 assert.equal(result.structuredChat,true);
 assert.equal(result.localRoot,cfg.localRoot);
});
test('workbench RPC migrates via the backend and subsequent config reads the new binding',async t=>{
 const {cfg,base,file,route}=await legacyChat(t,'rpc-chat');
 // The VM intentionally refuses Windows AppData (which includes os.tmpdir()).
 const project=await realpath(await mkdtemp(path.join(process.cwd(),'vm-fork-test-')));
 assert.equal(path.dirname(project),await realpath(process.cwd()));t.after(()=>rm(project,{recursive:true,force:true}));
 await atomicJson(file,{...route,localRoot:project});
 const home=path.join(base,'DSH-Remote-Claude'),instanceId='12345678-1234-4234-8234-1234567890ab';
 const profile={guest:{host:'127.0.0.1',port:23001,user:'dshvm',instanceId,identity:path.join(base,'private','key'),knownHosts:path.join(base,'private','hosts')},vmStatePath:path.join(base,'vm.json'),hostPython:path.join(base,'python.exe')};
 await atomicJson(profile.vmStatePath,{instanceId,network:'isolated'});
 await atomicJson(path.join(home,'vm-executor.json'),profile);
 await atomicJson(path.join(home,'vm-manager.json'),{pid:process.pid,updatedAt:Date.now(),engine:'claude-mcp-v2',powerVersion:POWER_VERSION,historyFork:true,power:{state:'running'}});
 const manager=new VMManager(base);
 manager.ensureBridge=async(checked,req)=>{
  assert.equal(checked.scope,cfg.scope);assert.equal(req.explicitWake,true);assert.equal(req.migrate,true);
  return {forkHistory:async()=>proof};
 };
 async function rpc(action){
  const child=spawn(process.execPath,[fileURLToPath(new URL('../sync.mjs',import.meta.url))],{cwd:project,env:{...process.env,LOCALAPPDATA:base},windowsHide:true,signal:AbortSignal.timeout(8000)});
  let out='';child.stdout.on('data',buf=>out+=buf);
  child.stdin.end(JSON.stringify({action,sessionId:cfg.sessionId}));
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error(out)))});
  return JSON.parse(out).result;
 }
 const pending=rpc('session-migrate');
 async function inboxRequest(){
  const inbox=path.join(home,'connect-inbox');
  for(let i=0;i<100;i++){
   const names=await readdir(inbox).catch(()=>[]);
   const n=names.find(n=>/^[0-9a-f]{32}\.json$/.test(n));
   if(n)return readJson(path.join(inbox,n));await pause(30);
  }
  throw Error('Missing VM manager request');
 }
 const request=await Promise.race([inboxRequest(),pending.then(()=>assert.fail('Returned before migration receipt'))]);
 await manager.answerConnect(request);
 assert.equal((await pending).historyFork.id,proof.id);
 assert.equal((await rpc('session-config')).route.vmTools,true);
 assert.equal((await rpc('workbench-status')).route.historyFork.id,proof.id);
 assert.equal((await rpc('session-migrate')).historyFork.id,proof.id);
});
