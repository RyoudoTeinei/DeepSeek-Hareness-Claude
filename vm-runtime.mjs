import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomBytes,createHash} from 'node:crypto';
import {readFile,mkdir,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PassThrough,Writable} from 'node:stream';
import {atomicJson,readJson} from './desktop-state.mjs';
import {sshArguments} from './desktop-runtime.mjs';
import {NativeVMClient,VM_EXECUTOR_VERSION} from './vm-native.mjs';

export const VM_CLOUD_ROOT='.local/state/dsh-remote/vm-native-v2';

const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const here=fileURLToPath(new URL('.',import.meta.url));
const liveBridges=new Map();
export function vmChatConnection(scope){const bridge=liveBridges.get(scope);if(!bridge||bridge.closed)throw Error('本地虚拟机后台连接不可用，请重新接入');return bridge.openChat();}
export function validateVMConfig(cfg){
 if(!cfg||!/^\w[\w.@-]*$/.test(cfg.cloud?.host)||!/^[a-f0-9]{32}$/.test(cfg.scope))throw Error('Invalid cloud VM bridge binding');
 const guest=cfg.guest;
 if(!guest||guest.host!=='127.0.0.1'||!Number.isSafeInteger(guest.port)||guest.port<1024||guest.port>65535||guest.user!=='dshvm')throw Error('Only the dedicated loopback VM is supported');
 if(!/^[a-f0-9-]{36}$/.test(guest.instanceId)||guest.root!=='/workspaces/'+cfg.scope)throw Error('Invalid guest workspace');
 for(const key of ['identity','knownHosts'])if(typeof guest[key]!=='string'||!path.isAbsolute(guest[key]))throw Error('Guest SSH files must be absolute');
 for(const key of ['localRoot','stateDirectory','hostPython'])if(typeof cfg[key]!=='string'||!path.isAbsolute(cfg[key]))throw Error('VM paths must be absolute');
 if(cfg.network!=='isolated')throw Error('VM must be switched to isolated networking before exposing tools');
 if(cfg.nativeChat&&(!/^\w[\w-]{0,47}$/.test(cfg.project)||!['','sonnet','opus','haiku'].includes(cfg.remoteModel||'')))throw Error('Invalid native VM chat configuration');
 return cfg;
}

export function guestSSHArguments(guest){
 return ['-F','none','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','IdentityAgent=none','-o','IdentitiesOnly=yes',
  '-o','SendEnv=-*','-o','ConnectTimeout=8','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2',
  '-o','UserKnownHostsFile='+guest.knownHosts,'-i',guest.identity,'-p',String(guest.port),'-T',guest.user+'@'+guest.host];
}

function processRun(exe,args,input='',timeout=30000){
 const child=spawn(exe,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let output='',error='';
 child.stdin.on('error',()=>{});
 child.stdout.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>8*1024*1024)child.kill()});
 child.stderr.on('data',chunk=>{error=(error+chunk).slice(-1500)});
 const completion=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve(output):reject(Error(error||'Bridge subprocess failed')))});
 const timer=setTimeout(()=>child.kill(),timeout);
 child.stdin.end(input);
 return completion.finally(()=>clearTimeout(timer));
}
export async function probeVMIdentity(guest){return (await processRun('ssh',[...guestSSHArguments(guest),'cat /etc/dsh-vm-executor'],'',10000)).trim();}

