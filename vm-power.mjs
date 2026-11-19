// Local-only power controls. They are never exposed as Claude MCP tools.
import net from 'node:net';
import {createInterface} from 'node:readline';
import {readFile,readdir,mkdir,writeFile,unlink,stat} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {atomicJson,readJson} from './desktop-state.mjs';

export const POWER_VERSION='vm-power-v1';
export const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const powerRoot=base=>path.join(base,'DSH-Remote-Claude');
export async function loadPowerProfile(base=process.env.LOCALAPPDATA){
 const profile=await readJson(path.join(powerRoot(base),'vm-executor.json'));
 if(!profile?.guest)throw Error('执行虚拟机尚未配置');
 const vm=JSON.parse((await readFile(profile.vmStatePath,'utf8')).replace(/^\uFEFF/,''));
 if(vm.network!=='isolated'||vm.instanceId!==profile.guest.instanceId||path.resolve(vm.directory||'.')!==path.dirname(profile.guest.identity)||!Number.isInteger(vm.qmpPort)||vm.qmpPort<1024||vm.qmpPort>65535)throw Error('执行虚拟机身份或隔离配置不符');
 return {...profile,vm};
}

export function openQmp(port,timeout=2500){
 return new Promise((resolve,reject)=>{
  const socket=net.connect({host:'127.0.0.1',port});const lines=createInterface({input:socket});
  const pending=new Map();let sequence=0,ready=false;
  const fail=error=>{if(!ready)reject(error);for(const item of pending.values()){clearTimeout(item.timer);item.reject(error)}pending.clear();socket.destroy();};
  const helloTimer=setTimeout(()=>fail(Error('虚拟机控制端口没有响应')),timeout);
  const api={
   request(command){return new Promise((accept,deny)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);deny(Error('虚拟机控制请求超时'))},timeout);pending.set(id,{resolve:accept,reject:deny,timer});socket.write(JSON.stringify({execute:command,id})+'\n')})},
   close(){clearTimeout(helloTimer);lines.close();socket.destroy();}
  };
  socket.on('error',error=>{clearTimeout(helloTimer);fail(error)});
  lines.on('error',error=>{clearTimeout(helloTimer);fail(error)});
  socket.on('close',()=>{clearTimeout(helloTimer);if(!ready)reject(Error('虚拟机控制连接已关闭'));for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('虚拟机控制连接已关闭'))}pending.clear();});
  lines.on('line',line=>{
   let frame;try{frame=JSON.parse(line)}catch{fail(Error('虚拟机控制响应无效'));return;}
   if(frame.QMP&&!ready){ready=true;clearTimeout(helloTimer);resolve(api);return;}
   const item=pending.get(frame.id);if(!item)return;clearTimeout(item.timer);pending.delete(frame.id);frame.error?item.reject(Error(frame.error.desc||'虚拟机控制失败')):item.resolve(frame.return);
  });
 });
}

const qmpQueues=new Map();
export function verifiedQmp(profile,operation){
 const port=profile.vm.qmpPort,previous=qmpQueues.get(port)||Promise.resolve();
 const task=previous.catch(()=>{}).then(()=>qmpOperation(profile,operation));qmpQueues.set(port,task);
 task.finally(()=>{if(qmpQueues.get(port)===task)qmpQueues.delete(port)}).catch(()=>{});return task;
}
async function qmpOperation(profile,operation){
 const qmp=await openQmp(profile.vm.qmpPort);
 try{
  await qmp.request('qmp_capabilities');
  const identity=await qmp.request('query-uuid');
  if(identity.UUID!==profile.guest.instanceId)throw Error('控制端口属于另一台虚拟机，已拒绝操作');
  return await operation(qmp);
 }finally{qmp.close();}
}

function processAlive(pid){
 if(!Number.isInteger(pid)||pid<=0)return false;
 try{process.kill(pid,0);return true}catch(error){return error.code!=='ESRCH';}
}
export async function probePower(profile){
 try{const state=await verifiedQmp(profile,q=>q.request('query-status'));return {state:'running',runState:state.status};}
 catch(error){
  if(error.code==='ECONNREFUSED'){
   const pid=Number((await readFile(path.join(path.dirname(profile.guest.identity),'qemu.pid'),'utf8').catch(()=>'' )).trim());
   if(!processAlive(pid))return {state:'stopped'};
   return {state:'unknown',error:'控制端口未响应，进程仍存在；未判定为已关闭'};
  }
  return {state:'unknown',error:String(error.message)};
 }
}
export async function requestPowerdown(profile,timeout=35000){
 await verifiedQmp(profile,q=>q.request('system_powerdown'));
 const until=Date.now()+timeout;
 while(Date.now()<until){
  await pause(350);const state=await probePower(profile);
  if(state.state==='stopped')return state;
  if(state.state==='unknown'&&state.error.includes('另一台'))throw Error(state.error);
 }
 throw Error('虚拟机尚未完成关机；已保留磁盘，不会强制断电。请稍后刷新状态。');
}

