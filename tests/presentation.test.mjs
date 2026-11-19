import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
let registered;
const source=readFileSync(new URL('../client.js',import.meta.url),'utf8').replace('return {inject,apply};','return {inject,apply,activityRows,toolPresentation};');
vm.runInNewContext(source,{TextEncoder,btoa,window:{__ModuleLoader__:{load:value=>registered=value}}});
const api=registered.factory(()=>({createElement(){}}));
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