export async function prepareVMCloud(cfg){
 validateVMConfig(cfg);await mkdir(cfg.stateDirectory,{recursive:true});
 let binding=await readJson(path.join(cfg.stateDirectory,'binding.json'));
 if(!binding){binding={token:randomBytes(32).toString('hex'),instanceId:cfg.guest.instanceId};await atomicJson(path.join(cfg.stateDirectory,'binding.json'),binding);}
 if(binding.instanceId!==cfg.guest.instanceId)throw Error('VM identity changed; use a new bridge binding');
 const sources={};for(const name of ['vm-relay.py','vm-mcp.py'])sources[name]=await readFile(path.join(here,name),'utf8');
 const nativeSources={};if(cfg.nativeChat)for(const name of ['structured-peer.py','native-peer.py','chat-peer.py'])nativeSources[name]=await readFile(path.join(here,name),'utf8');
 const sessionPolicy=await readFile(path.join(here,'vm-session.py'),'utf8');
 const script=`import pathlib,json,sys,os,tempfile,subprocess,importlib.util
os.umask(0o077)
p=json.load(sys.stdin)
root=pathlib.Path.home()/p['cloudRoot']
capabilities=root/'sessions'/p['scope']/'native-capabilities.json'
cap=json.loads(capabilities.read_text()) if capabilities.exists() else {}
prior=root/'sessions'/p['scope']/'binding.json'
prior=json.loads(prior.read_text()) if prior.exists() else {}
policy={};exec(p['sessionPolicy'],policy)
terminal=policy['choose_terminal'](p['scope'],cap,prior,lambda name:subprocess.run(['tmux','has-session','-t','='+name],capture_output=True).returncode==0)
root.mkdir(parents=True,exist_ok=True)
for name,content in p['sources'].items():
 with tempfile.NamedTemporaryFile(dir=root,mode='w',encoding='utf-8',delete=False) as f:f.write(content);temporary=f.name
 os.replace(temporary,root/name)
state=root/'sessions'/p['scope'];state.mkdir(parents=True,exist_ok=True)
target=state/'binding.json'
existing=json.loads(target.read_text()) if target.exists() else {}
if existing and existing.get('token')!=p['binding']['token']:raise ValueError('Existing bridge binding differs')
if p['nativeChat'] and existing.get('project',p['project'])!=p['project']:raise ValueError('Native project binding differs')
existing.update(p['binding'])
with tempfile.NamedTemporaryFile(dir=state,mode='w',delete=False) as f:json.dump(existing,f);temporary=f.name
os.replace(temporary,target)
if p['nativeChat']:
 native_root=root
 for name,content in p['nativeSources'].items():
  with tempfile.NamedTemporaryFile(dir=native_root,mode='w',encoding='utf-8',delete=False) as f:f.write(content);temporary=f.name
  os.replace(temporary,native_root/name)
 state=native_root/'sessions'/p['scope'];state.mkdir(parents=True,exist_ok=True)
 file=state/'binding.json'
 if file.exists() and json.loads(file.read_text()).get('project',p['project'])!=p['project']:raise ValueError('Native project binding differs')
 previous=json.loads(file.read_text()) if file.exists() else {}
 previous.update({'project':p['project'],'vmTools':True,'vmEngine':'claude-mcp-v2','terminal':terminal,'token':p['binding']['token'],'instanceId':p['binding']['instanceId']})
 with tempfile.NamedTemporaryFile(dir=state,mode='w',delete=False) as f:json.dump(previous,f);temporary=f.name
 os.replace(temporary,file)
 spec=importlib.util.spec_from_file_location('native_vm_bootstrap',native_root/'native-peer.py');native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
 if native.existing_session(p['scope']):native.verify_running_mode(state)
print('ready')`;
 await processRun('ssh',[...sshArguments(cfg.cloud),'-T',cfg.cloud.host,'python3 -c '+quote(script)],JSON.stringify({scope:cfg.scope,binding,sources,nativeSources,nativeChat:!!cfg.nativeChat,project:cfg.project,model:cfg.remoteModel||'',cloudRoot:VM_CLOUD_ROOT,sessionPolicy}),60000);
}

