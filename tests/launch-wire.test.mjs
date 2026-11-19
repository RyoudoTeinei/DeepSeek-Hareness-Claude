import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import vm from 'node:vm';
import {decodeLaunch} from '../launch-wire.mjs';
import {terminalFromReady,attachCommand} from '../terminal-attach.mjs';

test('terminal attach accepts only this chat and uses direct tmux after readiness',()=>{
 const scope='a'.repeat(32),name='dsh-vm-native-'+scope;
 assert.equal(terminalFromReady('DSH_AGENT:'+JSON.stringify({type:'native_ready',session:name}),scope),name);
 assert.equal(attachCommand(name),'export TERM=xterm-256color; exec tmux attach-session -d -t ='+name);
 assert.throws(()=>terminalFromReady('DSH_AGENT:'+JSON.stringify({type:'native_ready',session:'dsh-native-'+'b'.repeat(32)}),scope));
 assert.throws(()=>attachCommand('another-person-session'));
});

test('native terminal launch preserves empty identity and model in PowerShell',t=>{
 if(process.platform!=='win32')return t.skip('Windows launch contract');
 let registered;
 const source=readFileSync(new URL('../client.js',import.meta.url),'utf8').replace('return {inject,apply};','return {inject,apply,launchCommand};');
 vm.runInNewContext(source,{TextEncoder,btoa,window:{__ModuleLoader__:{load:value=>registered=value}}});
 const api=registered.factory(()=>({createElement(){}}));
 const temporary=mkdtempSync(path.join(tmpdir(),'dsh-launch-'));
 assert.equal(path.dirname(temporary),path.resolve(tmpdir()));
 t.after(()=>rmSync(temporary,{recursive:true,force:true}));
 const script=path.join(temporary,'launch probe.mjs');
 writeFileSync(script,'import {decodeLaunch} from '+JSON.stringify(pathToFileURL(fileURLToPath(new URL('../launch-wire.mjs',import.meta.url))).href)+';console.log(JSON.stringify(decodeLaunch(process.argv.slice(2))))');
 const request={action:'native',host:'example',project:'project',identity:'',sessionId:'chat-123',desktopMode:'',remoteModel:'sonnet'};
 const command='[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); '+api.launchCommand(request,script);
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true});
 assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),request);
 assert.equal(decodeLaunch(['shell','example','project']).action,'shell');
});
