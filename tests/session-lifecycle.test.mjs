import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveRoute} from '../session-binding.mjs';
import {titleForRequest,installTitleRepair} from '../session-title.mjs';
import {stream} from '../index.js';

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
