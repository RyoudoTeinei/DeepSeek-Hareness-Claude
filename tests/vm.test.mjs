import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {assertShareRoot,stageVMAttachment,vmStatus} from '../vm-controller.mjs';
import {VMBridge,validateVMConfig} from '../vm-runtime.mjs';
import {atomicJson,desktopDirectory} from '../desktop-state.mjs';
import {NativeVMClient,VM_TOOL_NAMES} from '../vm-native.mjs';

test('VM exposes execution primitives but never a second model or web agent',async()=>{
 for(const name of ['Agent','Skill','WebSearch','WebFetch','ToolSearch','Workflow'])assert.equal(VM_TOOL_NAMES.has(name),false);
 const client=new NativeVMClient({},()=>[]);client.rpc=()=>{throw Error('Forbidden request reached native process')};
 await assert.rejects(client.request({method:'tools/call',params:{name:'Agent'}}),/not exposed/);
 await assert.rejects(client.request({method:'initialize',params:{}}),/not exposed/);
 client.catalog={tools:[{name:'Read',description:'Read'},{name:'Agent',description:'Agent'}]};client.guest.root='/workspaces/test';
 assert.deepEqual((await client.request({method:'tools/list'})).tools.map(t=>t.name),['Read']);
});

test('background stop is limited to tasks created by this persistent VM connection',async()=>{
 const client=new NativeVMClient({root:'/workspaces/'+'a'.repeat(32)},()=>[]),calls=[];
 client.rpc=async(method,params)=>{calls.push(params);return {content:[{type:'text',text:JSON.stringify({backgroundTaskId:'owned-task',stdout:''})}]};};
 const denied=await client.request({method:'tools/call',params:{name:'TaskStop',arguments:{task_id:'other-session'}}});
 assert.equal(denied.isError,true);assert.equal(calls.length,0);
 await client.request({method:'tools/call',params:{name:'Bash',arguments:{command:'echo safe',run_in_background:true}}});
 assert.match(calls[0].arguments.command,/job\.py.* run [a-f0-9]{32}/);
 await client.request({method:'tools/call',params:{name:'TaskStop',arguments:{task_id:'owned-task'}}});
 assert.equal(calls[1].name,'Bash');assert.match(calls[1].arguments.command,/ stop [a-f0-9]{32}$/);
 await assert.rejects(client.request({method:'tools/call',params:{name:'Bash',arguments:{command:'sleep 600',timeout:600000}}}),/run_in_background/);
});

test('personal credentials, Desktop data and VM control folders cannot be shared',()=>{
 const home=os.homedir(),privateDir=path.join(home,'VM-private');
 for(const root of [home,path.parse(home).root,path.join(home,'.claude'),path.join(home,'.ssh'),path.join(home,'AppData','Roaming','Claude'),privateDir])assert.throws(()=>assertShareRoot(root,privateDir));
 assert.doesNotThrow(()=>assertShareRoot(path.join(home,'project'),privateDir));
});
test('executor refuses non-loopback guests and bootstrap networking',()=>{
 const cfg={scope:'a'.repeat(32),cloud:{host:'example'},guest:{host:'127.0.0.1',port:23000,user:'dshvm',instanceId:'11111111-1111-1111-1111-111111111111',root:'/workspaces/'+'a'.repeat(32),identity:path.resolve('key'),knownHosts:path.resolve('known_hosts')},localRoot:path.resolve('project'),stateDirectory:path.resolve('state'),hostPython:path.resolve('python.exe'),network:'isolated'};
 assert.equal(validateVMConfig(cfg),cfg);
 assert.throws(()=>validateVMConfig({...cfg,guest:{...cfg.guest,host:'remote.example'}}));
 assert.throws(()=>validateVMConfig({...cfg,network:'bootstrap'}));
});
test('VM attachments stay in the bound project and offline connections cannot stage files',async t=>{
 const temporary=await mkdtemp(path.join(os.tmpdir(),'dsh-vm-stage-'));const old=process.env.LOCALAPPDATA;process.env.LOCALAPPDATA=temporary;
 assert.equal(path.dirname(temporary),path.resolve(os.tmpdir()));
 t.after(async()=>{if(old===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=old;await rm(temporary,{recursive:true,force:true});});
 const root=path.join(temporary,'project');await mkdir(root);
 const scope='b'.repeat(32),directory=path.join(desktopDirectory(scope),'vm');
 await atomicJson(path.join(directory,'config.json'),{localRoot:root});
 await atomicJson(path.join(directory,'status.json'),{status:'connected',updatedAt:Date.now()});
 const result=await stageVMAttachment(scope,root,'input.txt',Buffer.from('safe'));
 assert.equal(await readFile(path.join(root,result),'utf8'),'safe');
 assert.equal(await stageVMAttachment(scope,root,'input.txt',Buffer.from('safe')),result);
 await assert.rejects(stageVMAttachment(scope,root,'../escape',Buffer.from('bad')));
 await atomicJson(path.join(directory,'status.json'),{status:'connected',updatedAt:Date.now()-30000});
 assert.equal((await vmStatus(scope)).status,'offline');
 await assert.rejects(stageVMAttachment(scope,root,'new.txt',Buffer.from('bad')),/离线/);
});

test('late or concurrent tool results cannot publish an obsolete ready state',async t=>{
 const stateDirectory=await mkdtemp(path.join(os.tmpdir(),'dsh-status-'));
 t.after(()=>rm(stateDirectory,{recursive:true,force:true}));
 const bridge=Object.create(VMBridge.prototype);
 const phases=[],finish=new Map();
 Object.assign(bridge,{cfg:{stateDirectory},activeTools:0,closed:false,
  state:async status=>{phases.push(status)},
  native:{request:({n})=>new Promise(resolve=>finish.set(n,resolve))}
 });
 const calls=[1,2].map(n=>bridge.execute({id:String(n).repeat(32),operation:'mcp',arguments:{n}}));
 while(finish.size<2)await new Promise(resolve=>setTimeout(resolve,10));
 finish.get(1)({});await calls[0];assert.deepEqual(phases,['running','running']);
 bridge.closed=true;finish.get(2)({});await calls[1];
 assert.deepEqual(phases,['running','running']);assert.equal(bridge.activeTools,0);
});
