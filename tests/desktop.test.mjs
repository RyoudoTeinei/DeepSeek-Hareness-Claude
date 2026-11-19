import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {outboundText} from '../outbound.mjs';
import {desktopScope, validateDesktopRequest, recordDesktopRequest, listDesktopRequests,
  decideDesktopRequest, readJson, remoteDesktopResult, desktopDirectory} from '../desktop-state.mjs';
import {executeDecision,receiveArtifact,sshArguments} from '../desktop-runtime.mjs';

const id = 'a'.repeat(32);
const request = {id,action:'download',path:'reports/result.pdf',reason:'Review this result'};

async function scratch(t) {
  const directory = await mkdtemp(path.join(tmpdir(),'dsh-desktop-test-'));
  assert.equal(path.dirname(directory),path.resolve(tmpdir()));
  t.after(() => rm(directory,{recursive:true,force:true}));
  return directory;
}

test('each conversation has a stable separate remote scope', () => {
  assert.equal(desktopScope('chat-1','example','app'),desktopScope('chat-1','example','app'));
  assert.notEqual(desktopScope('chat-1','example','app'),desktopScope('chat-2','example','app'));
  assert.throws(() => desktopScope('../chat','example','app'));
});

test('project paths and open types are bounded', () => {
  for (const file of ['../secret','/secret','C:/secret','a\\secret','a/../secret','a//b','a:b','NUL.txt','x.','a\nb']) {
    assert.throws(() => validateDesktopRequest({...request,path:file}),file);
  }
  assert.throws(() => validateDesktopRequest({...request,action:'shell',command:'hostname'}));
  assert.throws(() => validateDesktopRequest({...request,action:'open_file',path:'script.ps1'}));
  assert.throws(() => validateDesktopRequest({...request,action:'open_file',path:'site.html'}));
  assert.deepEqual(validateDesktopRequest(request),request);
});

test('the same remote ID cannot replace the file after approval', async t => {
  const directory = await scratch(t);
  await recordDesktopRequest(directory,request);
  await decideDesktopRequest(directory,id,true);
  await assert.rejects(recordDesktopRequest(directory,{...request,path:'other.pdf'}));
  const record = (await listDesktopRequests(directory))[0];
  assert.equal(record.request.path,request.path);
});

test('denied actions do not execute and results omit local details', async t => {
  const directory = await scratch(t);
  const record = await recordDesktopRequest(directory,request);
  let executed = false;
  const result = await executeDecision(directory,record,{approved:false},{download:async()=>{executed=true;}});
  assert.equal(executed,false);
  assert.deepEqual(result,{id,status:'denied'});
});

test('approved artifact actions download then open, returning only status', async t => {
  const directory = await scratch(t);
  const record = await recordDesktopRequest(directory,{...request,action:'open_file'});
  const calls = [];
  const privatePath = 'C:\\private-user\\downloads\\result.pdf';
  const result = await executeDecision(directory,record,{approved:true},{
    download:async input=>{calls.push(input.path);return privatePath;},
    open:async file=>{calls.push(file);},
  });
  assert.deepEqual(calls,[request.path,privatePath]);
  assert.deepEqual(result,{id,status:'completed'});
  assert.equal((await readJson(path.join(directory,'requests',id+'.json'))).localFile,privatePath);
  assert.ok(!JSON.stringify(result).includes('private-user'));
});

test('local exception text never becomes the remote response', async t => {
  const directory = await scratch(t);
  const record = await recordDesktopRequest(directory,request);
  const result = await executeDecision(directory,record,{approved:true},{download:async()=>{throw Error('192.0.2.7 Australia/Sydney C:\\secret');}});
  assert.deepEqual(result,{id,status:'failed',code:'TRANSFER_FAILED'});
});

test('download requires complete verified data and never publishes a partial file', async t => {
  const directory = await scratch(t);
  const bytes=Buffer.from('test artifact');
  const frames=[{type:'file',size:bytes.length},{type:'data',base64:bytes.toString('base64')},{type:'end',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}];
  const lines=values=>values.map(frame=>'DSH_DESKTOP:'+JSON.stringify(frame));
  const destination=path.join(directory,'result.txt');
  await receiveArtifact(lines(frames),destination);
  assert.deepEqual(await readFile(destination),bytes);
  await assert.rejects(receiveArtifact(lines(frames),destination));
  assert.deepEqual(await readFile(destination),bytes);
  await assert.rejects(receiveArtifact(lines(frames.slice(0,2)),path.join(directory,'partial.txt')));
  assert.deepEqual(await readdir(directory),['result.txt']);
});

test('hash mismatch does not publish data', async t => {
  const directory = await scratch(t);
  await assert.rejects(receiveArtifact([
    'DSH_DESKTOP:'+JSON.stringify({type:'file',size:1}),
    'DSH_DESKTOP:'+JSON.stringify({type:'data',base64:'eA=='}),
    'DSH_DESKTOP:'+JSON.stringify({type:'end',size:1,sha256:'0'.repeat(64)}),
  ],path.join(directory,'bad.txt')));
  assert.deepEqual(await readdir(directory),[]);
});

test('outbound message ignores automatic environment context and source metadata', () => {
  const messages=[
    {role:'system',content:[{type:'text',text:'IP=192.0.2.7 TZ=Australia/Sydney'}]},
    {role:'user',source:{kind:'runtime-context'},content:[{type:'text',text:'locale=zh-CN'}]},
    {role:'user',source:{kind:'user',rpcId:'123',clientTimeZone:'Australia/Sydney',locale:'zh-CN'},content:[{type:'text',text:'Read the project README.'}]},
  ];
  assert.equal(outboundText(messages),'Read the project README.');
  assert.ok(sshArguments({host:'example'}).includes('SendEnv=-*'));
  assert.deepEqual(remoteDesktopResult(id,'failed','C:\\private'),{id,status:'failed'});
});

test('normal sync entry point binds and approves only the matching desktop scope', async t => {
  const directory=await scratch(t);
  const cfg={host:'example',project:'app',identity:'',sessionId:'chat-one',desktopTools:true};
  const cli=fileURLToPath(new URL('../sync.mjs',import.meta.url));
  function invoke(request){
    const result=spawnSync(process.execPath,[cli],{input:JSON.stringify(request),encoding:'utf8',env:{...process.env,LOCALAPPDATA:directory},windowsHide:true});
    assert.equal(result.status,0,result.stdout+result.stderr);
    return JSON.parse(result.stdout).result;
  }
  assert.equal(invoke({...cfg,action:'bind-chat',clientTimeZone:'Australia/Sydney',ip:'192.0.2.7'}),true);
  const route=await readJson(path.join(directory,'DSH-Remote-Claude','chat-routes',createHash('sha256').update(cfg.sessionId).digest('hex')+'.json'));
  assert.equal(route.desktopTools,false);
  assert.equal(route.vmTools,true);
  assert.equal(route.clientTimeZone,undefined);
  assert.equal(route.ip,undefined);
  const state=desktopDirectory(desktopScope(cfg.sessionId,cfg.host,cfg.project),directory);
  await recordDesktopRequest(state,request);
  assert.equal(invoke({...cfg,action:'desktop-list'}).requests.length,1);
  assert.equal(invoke({...cfg,sessionId:'chat-two',action:'desktop-list'}).requests.length,0);
  invoke({...cfg,action:'desktop-decide',requestId:id,approved:true});
  assert.deepEqual(await readJson(path.join(state,'decisions',id+'.json')),{approved:true});
});
