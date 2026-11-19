import {readFile,writeFile,mkdir,realpath,lstat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
import {desktopScope,desktopDirectory,readJson,atomicJson} from './desktop-state.mjs';
import {validateVMConfig,probeVMIdentity} from './vm-runtime.mjs';
import {POWER_VERSION,powerRoot,loadPowerProfile,probePower} from './vm-power.mjs';

const registry=()=>path.join(process.env.LOCALAPPDATA,'DSH-Remote-Claude','vm-executor.json');
const directory=scope=>path.join(desktopDirectory(scope),'vm');
async function guestPortOpen(port){
 return new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});const done=value=>{socket.destroy();resolve(value)};socket.setTimeout(700,()=>done(false));socket.once('connect',()=>done(true));socket.once('error',()=>done(false));});
}
export async function ensureGuestRunning(profile){
 if(!await guestPortOpen(profile.guest.port)){
  if(process.platform!=='win32'||!profile.startScript)throw Error('本地虚拟机未启动，请先启动独立执行环境');
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',profile.startScript,'-Network','isolated'],{windowsHide:true,stdio:'ignore'});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});
  if(code!==0)throw Error('独立虚拟机未能启动，请检查执行器日志');
 }
 const deadline=Date.now()+45000;
 while(Date.now()<deadline){
  let identity;try{identity=await probeVMIdentity(profile.guest)}catch{}
  if(identity){if(identity!==profile.guest.instanceId)throw Error('虚拟机身份不匹配');return;}
  await new Promise(resolve=>setTimeout(resolve,700));
 }
 throw Error('虚拟机 SSH 尚未就绪，请稍后重试');
}
function contains(parent,child){const relative=path.relative(parent.toLowerCase(),child.toLowerCase());return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));}
export function assertShareRoot(root,privateDirectory){
 if(!path.isAbsolute(root)||path.parse(root).root===root)throw Error('请选择具体项目目录');
 const home=os.homedir();
 const protectedPaths=[home,path.join(home,'.claude'),path.join(home,'.ssh'),path.join(home,'.dsh'),path.join(home,'.codex'),path.join(home,'.aws'),path.join(home,'.gnupg'),path.join(home,'.claude.json'),
  path.join(home,'AppData'),privateDirectory];
 if(root.toLowerCase()===home.toLowerCase()||protectedPaths.slice(1).some(value=>contains(root,value)||contains(value,root)))throw Error('此目录包含个人配置、凭据或虚拟机控制文件，不能共享');
}
export async function vmStatus(scope){
 const state=await readJson(path.join(directory(scope),'status.json'),{status:'offline'});
 if(['connected','running','connecting'].includes(state.status)&&Date.now()-(state.updatedAt||0)>20000)return {...state,status:'offline'};
 return state;
}
export async function disconnectVM(scope){
 const state=await vmStatus(scope);
 if(state.connectionId)await atomicJson(path.join(directory(scope),'control.json'),{action:'disconnect',connectionId:state.connectionId});
 return {status:'disconnecting'};
}
async function readyPowerManager(){
 const managerFile=path.join(process.env.LOCALAPPDATA,'DSH-Remote-Claude','vm-manager.json');
 const manager=await readJson(managerFile);
 if(manager?.engine!=='claude-mcp-v2'||manager.powerVersion!==POWER_VERSION||Date.now()-(manager.updatedAt||0)>20000)throw Error('请先重启 DSH，加载虚拟机电源控制后台，再操作。');
 return manager;
}
export async function vmPowerStatus(){
 const base=process.env.LOCALAPPDATA,manager=await readJson(path.join(powerRoot(base),'vm-manager.json'));
 if(manager?.powerVersion===POWER_VERSION&&Date.now()-(manager.updatedAt||0)<15000&&manager.power)return {...manager.power,controlReady:true};
 try{const profile=await loadPowerProfile(base),policy=await readJson(path.join(path.dirname(profile.guest.identity),'power-policy.json'),{});return {...await probePower(profile),manualOff:!!policy.manualOff,memoryMiB:profile.vm.memoryMiB,cpus:profile.vm.cpus,connections:[],controlReady:false};}
 catch(error){return {state:'unavailable',connections:[],controlReady:false,error:error.message};}
}
export async function requestVMPower(action,confirmedConnections){
 await readyPowerManager();
 if(!['start','stop'].includes(action))throw Error('虚拟机电源操作无效');
 if(confirmedConnections!==undefined&&(!Array.isArray(confirmedConnections)||confirmedConnections.length>100||confirmedConnections.some(id=>typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id))))throw Error('会话确认信息无效');
 const id=randomBytes(16).toString('hex'),folder=path.join(powerRoot(process.env.LOCALAPPDATA),'power-requests');
 await atomicJson(path.join(folder,id+'.json'),{id,action,confirmedConnections,createdAt:Date.now()});
 const deadline=Date.now()+120000;
 while(Date.now()<deadline){const result=await readJson(path.join(folder,id+'.result.json'));if(result){if(!result.ok)throw Error(result.error);return result.result;}await new Promise(r=>setTimeout(r,250));}
 throw Error('电源操作尚未确认完成，请刷新状态，不要连续重复提交。');
}
export async function connectVM(route,sessionId,localRoot,options={}){
 await readyPowerManager();
 const scope=desktopScope(sessionId,route.host,route.project),folder=directory(scope);
 const existing=await vmStatus(scope);
 const profile=await readJson(registry());
 if(!profile?.guest)throw Error('本地虚拟机执行器未配置，请先安装并验证独立执行环境');
 const vm=JSON.parse((await readFile(profile.vmStatePath,'utf8')).replace(/^\uFEFF/,''));
 if(vm.network!=='isolated'||vm.instanceId!==profile.guest.instanceId)throw Error('虚拟机身份或网络隔离状态不符，请检查执行器配置');
 const root=await realpath(localRoot);assertShareRoot(root,path.dirname(profile.guest.identity));
 const previous=await readJson(path.join(folder,'config.json'));
 if(previous&&path.resolve(previous.localRoot).toLowerCase()!==root.toLowerCase())throw Error('此聊天已经绑定另一本地目录，请在新聊天连接新的项目');
 if(previous&&previous.vmEngine!=='claude-mcp-v2')throw Error('此聊天使用旧版虚拟机执行器，请在新聊天启用虚拟机 CC；旧会话已保留。');
 if(['connected','running'].includes(existing.status))return existing;
 const cfg=validateVMConfig({scope,cloud:{host:route.host,identity:route.identity||''},guest:{...profile.guest,root:'/workspaces/'+scope},localRoot:root,stateDirectory:folder,hostPython:profile.hostPython,network:'isolated',nativeChat:true,vmEngine:'claude-mcp-v2',project:route.project,remoteModel:route.remoteModel||''});
 await mkdir(folder,{recursive:true});await atomicJson(path.join(folder,'config.json'),cfg);
 const started=Date.now();
 await atomicJson(path.join(folder,'connect-request.json'),{id:randomBytes(16).toString('hex'),createdAt:started,explicitWake:options.explicitWake===true});
 while(Date.now()-started<120000){
  const current=await vmStatus(scope);
  if(current.updatedAt>=started){
   if(['connected','running'].includes(current.status))return current;
   if(['failed','offline'].includes(current.status))throw Error(current.error||'本地虚拟机连接失败；请检查执行器是否已启动');
  }
  await new Promise(resolve=>setTimeout(resolve,300));
 }
 throw Error('连接本地虚拟机超时，请确认 DSH 已加载新版插件服务及执行器已启动');
}
export async function stageVMAttachment(scope,expectedRoot,name,data){
 const cfg=await readJson(path.join(directory(scope),'config.json'));
 const state=await vmStatus(scope);
 if(!cfg||!['connected','running'].includes(state.status))throw Error('本地虚拟机已离线，请先重新连接');
 const root=await realpath(expectedRoot);
 if(root.toLowerCase()!==(await realpath(cfg.localRoot)).toLowerCase())throw Error('本地项目绑定已变化，请重新连接');
 if(path.basename(name)!==name||/[\\/:\x00-\x1f]/.test(name))throw Error('附件名称无效');
 const sha=createHash('sha256').update(data).digest('hex');
 let folder=root;
 for(const part of ['.dsh-attachments',sha]){
  folder=path.join(folder,part);await mkdir(folder,{recursive:true});
  if((await lstat(folder)).isSymbolicLink()||!contains(root,await realpath(folder)))throw Error('附件目录不能是链接');
 }
 const file=path.join(folder,name);
 try{await writeFile(file,data,{flag:'wx',mode:0o400})}
 catch(error){
  if(error.code!=='EEXIST')throw error;
  if((await lstat(file)).isSymbolicLink()||createHash('sha256').update(await readFile(file)).digest('hex')!==sha)throw Error('附件存储校验失败');
 }
 return '.dsh-attachments/'+sha+'/'+name;
}
import {spawn} from 'node:child_process';
import net from 'node:net';