export async function withPowerLock(profile,operation,timeout=90000){
 const file=path.join(path.dirname(profile.guest.identity),'power.lock');const token=randomBytes(16).toString('hex'),deadline=Date.now()+timeout;
 await mkdir(path.dirname(file),{recursive:true});
 while(true){
  try{await writeFile(file,JSON.stringify({pid:process.pid,token}),{flag:'wx',mode:0o600});break;}
  catch(error){
   if(error.code!=='EEXIST')throw error;
   let owner;try{owner=await readJson(file)}catch{}
   const age=Date.now()-(await stat(file).catch(()=>({mtimeMs:Date.now()}))).mtimeMs;
   if(owner&&!processAlive(owner.pid)&&age>1000){await unlink(file).catch(()=>{});continue;}
   if(Date.now()>deadline)throw Error('另一个虚拟机电源操作尚未完成');
   await pause(200);
  }
 }
 try{return await operation();}
 finally{const owner=await readJson(file).catch(()=>null);if(owner?.token===token)await unlink(file).catch(()=>{});}
}

export async function foreignConnections(profile,owned){
 const folder=path.join(path.dirname(profile.guest.identity),'bridges');
 const names=await readdir(folder).catch(()=>[]),result=[];
 for(const name of [...names.filter(n=>/^[a-f0-9]{32}\.lock$/.test(n)).map(n=>path.join(folder,n)),path.join(path.dirname(profile.guest.identity),'bridge.lock')]){
  const lease=await readJson(name).catch(()=>null);
  if(lease&&processAlive(lease.pid)&&!(lease.pid===process.pid&&owned.has(lease.scope)))result.push({scope:lease.scope,pid:lease.pid});
 }
 return result;
}
export function sameConnections(expected,current){
 return Array.isArray(expected)&&expected.length===current.length&&new Set(expected).size===expected.length&&current.every(c=>expected.includes(c.connectionId));
}
export function mayWake(policy,intent){
 return !policy?.manualOff||(intent.explicitWake===true&&intent.createdAt>(policy.changedAt||0));
}

export class VMPower{
 constructor(base,bridges,ensureRunning){this.base=base;this.bridges=bridges;this.ensureRunning=ensureRunning;this.queue=Promise.resolve();this.phase=null;}
 policyFile(profile=this.profile){if(!profile)throw Error('虚拟机配置尚未加载');return path.join(path.dirname(profile.guest.identity),'power-policy.json');}
 async status(){
  let profile;try{profile=await loadPowerProfile(this.base);this.profile=profile}catch(error){return {state:'unavailable',error:error.message,connections:[]};}
  let policy;try{policy=await readJson(this.policyFile(),{})}catch{return {state:'unknown',error:'虚拟机电源设置无法读取；未自动启动',connections:this.connections()};}
  const actual=await probePower(profile);
  return {...actual,...(this.phase?{state:this.phase}:{}),manualOff:!!policy.manualOff,memoryMiB:profile.vm.memoryMiB,cpus:profile.vm.cpus,connections:this.connections(),updatedAt:Date.now()};
 }
 connections(){return [...this.bridges.values()].filter(b=>!b.closed).map(b=>({scope:b.cfg.scope,project:b.cfg.project,title:path.basename(b.cfg.localRoot),connectionId:b.connectionId,busy:!!b.chats?.size||!!b.native?.foreground?.size}));}
 exclusive(fn,timeout){const task=this.queue.catch(()=>{}).then(async()=>{const profile=await loadPowerProfile(this.base);this.profile=profile;return withPowerLock(profile,()=>fn(profile),timeout)});this.queue=task;return task;}
 async connect(intent,operation){return this.exclusive(async profile=>{
  const policy=await readJson(this.policyFile(),{});
  if(!mayWake(policy,intent))throw Error('虚拟机已手动关闭。请点击“启动虚拟机”或“接入 Claude”，后台恢复不会自动唤醒。');
  this.phase='starting';
  try{
   if(intent.explicitWake)await atomicJson(this.policyFile(),{manualOff:false,changedAt:Date.now()});
   await this.ensureRunning(profile);
   this.phase=null;return await operation(profile);
  }finally{this.phase=null;}
 });}
 async start(intent){return this.connect({...intent,explicitWake:true},async()=>({status:'started',power:await this.status()}));}
 async shutdown(request={}){return this.exclusive(async profile=>{
  const external=await foreignConnections(profile,new Set(this.bridges.keys()));
  if(external.length)throw Error('其他 DSH 后台仍连接着这台虚拟机，请先断开其连接；未关闭虚拟机。');
  const initial=await probePower(profile);
  if(initial.state==='unknown')throw Error(initial.error);
  const current=this.connections();
  if(current.length&&!request.allOwned&&!sameConnections(request.confirmedConnections,current))return {status:'needs-confirmation',connections:current};
  // Persist before teardown: stale reconnect requests must not wake it back up.
  await atomicJson(this.policyFile(),{manualOff:true,changedAt:Date.now()});this.phase='stopping';
  try{
   await Promise.all([...this.bridges.values()].map(b=>b.stop()));
   const state=await probePower(profile);
   if(state.state==='unknown')throw Error(state.error);
   if(state.state==='running')await requestPowerdown(profile,request.powerTimeout);
   return {status:'stopped',power:{state:'stopped',manualOff:true,connections:[],memoryMiB:profile.vm.memoryMiB,cpus:profile.vm.cpus}};
  }finally{this.phase=null;}
 },request.lockTimeout);}
}
