// Local-only power controls. They are never exposed as Claude MCP tools.
import net from 'node:net';
import {createInterface} from 'node:readline';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {atomicJson,readJson} from './desktop-state.mjs';

export const POWER_VERSION='vm-power-v2';
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
 const directory=path.dirname(profile.guest.identity);
 await mkdir(directory,{recursive:true});
 const helper=spawn(profile.hostPython||'python',[fileURLToPath(new URL('./vm-power-lock.py',import.meta.url)),path.join(directory,'power.lock'),String(timeout)],{windowsHide:true,stdio:['pipe','pipe','ignore']});
 helper.stdin.on('error',()=>{});
 const closed=new Promise(resolve=>helper.once('close',resolve));
 try{
  await new Promise((resolve,reject)=>{
   helper.once('error',reject);
   createInterface({input:helper.stdout}).once('line',line=>line==='locked'?resolve():reject(Error('无法取得电源锁')));
   closed.then(code=>reject(Error(code===2?'另一个虚拟机电源操作尚未完成':'电源锁进程未就绪')));
  });
  // Respect a live v1 owner during upgrades. Stale metadata is not a v2 lock.
  const oldFile=path.join(directory,'power.lock');
  let previous;
  try{previous=await readJson(oldFile)}catch(error){if(!(error instanceof SyntaxError))throw error;}
  if(previous?.lockVersion!==2&&previous&&processAlive(previous.pid))throw Error('旧版后台正在控制电源，请等待其操作完成');
  await writeFile(oldFile,JSON.stringify({pid:helper.pid,lockVersion:2}),{mode:0o600});
  return await operation();
 }finally{helper.stdin.end();await closed;}
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
 connections(){
  return [...this.bridges.values()].filter(b=>!b.closed).map(bridge=>{
   const {cfg}=bridge;
   let chatTitle;
   try{chatTitle=this.titleOf?.(cfg.sessionId);}catch{/* Archived chats use the stable short ID. */}
   return {scope:cfg.scope,project:cfg.project,title:path.basename(cfg.localRoot),chatTitle,
    connectionId:bridge.connectionId,busy:!!bridge.chats?.size||bridge.activeTools>0||!!bridge.native?.foreground?.size};
  });
 }
 exclusive(fn,timeout){const task=this.queue.catch(()=>{}).then(async()=>{const profile=await loadPowerProfile(this.base);this.profile=profile;return withPowerLock(profile,()=>fn(profile),timeout)});this.queue=task;return task;}
 async connect(intent,operation){return this.exclusive(async profile=>{
  const policy=await readJson(this.policyFile(),{});
  if(!mayWake(policy,intent))throw Error('虚拟机已手动关闭。请点击“启动虚拟机”或“接入 Claude”，后台恢复不会自动唤醒。');
  this.phase='starting';
  try{
   await this.ensureRunning(profile,{explicitWake:intent.explicitWake===true});
   if(intent.explicitWake&&policy.manualOff)await atomicJson(this.policyFile(),{manualOff:false,changedAt:Date.now()});
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
  const newlyBusy=Array.isArray(request.confirmedBusy)&&current.some(item=>item.busy&&!request.confirmedBusy.includes(item.connectionId));
  if(current.length&&!request.allOwned&&(newlyBusy||!sameConnections(request.confirmedConnections,current)))return {status:'needs-confirmation',connections:current};
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