export class VMBridge{
 constructor(cfg){this.cfg=validateVMConfig(cfg);this.children=new Set();this.queue=Promise.resolve();this.closed=false;this.connectionId=randomBytes(16).toString('hex');this.stateWrites=Promise.resolve();this.chats=new Map();}
 openChat(){
  const id=randomBytes(16).toString('hex'),stdout=new PassThrough();let resolve,reject,started=false;
  const done=new Promise((a,b)=>{resolve=a;reject=b});done.catch(()=>{});
  const finish=(code,error)=>{if(child.exitCode!==null)return;child.exitCode=code;stdout.end();this.chats.delete(id);code===0?resolve():reject(Error(error||'云端会话通道中断，请检查已保存结果'));};
  const stdin=new Writable({write:(chunk,encoding,callback)=>{
   try{
    const value=JSON.parse(chunk.toString());
    if(!started){started=true;this.relay.stdin.write(JSON.stringify({type:'chat_start',id,wire:value})+'\n');}
    else if(value.type==='cancel'){void this.native.cancelForeground().catch(()=>{});this.relay.stdin.write(JSON.stringify({type:'chat_cancel',id})+'\n');}
    callback();
   }catch(error){callback(error);finish(1,error.message)}
  }});stdin.on('error',()=>{});
  const child={stdin,stdout,exitCode:null,kill:()=>{void this.native.cancelForeground().catch(()=>{});if(!this.relay.stdin.destroyed)this.relay.stdin.write(JSON.stringify({type:'chat_cancel',id})+'\n');finish(1,'本轮连接已停止')}};
  this.chats.set(id,{stdout,finish});return {child,done};
 }
 async state(status,extra={}){
  this.lastState={status,...(this.native?.info?{executor:'claude-mcp',executorVersion:VM_EXECUTOR_VERSION,authenticated:false,isolatedSession:true}:{}),...extra};
  const snapshot={...this.lastState,pid:process.pid,scope:this.cfg.scope,connectionId:this.connectionId,updatedAt:Date.now()};
  this.stateWrites=this.stateWrites.then(()=>atomicJson(path.join(this.cfg.stateDirectory,'status.json'),snapshot));await this.stateWrites;
 }
 async mount(){
  const {guest,localRoot,hostPython}=this.cfg;
  const identity=await processRun('ssh',[...guestSSHArguments(guest),'cat /etc/dsh-vm-executor']);
  if(identity.trim()!==guest.instanceId)throw Error('Guest identity mismatch');
  const root=quote(guest.root);
  await processRun('ssh',[...guestSSHArguments(guest),`if mountpoint -q ${root}; then echo 'Guest workspace is already mounted' >&2; exit 1; fi; mkdir -p ${root}`]);
  const ssh=spawn('ssh',[...guestSSHArguments(guest),`exec sshfs -f :/ ${root} -o slave,cache=no,nodev,nosuid`],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const files=spawn(hostPython,[path.join(here,'vm-sftp.py'),'--root',localRoot],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  for(const child of [ssh,files]){this.children.add(child);child.stdin.on('error',()=>{});child.stderr.on('data',data=>process.stderr.write(data));child.on('error',error=>{this.failure='Workspace transport failed';process.stderr.write(error.message+'\n');void this.stop()});}
  ssh.stdout.pipe(files.stdin);files.stdout.pipe(ssh.stdin);
  ssh.once('close',code=>{files.kill();if(!this.closed){this.failure='Guest workspace connection closed ('+code+')';void this.stop()}});files.once('close',code=>{ssh.kill();if(!this.closed){this.failure='Local file share closed ('+code+')';void this.stop()}});
  await processRun('ssh',[...guestSSHArguments(guest),`for i in $(seq 1 40); do if mountpoint -q ${root} && test -d ${root}; then exit 0; fi; sleep .2; done; exit 1`],'',15000);
  if(this.closed)throw Error('Workspace mount disconnected');
 }
 async execute(frame){
  if(this.closed)return {id:frame.id,ok:false,error:'Local VM is offline'};
  if(!/^[a-f0-9]{32}$/.test(frame.id)||frame.operation!=='mcp'||!frame.arguments||typeof frame.arguments!=='object')throw Error('Invalid VM request');
  const file=path.join(this.cfg.stateDirectory,'requests',frame.id+'.json');
  const fingerprint=createHash('sha256').update(JSON.stringify([frame.operation,frame.arguments])).digest('hex');
  const previous=await readJson(file);
  if(previous){
   if(previous.fingerprint!==fingerprint)return {id:frame.id,ok:false,error:'Request ID reused with different input'};
   return previous.response||{id:frame.id,ok:false,error:'Previous execution outcome is unknown; inspect files before retrying'};
  }
  await atomicJson(file,{fingerprint,status:'running'});await this.state('running',{operation:frame.operation,requestId:frame.id});
  let response;
  try{
   response={id:frame.id,ok:true,result:await this.native.request(frame.arguments)};
  }catch{response={id:frame.id,ok:false,error:'The local VM did not confirm this operation. It may have partially executed; check the workspace before retrying.'};}
  await atomicJson(file,{fingerprint,status:'completed',response});await this.state(this.closed?'offline':'connected');
  return response;
 }
 async start(){
  await mkdir(this.cfg.stateDirectory,{recursive:true});
  const oldLease=await readJson(path.join(path.dirname(this.cfg.guest.identity),'bridge.lock'));
  if(oldLease){let active=true;try{process.kill(oldLease.pid,0)}catch(error){if(error.code==='ESRCH')active=false;}if(active)throw Error('旧版单会话执行器仍在运行，请重启 DSH 后使用多会话。');}
  this.lease=path.join(path.dirname(this.cfg.guest.identity),'bridges',this.cfg.scope+'.lock');
  await mkdir(path.dirname(this.lease),{recursive:true});
  const previous=await readJson(this.lease);
  if(previous){
   let running=true;try{process.kill(previous.pid,0)}catch(error){if(error.code==='ESRCH')running=false;}
   if(running)throw Error('本聊天的执行器已由另一个后台连接持有，请重连原聊天。');
   await unlink(this.lease);
  }
  await writeFile(this.lease,JSON.stringify({pid:process.pid,scope:this.cfg.scope}),{flag:'wx',mode:0o600});this.ownsLease=true;
  await this.state('connecting');await this.mount();
  this.native=new NativeVMClient(this.cfg.guest,guestSSHArguments);await this.native.start();
  this.native.done.then(()=>{if(!this.closed){this.failure='VM native tools disconnected';void this.stop()}});
  await prepareVMCloud(this.cfg);
  const relay=spawn('ssh',[...sshArguments(this.cfg.cloud),'-T',this.cfg.cloud.host,'python3 "$HOME/'+VM_CLOUD_ROOT+'/vm-relay.py" '+this.cfg.scope],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  this.relay=relay;this.children.add(relay);relay.stdin.on('error',()=>{});relay.stderr.on('data',data=>process.stderr.write(data));
  this.done=new Promise(resolve=>relay.once('close',code=>{if(!this.closed)this.failure='Cloud relay connection closed ('+code+')';void this.stop();resolve()}));
  const lines=createInterface({input:relay.stdout});
  const ready=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Cloud VM relay did not become ready')),20000);
   relay.once('error',error=>{clearTimeout(timer);reject(error)});
   relay.once('close',()=>{clearTimeout(timer);reject(Error('Cloud VM relay disconnected'))});
   lines.on('line',line=>{
    try{
     const frame=JSON.parse(line);
     if(frame.type==='ready'){clearTimeout(timer);resolve();}
     else if(frame.type==='chat_frame'){const chat=this.chats.get(frame.id);if(chat)chat.stdout.write('DSH_AGENT:'+JSON.stringify(frame.frame)+'\n');}
     else if(frame.type==='chat_end')this.chats.get(frame.id)?.finish(frame.code,frame.error);
     else if(frame.type==='error'){clearTimeout(timer);reject(Error(frame.message));}
     else if(frame.type==='request'){
      void this.execute(frame).catch(()=>({id:frame.id,ok:false,error:'VM bridge rejected this request'})).then(response=>{if(!relay.stdin.destroyed)relay.stdin.write(JSON.stringify(response)+'\n')});
     }
    }catch{void this.stop()}
   });
  });
  await ready;
  if(this.cfg.nativeChat)await processRun('ssh',[...sshArguments(this.cfg.cloud),'-T',this.cfg.cloud.host,'python3 "$HOME/'+VM_CLOUD_ROOT+'/native-peer.py" ensure '+this.cfg.scope+' '+quote(this.cfg.remoteModel||'')],'',60000);
  liveBridges.set(this.cfg.scope,this);await this.state('connected',{executor:'claude-mcp',executorVersion:VM_EXECUTOR_VERSION,authenticated:false});
  this.controlTimer=setInterval(async()=>{
   const control=await readJson(path.join(this.cfg.stateDirectory,'control.json'));
   if(control?.action==='disconnect'&&control.connectionId===this.connectionId)await this.stop();
  },500);
  this.heartbeat=setInterval(()=>{if(!this.closed)void this.state(this.lastState.status,this.lastState).catch(()=>this.stop())},5000);
  return this;
 }
 stop(){
  if(this.stopPromise)return this.stopPromise;
  this.closed=true;
  this.stopPromise=this.shutdown();return this.stopPromise;
 }
 async shutdown(){
  await this.state('disconnecting').catch(()=>{});
  if(liveBridges.get(this.cfg.scope)===this)liveBridges.delete(this.cfg.scope);
  for(const chat of [...this.chats.values()])chat.finish(1,'虚拟机桥接已断开，本轮结果可能尚未确认');
  clearInterval(this.controlTimer);clearInterval(this.heartbeat);
  await this.native?.stop();
  for(const child of this.children)child.kill();
  if(this.ownsLease){const lease=await readJson(this.lease);if(lease?.pid===process.pid&&lease.scope===this.cfg.scope)await unlink(this.lease).catch(()=>{});this.ownsLease=false;}
  await this.state('offline',this.failure?{error:this.failure}:{}).catch(()=>{});
 }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let bridge;
 try{
  const cfg=JSON.parse(await readFile(process.argv[2],'utf8'));bridge=new VMBridge(cfg);
  for(const name of ['SIGINT','SIGTERM'])process.on(name,()=>void bridge.stop());
  await bridge.start();process.stdout.write('VM_BRIDGE_READY\n');await bridge.done;
 }catch(error){await bridge?.stop();await bridge?.state('failed',{error:String(error.message)});process.stderr.write(String(error.message)+'\n');process.exitCode=1;}
}
