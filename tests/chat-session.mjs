import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import vm from 'node:vm';
import {bindChatRoute,readChatRoute,routeFile,decodeLaunch} from '../chat-session.mjs';

const temporary=mkdtempSync(path.join(tmpdir(),'dsh-conversation-'));
const prior=process.env.LOCALAPPDATA;
process.env.LOCALAPPDATA=temporary;
try{
 const cfg={host:'user@example',project:'same-project',identity:''};
 const first=bindChatRoute('chat-a',cfg),second=bindChatRoute('chat-b',cfg);
 assert.notEqual(first.tmuxSession,second.tmuxSession);
 assert.notEqual(first.claudeSessionId,second.claudeSessionId);
 assert.deepEqual(bindChatRoute('chat-a',cfg),first);
 assert.deepEqual(readChatRoute('chat-b'),second);
 assert.notEqual(bindChatRoute('chat-a',{...cfg,project:'different'}).claudeSessionId,first.claudeSessionId);
 const old=routeFile('legacy');
 mkdirSync(path.dirname(old),{recursive:true});writeFileSync(old,JSON.stringify(cfg));
 const legacy=bindChatRoute('legacy',cfg);
 assert.match(legacy.tmuxSession,/^dsh-[a-f0-9]{16}-claude$/);
 assert.equal(legacy.claudeSessionId,undefined);

 let module;
 const source=readFileSync(new URL('../client.js',import.meta.url),'utf8')
  .replace('return {inject,apply};','return {inject,apply,launchCommand};');
 vm.runInNewContext(source,{TextEncoder,btoa,window:{__ModuleLoader__:{load:value=>module=value}}});
 const {launchCommand}=module.factory(()=>({createElement(){}}));
 if(process.platform==='win32'){
  const probe=path.join(temporary,'argument probe.mjs');
  writeFileSync(probe,'import {decodeLaunch} from '+JSON.stringify(pathToFileURL(fileURLToPath(new URL('../chat-session.mjs',import.meta.url))).href)+'; console.log(JSON.stringify(decodeLaunch(process.argv.slice(2))));');
  for(const identity of ['',String.raw`C:\keys\private key`]){
   const request={...first,action:'claude',identity,localWorkspace:String.raw`D:\项目\O'Brien space`};
   const command="[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); "+launchCommand(request,probe);
   const processResult=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true});
   assert.equal(processResult.status,0,processResult.stderr);
   assert.deepEqual(JSON.parse(processResult.stdout.trim()),request);
  }
 }
 assert.deepEqual(decodeLaunch(['shell','user@example','project','key']),{
  action:'shell',host:'user@example',project:'project',identity:'key',localWorkspace:'',
 });
 console.log('Chat isolation, legacy binding, reconnect identity, and Windows PowerShell launch arguments passed.');
}finally{
 if(prior===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=prior;
 rmSync(temporary,{recursive:true,force:true});
}
