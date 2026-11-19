import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {VMPower,verifiedQmp,requestPowerdown,mayWake,sameConnections} from '../vm-power.mjs';
import {VMManager} from '../vm-manager.mjs';

async function fixture(t,{stopWorks=true,wrongIdentity=false}={}){
 const base=await mkdtemp(path.join(os.tmpdir(),'dsh-power-'));assert.equal(path.dirname(base),path.resolve(os.tmpdir()));
 const privateDir=path.join(base,'instance');await mkdir(privateDir);
 const instance='11111111-1111-4111-8111-111111111111',commands=[],sockets=new Set();
 const server=net.createServer(socket=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.write(JSON.stringify({QMP:{version:{}}})+'\r\n');
  const lines=createInterface({input:socket});lines.on('line',line=>{const request=JSON.parse(line);commands.push(request.execute);
   const value=request.execute==='query-uuid'?{UUID:wrongIdentity?'different-vm':instance}:request.execute==='query-status'?{status:'running',running:true}:{};
   socket.write(JSON.stringify({id:request.id,return:value})+'\r\n');
   if(request.execute==='system_powerdown'&&stopWorks)setTimeout(()=>{for(const s of sockets)s.destroy();server.close()},30);
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const vm={instanceId:instance,directory:privateDir,network:'isolated',qmpPort:server.address().port,memoryMiB:2048,cpus:2};
 const profile={guest:{instanceId:instance,identity:path.join(privateDir,'key')},vmStatePath:path.join(privateDir,'vm.json')};
 await writeFile(profile.vmStatePath,JSON.stringify(vm));await mkdir(path.join(base,'DSH-Remote-Claude'));
 await writeFile(path.join(base,'DSH-Remote-Claude','vm-executor.json'),JSON.stringify(profile));
 t.after(async()=>{for(const socket of sockets)socket.destroy();if(server.listening)await new Promise(resolve=>server.close(resolve));await rm(base,{recursive:true,force:true});});
 return {base,profile:{...profile,vm},commands,server,privateDir};
}
test('power commands verify VM identity before issuing a shutdown',async t=>{
 const f=await fixture(t,{wrongIdentity:true});
 await assert.rejects(verifiedQmp(f.profile,q=>q.request('system_powerdown')),/另一台/);
 assert.equal(f.commands.includes('system_powerdown'),false);
});
test('shutdown acknowledgement alone is not reported as stopped',async t=>{
 const f=await fixture(t,{stopWorks:false});
 await assert.rejects(requestPowerdown(f.profile,50),/尚未完成关机/);
 assert.equal(f.commands.includes('quit'),false);
});
test('manual off rejects background and stale wake requests',()=>{
 const policy={manualOff:true,changedAt:100};
 assert.equal(mayWake(policy,{explicitWake:false,createdAt:200}),false);
 assert.equal(mayWake(policy,{explicitWake:true,createdAt:100}),false);
 assert.equal(mayWake(policy,{explicitWake:true,createdAt:101}),true);
 assert.equal(sameConnections(['a'],[{connectionId:'a'},{connectionId:'b'}]),false);
});
test('active connection review cannot stop an unreviewed new connection',async t=>{
 const f=await fixture(t),bridges=new Map(),stopped=[];
 const bridge=n=>({cfg:{scope:n,project:n,localRoot:path.join(f.base,n)},connectionId:n,closed:false,async stop(){this.closed=true;stopped.push(n)}});
 bridges.set('a',bridge('a'));const power=new VMPower(f.base,bridges,async()=>{});
 const review=await power.shutdown();assert.equal(review.status,'needs-confirmation');assert.deepEqual(stopped,[]);
 bridges.set('b',bridge('b'));
 assert.equal((await power.shutdown({confirmedConnections:['a']})).status,'needs-confirmation');assert.deepEqual(stopped,[]);
 const result=await power.shutdown({confirmedConnections:['a','b']});assert.equal(result.status,'stopped');assert.deepEqual(stopped.sort(),['a','b']);
 assert.equal(JSON.parse(await readFile(power.policyFile(),'utf8')).manualOff,true);
 const otherBase=path.join(f.base,'other-profile');await mkdir(path.join(otherBase,'DSH-Remote-Claude'),{recursive:true});
 await writeFile(path.join(otherBase,'DSH-Remote-Claude','vm-executor.json'),JSON.stringify(f.profile));
 const other=new VMPower(otherBase,new Map(),async()=>{throw Error('Background wake escaped the shared policy')});
 await assert.rejects(other.connect({createdAt:Date.now(),explicitWake:false},async()=>{}),/手动关闭/);
});
test('an executor owned by a different backend blocks global powerdown',async t=>{
 const f=await fixture(t);await mkdir(path.join(f.privateDir,'bridges'));
 await writeFile(path.join(f.privateDir,'bridges','a'.repeat(32)+'.lock'),JSON.stringify({pid:process.pid,scope:'a'.repeat(32)}));
 const power=new VMPower(f.base,new Map(),async()=>{});await assert.rejects(power.shutdown({allOwned:true}),/其他 DSH/);
 assert.equal(f.commands.includes('system_powerdown'),false);
});
test('backend startup inspects status without booting VM or replaying previous requests',async t=>{
 const f=await fixture(t);const manager=new VMManager(f.base);let boots=0;manager.power.ensureRunning=async()=>{boots++};
 const controls=path.join(f.base,'DSH-Remote-Claude','power-requests');await mkdir(controls);
 const id='b'.repeat(32);await writeFile(path.join(controls,id+'.json'),JSON.stringify({id,action:'start',createdAt:manager.startedAt-1}));
 await manager.tick();assert.equal(boots,0);assert.equal(f.commands.includes('system_powerdown'),false);
 await manager.stop();
});
