import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
let registered;
const source=readFileSync(new URL('../client.js',import.meta.url),'utf8').replace('return {inject,apply};','return {inject,apply,activityRows,toolPresentation,workbenchStore,workbenchTab,workbenchConfig};');
const document={hidden:false,addEventListener(){},removeEventListener(){}};
const localStorage={getItem:()=>JSON.stringify({host:'workspace-host',vmTools:true,identity:'other-key'})};
vm.runInNewContext(source,{document,localStorage,setTimeout,clearTimeout,TextEncoder,btoa,window:{__ModuleLoader__:{load:value=>registered=value}}});
const api=registered.factory(()=>({createElement:(type,props)=>({type,props})}));
test('VM defaults apply only to new chats, including when a pre-VM binding omits vmTools',()=>{
 const workspace={workspaceId:'test'},old={host:'old-server',project:'saved',structuredChat:true};
 for(const route of [old,{...old,vmTools:false},{...old,vmTools:true}]){
  assert.equal(api.workbenchConfig({bound:true,route},workspace),route);
 }
 const fresh=api.workbenchConfig({bound:false,route:null},workspace);
 assert.equal(fresh.host,'workspace-host');assert.equal(fresh.vmTools,true);
});
test('DSH retains the workbench when switching tabs and its guide icon works offline',()=>{
 assert.equal(api.workbenchTab.keepMounted,true);
 const icon=api.workbenchTab.guide[0].icon({size:26});
 assert.equal(icon.type,'img');
 assert.match(icon.props.src,/^data:image\/svg\+xml,/);
 assert.equal(icon.props.width,26);
});
test('activity pairs concurrent results by call ID and preserves descriptions',()=>{
 const rows=api.activityRows([{id:'one',tool:'Bash',status:'started',detail:'First command',time:1},{id:'two',tool:'Bash',status:'started',detail:'Second command',time:2},{id:'two',tool:'Bash',status:'failed',time:5},{id:'one',tool:'Bash',status:'completed',time:6}]);
 assert.equal(rows.length,2);assert.equal(rows[0].status,'completed');assert.equal(rows[1].status,'failed');assert.equal(rows[1].detail,'Second command');assert.equal(rows[0].startedAt,1);
});
test('older activity logs collapse start/finish pairs without losing separate operations',()=>{
 const rows=api.activityRows(Array.from({length:6},(_,i)=>({tool:'mcp__dsh_local_vm__Bash',status:i%2?'completed':'started'})));
 assert.equal(rows.length,3);assert.ok(rows.every(row=>row.status==='completed'));
 assert.equal(api.toolPresentation(rows[0].tool).label,'执行命令');
 assert.equal(api.toolPresentation('mcp__dsh_local_vm__Read').label,'读取文件');
 assert.equal(api.toolPresentation('UnknownPluginTool').label,'运行工具');
});

test('visible panes share a pending read; hidden panes issue no reads',async()=>{
 const store=api.workbenchStore('one');assert.equal(store,api.workbenchStore('one'));
 let reads=0;const states=[];
 const client=()=>({visible:true,read:async()=>{reads++;return {activity:{status:'idle'},power:{state:'stopped'}}},notify:v=>states.push(v)});
 const a=client(),b=client(),offA=store.subscribe(a),offB=store.subscribe(b);
 try{
  await Promise.all([store.refresh(),store.refresh()]);assert.equal(reads,1);
  a.visible=false;b.visible=false;await store.refresh();assert.equal(reads,1);
  b.visible=true;await store.refresh();assert.equal(reads,2);assert.equal(states.at(-1).power.state,'stopped');
 }finally{offA();offB();}
});
