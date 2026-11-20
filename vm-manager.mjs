// Session-scoped executor lifecycle owned by the DSH backend.
import {readdir,realpath,unlink} from 'node:fs/promises';
import path from 'node:path';
import {VMBridge} from './vm-runtime.mjs';
import {assertShareRoot,ensureGuestRunning} from './vm-controller.mjs';
import {atomicJson,readJson} from './desktop-state.mjs';
import {VMPower,POWER_VERSION,powerRoot} from './vm-power.mjs';
import {migrateBinding} from './session-migration.mjs';

// The long-lived DSH backend owns connections. A temporary sync-terminal command
// only writes a connect request; it must not own the executor's process lifetime.
export class VMManager{
 constructor(base=process.env.LOCALAPPDATA){this.profileBase=base;this.base=path.join(powerRoot(base),'desktop');this.bridges=new Map();this.opening=new Map();this.powerHandled=new Set();this.closed=false;this.checking=false;this.power=new VMPower(base,this.bridges,ensureGuestRunning);this.startedAt=Date.now();}
 start(){const tick=()=>void this.tick().catch(error=>{this.backgroundError=String(error.message)});this.timer=setInterval(tick,1000);tick();return this;}
 publish(){
  const task=(this.publishing||Promise.resolve()).catch(()=>{}).then(async()=>{
   const power=await this.power.status();
   await atomicJson(path.join(powerRoot(this.profileBase),'vm-manager.json'),{engine:'claude-mcp-v2',modePolicy:'vm-multi-v1',historyFork:true,powerVersion:POWER_VERSION,activeConversations:this.bridges.size,warming:power.state==='starting',guestReady:power.state==='running',power,pid:process.pid,updatedAt:Date.now()});this.lastHeartbeat=Date.now();
  });this.publishing=task;return task;
 }
 async powerRequest(request,folder){
  let response;
  try{
   if(this.closed)throw Error('DSH 后台正在退出');
   const result=request.action==='start'?await this.power.start({createdAt:request.createdAt}):await this.power.shutdown({confirmedConnections:request.confirmedConnections,confirmedBusy:request.confirmedBusy});
   response={ok:true,result};
  }catch(error){response={ok:false,error:String(error.message)}}
  try{await this.publish()}catch{this.lastHeartbeat=0;}
  await atomicJson(path.join(folder,request.id+'.result.json'),response);
 }
 async tick(){
  if(this.closed||this.checking)return;this.checking=true;
  try{
   if(!this.lastHeartbeat||Date.now()-this.lastHeartbeat>5000)await this.publish();
   const controls=path.join(powerRoot(this.profileBase),'power-requests');
   const requests=await readdir(controls).catch(()=>[]);
   for(const name of requests.filter(n=>/^[a-f0-9]{32}\.json$/.test(n))){
    const request=await readJson(path.join(controls,name));
    if(!request||request.id+'.json'!==name||!['start','stop'].includes(request.action)||!Number.isSafeInteger(request.createdAt)||request.createdAt<this.startedAt||Date.now()-request.createdAt>120000||request.createdAt>Date.now()+5000||this.powerHandled.has(request.id))continue;
    this.powerHandled.add(request.id);void this.powerRequest(request,controls).catch(error=>{this.backgroundError=String(error.message)});
   }
   const inbox=path.join(powerRoot(this.profileBase),'connect-inbox');
   for(const name of await readdir(inbox).catch(()=>[])){
    if(!/^[a-f0-9]{32}\.json$/.test(name))continue;
    const file=path.join(inbox,name),request=await readJson(file);
    if(!request||request.managerPid!==process.pid)continue;
    await unlink(file);
    if(request.createdAt<this.startedAt||Date.now()-request.createdAt>120000)continue;
    void this.answerConnect(request).catch(error=>{this.backgroundError=String(error.message)});
   }
  }finally{this.checking=false;}
 }
 async answerConnect(request){
  const {id,cfg}=request;
  if(!/^[a-f0-9]{32}$/.test(id)||!cfg||!/^[a-f0-9]{32}$/.test(cfg.scope))return;
  const folder=path.join(this.base,cfg.scope,'vm');
  let reply;
  try{
   if(path.resolve(cfg.stateDirectory)!==path.resolve(folder))throw Error('VM connection binding mismatch');
   const root=await realpath(cfg.localRoot);
   assertShareRoot(root,path.dirname(cfg.guest.identity));
   const saved=await readJson(path.join(folder,'config.json'));
   if(saved&&path.resolve(saved.localRoot).toLowerCase()!==root.toLowerCase())throw Error('聊天已绑定其他项目');
   const checked={...cfg,localRoot:root};
   if(request.migrate===true){
    const route=await migrateBinding(checked,()=>this.ensureBridge(checked,request),this.profileBase);
    reply={ok:true,state:route};
   }else{
    const bridge=await this.ensureBridge(checked,request);
    reply={ok:true,state:{...bridge.lastState,connectionId:bridge.connectionId,scope:cfg.scope}};
   }
  }catch(error){reply={ok:false,error:String(error.message)};}
  await atomicJson(path.join(folder,'connection-results',id+'.json'),reply);
 }
 ensureBridge(cfg,intent){
  const {scope}=cfg;
  const pending=this.opening.get(scope);
  if(pending){
   if(pending.root!==cfg.localRoot.toLowerCase())throw Error('聊天正在连接其他目录');
   if(intent.explicitWake&&intent.createdAt>=pending.intent.createdAt){
    pending.intent.explicitWake=true;
    pending.intent.createdAt=intent.createdAt;
   }
   return pending.ready;
  }
  const current=this.bridges.get(scope);
  if(current&&!current.closed){
   if(current.cfg.localRoot.toLowerCase()!==cfg.localRoot.toLowerCase())throw Error('聊天已绑定其他目录');
   return Promise.resolve(current);
  }
  const ready=this.startBridge(cfg,intent,current).finally(()=>this.opening.delete(scope));
  this.opening.set(scope,{root:cfg.localRoot.toLowerCase(),intent,ready});
  return ready;
 }
 async startBridge(cfg,intent,closing){
  const {scope,stateDirectory}=cfg;
  let bridge;
  try{
   if(closing)await closing.stop();
   await this.power.connect(intent,async()=>{
    if(this.closed)throw Error('DSH 后台正在退出');
    await atomicJson(path.join(stateDirectory,'config.json'),cfg);
    bridge=new VMBridge(cfg);
    this.bridges.set(scope,bridge);
    await bridge.start({migrate:intent.migrate===true});
   });
   if(this.closed)throw Error('DSH 后台正在退出');
   void this.observeBridge(scope,bridge).catch(error=>{this.backgroundError=String(error.message)});
   return bridge;
  }catch(error){
   if(bridge)await bridge.stop();
   if(!bridge||this.bridges.get(scope)===bridge){
    await atomicJson(path.join(stateDirectory,'status.json'),{status:'failed',scope,updatedAt:Date.now(),error:String(error.message)});
    if(bridge)this.bridges.delete(scope);
   }
   throw error;
  }
 }
 async observeBridge(scope,bridge){
  try{await bridge.done;await bridge.stop();}
  finally{if(this.bridges.get(scope)===bridge)this.bridges.delete(scope);}
 }
 async stop(){
  this.closed=true;clearInterval(this.timer);
  try{await this.power.shutdown({allOwned:true,lockTimeout:2500,powerTimeout:10000})}catch(error){this.exitPowerError=String(error.message);await Promise.all([...this.bridges.values()].map(bridge=>bridge.stop()));}
  await this.publishing?.catch(()=>{});
  const file=path.join(powerRoot(this.profileBase),'vm-manager.json'),current=await readJson(file);
  if(current?.pid===process.pid)await atomicJson(file,{engine:'claude-mcp-v2',powerVersion:POWER_VERSION,pid:process.pid,updatedAt:0,exitPowerError:this.exitPowerError});
 }
}
