// Session-scoped executor lifecycle owned by the DSH backend.
import {readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {VMBridge} from './vm-runtime.mjs';
import {assertShareRoot,ensureGuestRunning} from './vm-controller.mjs';
import {atomicJson,readJson} from './desktop-state.mjs';
import {VMPower,POWER_VERSION,powerRoot} from './vm-power.mjs';

// The long-lived DSH backend owns connections. A temporary sync-terminal command
// only writes a connect request; it must not own the executor's process lifetime.
export class VMManager{
 constructor(base=process.env.LOCALAPPDATA){this.profileBase=base;this.base=path.join(powerRoot(base),'desktop');this.bridges=new Map();this.handled=new Map();this.powerHandled=new Set();this.closed=false;this.checking=false;this.power=new VMPower(base,this.bridges,ensureGuestRunning);this.startedAt=Date.now();}
 start(){const tick=()=>void this.tick().catch(error=>{this.backgroundError=String(error.message)});this.timer=setInterval(tick,1000);tick();return this;}
 publish(){
  const task=(this.publishing||Promise.resolve()).catch(()=>{}).then(async()=>{
   const power=await this.power.status();
   await atomicJson(path.join(powerRoot(this.profileBase),'vm-manager.json'),{engine:'claude-mcp-v2',modePolicy:'vm-multi-v1',powerVersion:POWER_VERSION,activeConversations:this.bridges.size,warming:power.state==='starting',guestReady:power.state==='running',power,pid:process.pid,updatedAt:Date.now()});this.lastHeartbeat=Date.now();
  });this.publishing=task;return task;
 }
 async powerRequest(request,folder){
  let response;
  try{
   if(this.closed)throw Error('DSH 后台正在退出');
   const result=request.action==='start'?await this.power.start({createdAt:request.createdAt}):await this.power.shutdown({confirmedConnections:request.confirmedConnections});
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
   const folders=await readdir(this.base,{withFileTypes:true}).catch(()=>[]);
   for(const entry of folders){
    if(!entry.isDirectory()||!/^[a-f0-9]{32}$/.test(entry.name))continue;
    const folder=path.join(this.base,entry.name,'vm');
    const request=await readJson(path.join(folder,'connect-request.json'));
    if(!request||!/^[a-f0-9]{32}$/.test(request.id)||!Number.isSafeInteger(request.createdAt)||request.createdAt<this.startedAt||Date.now()-request.createdAt>120000||request.createdAt>Date.now()+5000||this.handled.get(entry.name)===request.id)continue;
    if(this.bridges.has(entry.name))continue;
    this.handled.set(entry.name,request.id);
    void this.connect(entry.name,folder,request);
   }
  }finally{this.checking=false;}
 }
 async connect(scope,folder,request){
  let bridge;
  try{
   const cfg=await readJson(path.join(folder,'config.json'));
   if(!cfg||cfg.scope!==scope||path.resolve(cfg.stateDirectory)!==path.resolve(folder))throw Error('VM connection binding mismatch');
   const localRoot=await realpath(cfg.localRoot);assertShareRoot(localRoot,path.dirname(cfg.guest.identity));
   if(this.closed)throw Error('DSH 后台正在退出');
   await this.power.connect({createdAt:request.createdAt,explicitWake:request.explicitWake===true},async()=>{
    if(this.closed)throw Error('DSH 后台正在退出');
    bridge=new VMBridge({...cfg,localRoot});this.bridges.set(scope,bridge);
    await bridge.start();
   });
   if(this.closed)await bridge.stop();
   await bridge.done;
   await bridge.stop();
  }catch(error){
   await bridge?.stop();
   await atomicJson(path.join(folder,'status.json'),{status:'failed',scope,updatedAt:Date.now(),error:String(error.message)}).catch(()=>{});
  }finally{if(this.bridges.get(scope)===bridge)this.bridges.delete(scope);}
 }
 async stop(){
  this.closed=true;clearInterval(this.timer);
  try{await this.power.shutdown({allOwned:true,lockTimeout:2500,powerTimeout:10000})}catch(error){this.exitPowerError=String(error.message);await Promise.all([...this.bridges.values()].map(bridge=>bridge.stop()));}
  await this.publishing?.catch(()=>{});
  const file=path.join(powerRoot(this.profileBase),'vm-manager.json'),current=await readJson(file);
  if(current?.pid===process.pid)await atomicJson(file,{engine:'claude-mcp-v2',powerVersion:POWER_VERSION,pid:process.pid,updatedAt:0,exitPowerError:this.exitPowerError});
 }
}
