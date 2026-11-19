import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {StructuredEvents} from '../structured-events.mjs';
import {selectManualTurn,manualTurnIdentity,preparePrompt} from '../structured-chat.mjs';

const event=value=>({type:'claude_event',event:value});
test('separate native transcript blocks are all forwarded without truncation',()=>{
 const t=new StructuredEvents();const chunks=[];
 for(const [id,text] of [['block-a','First paragraph.'],['block-b','Final paragraph.']])
  chunks.push(...t.consume(event({type:'assistant',message:{id,content:[{type:'text',text}]}})));
 chunks.push(...t.consume(event({type:'result',is_error:false})));
 assert.equal(chunks.filter(item=>item.type==='text-delta').map(item=>item.text).join(''),'First paragraph.Final paragraph.');
 assert.ok(t.final);
});
test('partial text and final assistant records are not duplicated',()=>{
 const t=new StructuredEvents();const chunks=[];
 for(const part of [
  {type:'stream_event',event:{type:'message_start',message:{id:'message'}}},
  {type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}},
  {type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Hello'}}},
  {type:'stream_event',event:{type:'content_block_stop',index:0}},
  {type:'assistant',message:{id:'message',content:[{type:'text',text:'Hello'}]}},
  {type:'result',result:'Hello',is_error:false},
 ])chunks.push(...t.consume(event(part)));
 assert.equal(chunks.filter(chunk=>chunk.type==='text-delta').map(chunk=>chunk.text).join(''),'Hello');
 assert.ok(t.final);assert.equal(chunks.filter(chunk=>chunk.type==='block-start').length,1);
});
test('thinking end does not complete the turn and missing final body is recovered',()=>{
 const t=new StructuredEvents();t.consume(event({type:'assistant',message:{id:'a',stop_reason:'end_turn',content:[{type:'thinking',thinking:'private internal text'}]}}));
 assert.equal(t.final,null);
 const chunks=t.consume(event({type:'result',result:'Final body',is_error:false}));
 assert.equal(chunks.find(chunk=>chunk.type==='text-delta').text,'Final body');
 assert.ok(!JSON.stringify(chunks).includes('private internal'));
});
test('tool activity is displayed but not emitted as executable DSH tool calls',()=>{
 const t=new StructuredEvents();
 const a=t.consume(event({type:'assistant',message:{content:[{type:'tool_use',id:'x',name:'Write',input:{file_path:'result.txt'}}]}}));
 const b=t.consume(event({type:'user',message:{content:[{type:'tool_result',tool_use_id:'x',content:'ok'}]}}));
 assert.ok(a.some(chunk=>chunk.type==='reasoning-delta'&&chunk.text.includes('Write')));
 assert.ok(b.some(chunk=>chunk.type==='reasoning-delta'&&chunk.text.includes('已完成')));
 assert.ok(![...a,...b].some(chunk=>chunk.type==='tool-call'));
});
test('privacy metadata and previous turns are excluded from outgoing message selection',()=>{
 const selected=selectManualTurn([{role:'system',content:[]},{role:'assistant',content:[]},
  {role:'user',source:{kind:'runtime-context'},content:[{type:'text',text:'IP locale timezone'}]},
  {role:'user',source:{kind:'user',rpcId:'new',clientTimeZone:'test'},content:[{type:'text',text:'task'}]}]);
 assert.equal(selected.source.rpcId,'new');assert.equal(selected.content[0].text,'task');
});
test('failed prior attempts do not block or replay with the newest manual message',()=>{
 const old={role:'user',source:{kind:'user',rpcId:'failed-old'},content:[{type:'text',text:'old task'}]};
 const latest={role:'user',source:{kind:'user',rpcId:'newest'},content:[{type:'text',text:'new task'}]};
 const selected=selectManualTurn([{role:'assistant',content:[]},old,latest,
  {role:'user',source:{kind:'runtime-context'},content:[{type:'text',text:'private environment'}]},
  {role:'user',source:{kind:'time-context'},content:[{type:'text',text:'private timezone'}]}]);
 assert.equal(selected,latest);assert.equal(manualTurnIdentity(selected),'newest');
});
test('stable message ID supports manual messages without an RPC ID',()=>{
 const message={id:'stable-id',role:'user',source:{kind:'user'},content:[{type:'text',text:'task'}]};
 assert.equal(manualTurnIdentity(selectManualTurn([message])),'message:stable-id');
 assert.equal(manualTurnIdentity(structuredClone(message)),manualTurnIdentity(message));
});
test('an invalid latest message never falls back to replaying an earlier valid one',()=>{
 assert.throws(()=>selectManualTurn([
  {role:'user',source:{kind:'user',rpcId:'old'},content:[]},
  {role:'user',source:{kind:'user'},content:[]},
 ]),/稳定标识/);
 assert.throws(()=>selectManualTurn([{role:'user',source:{kind:'runtime-context'},content:[]}]),/手动消息/);
});
test('DSH file handle is verified and rewritten to a remote project path',async()=>{
 const data=Buffer.from('attachment fixture');const digest=createHash('sha256').update(data).digest('hex');
 const name='report.txt';const local=path.resolve('work/store/files',digest,name);
 const handle=`[File ${JSON.stringify(name)} (${data.length} bytes, sha256:${digest.slice(0,8)}): verbatim read-only copy saved at ${JSON.stringify(local)}. Read that path with your file tools.]`;
 const host={attachments:{fileHostPath:()=>local,async *readFileStream(){yield data;}}};
 const prompt=await preparePrompt({content:[{type:'text',text:handle}]},host,async(n,b)=>{assert.equal(n,name);assert.deepEqual(b,data);return '.dsh-attachments/verified/report.txt';});
 assert.equal(prompt.count,1);assert.ok(prompt.text.includes('.dsh-attachments/verified/report.txt'));assert.ok(!prompt.text.includes(local));
 await assert.rejects(preparePrompt({content:[{type:'text',text:handle}]},{attachments:{...host.attachments,fileHostPath:()=>path.resolve('other')}},async()=>''));
});
test('image-only message uploads bytes and emits a remote reference',async()=>{
 const result=await preparePrompt({content:[{type:'image',attachment:{mediaType:'image/png',name:'picture'}}]},
  {attachments:{readImage:async()=>({data:new Uint8Array([1,2,3])})}},async(name,data)=>{assert.equal(name,'picture.png');return '.dsh-attachments/hash/'+name;});
 assert.equal(result.count,1);assert.ok(result.text.includes('picture.png'));
});
