import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createConnection} from 'node:net';
import {createInterface} from 'node:readline';
import {openLocalTools} from '../local-tools.mjs';

const root=await realpath(await mkdtemp(path.join(tmpdir(),'native-executor-')));
let gateway,socket,lines;
try{
 await writeFile(path.join(root,'value.txt'),'before\n');
 await writeFile(path.join(root,'value.test.mjs'),"import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; test('value',()=>assert.equal(fs.readFileSync('value.txt','utf8'),'after\\n'));");
 gateway=await openLocalTools(root);
 socket=createConnection(gateway.port,'127.0.0.1');
 lines=createInterface({input:socket});
 let sequence=0;
 const pending=new Map();
 lines.on('line',line=>{
  const response=JSON.parse(line);
  const waiting=pending.get(response.id);
  if(waiting){pending.delete(response.id);clearTimeout(waiting.timer);waiting.resolve(response);}
 });
 const request=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++sequence;
  const timer=setTimeout(()=>reject(Error('MCP response timeout for '+method)),60000);
  pending.set(id,{resolve,timer});
  socket.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
 });
 socket.write(JSON.stringify({token:gateway.token})+'\n');
 const initialization=await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'project-client',version:'1'}});
 assert.ok(initialization.result.instructions.includes(root));
 socket.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const tools=(await request('tools/list')).result.tools;
 for(const name of ['Read','Edit','Write','Glob','Grep','Bash','PowerShell'])assert.ok(tools.some(tool=>tool.name===name));
 assert.ok(!tools.some(tool=>tool.name==='Agent'));
 assert.ok(!tools.some(tool=>tool.name==='CronCreate'));
 assert.ok(tools.some(tool=>tool.name==='EnterWorktree'));
 assert.ok(tools.some(tool=>tool.name==='ExitWorktree'));
 async function call(name,args){
  const response=await request('tools/call',{name,arguments:args});
  assert.ok(!response.error,JSON.stringify(response));
  assert.ok(!response.result.isError,JSON.stringify(response.result));
  return response.result;
 }
 const file=path.join(root,'value.txt');
 const largeFile=path.join(root,'large.txt');
 await writeFile(largeFile,('line of content\n').repeat(5000)+'192.0.2.18\nAustralia/Sydney\n');
 const largeRead=await call('Read',{file_path:largeFile,offset:4995,limit:10});
 assert.match(JSON.stringify(largeRead),/line of content/);
 assert.doesNotMatch(JSON.stringify(largeRead),/192\.0\.2\.18|Australia\/Sydney/);
 const read=await call('Read',{file_path:file});
 assert.match(JSON.stringify(read),/before/);
 await call('Edit',{file_path:file,old_string:'before',new_string:'after'});
 assert.equal(await readFile(file,'utf8'),'after\n');
 await call('Write',{file_path:path.join(root,'added.txt'),content:'created\n'});
 assert.equal(await readFile(path.join(root,'added.txt'),'utf8'),'created\n');
 assert.match(JSON.stringify(await call('Glob',{pattern:'*.txt'})),/added/);
 assert.match(JSON.stringify(await call('Grep',{pattern:'after',path:root,output_mode:'content'})),/after/);
 const concurrent=await Promise.all([call('Read',{file_path:file}),call('Glob',{pattern:'*.txt'})]);
 assert.match(JSON.stringify(concurrent[0]),/after/);
 assert.match(JSON.stringify(concurrent[1]),/added/);
 const missing=await request('tools/call',{name:'Read',arguments:{file_path:path.join(root,'missing.txt')}});
 assert.equal(missing.result.isError,true);
 const shell=await call('PowerShell',{command:"node --test value.test.mjs; Write-Output '192.0.2.17'; Write-Output 'Australia/Sydney'; Write-Output 'C:\\outside\\unchanged.txt'",timeout:30000});
 assert.match(JSON.stringify(shell),/pass/);
 assert.doesNotMatch(JSON.stringify(shell),/192\.0\.2\.17|Australia\/Sydney/);
 assert.match(JSON.stringify(shell),/outside/);
 const bash=await call('Bash',{command:'cat value.txt; printf "\\nCOMMAND_DONE\\n"',timeout:30000});
 let bashResult=JSON.stringify(bash);
 const background=JSON.parse(bash.content[0].text);
 if(background.backgroundOutputPath){
  for(let n=0;n<30&&!bashResult.includes('COMMAND_DONE');n++){
   await new Promise(resolve=>setTimeout(resolve,1000));
   bashResult=JSON.stringify(await call('Read',{file_path:background.backgroundOutputPath}));
  }
  if(!bashResult.includes('COMMAND_DONE'))await call('TaskStop',{task_id:background.backgroundTaskId});
 }
 assert.match(bashResult,/after/);
 const detached=new Promise(resolve=>socket.once('close',resolve));
 const control=createConnection(gateway.port,'127.0.0.1');
 control.on('error',()=>{});
 control.end(JSON.stringify({token:gateway.token,close:true})+'\n');
 await detached;
 await gateway.close();
 console.log('Native Claude Code Read/Edit/Write/Glob/Grep/Bash/PowerShell passed; paths preserved; IP/time zone redacted.');
}finally{
 lines?.close();socket?.destroy();
 await gateway?.close();
 await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
