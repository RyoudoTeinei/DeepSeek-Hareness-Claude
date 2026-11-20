import {returnFiles} from './return-files.mjs';
import {desktopScope,desktopDirectory,listDesktopRequests,decideDesktopRequest,readJson} from './desktop-state.mjs';
import {atomicJson} from './desktop-state.mjs';
import {prepareAgent} from './structured-chat.mjs';
import {openDesktopFile} from './desktop-runtime.mjs';
import {connectVM,disconnectVM,vmStatus,vmPowerStatus,requestVMPower} from './vm-controller.mjs';
import {storedRoute,resolveStoredRoute,bindRoute} from './session-binding.mjs';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,renameSync,readFileSync} from 'node:fs';
import path from 'node:path';
const {host,project,identity,action,sessionId,desktopTools=false,structuredChat=false,vmTools=false,remoteModel,turnId,artifactId,requestId,approved,confirmedConnections,confirmedBusy,files=[],message=''}=JSON.parse(readFileSync(0,'utf8').replace(/^\uFEFF/,''));
function execute(exe,args,input){
 const r=spawnSync(exe,args,{encoding:'utf8',input,stdio:['pipe','pipe','pipe'],maxBuffer:32*1024*1024,timeout:120000,windowsHide:true,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
 if(r.error||r.status!==0)throw Error(r.error?.message||r.stderr.trim()||exe+' failed');
 return r.stdout;
}
const git=(...args)=>execute('git',['--literal-pathspecs',...args]);
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
function changes(){
 return git('status','--porcelain=v1','-z','--no-renames','--untracked-files=all').split('\0').filter(Boolean).map(s=>({status:s.slice(0,2),file:s.slice(3)}));
}
function report(stage){if(process.env.DSH_PROGRESS)process.stderr.write('!P:'+stage+'!\r\n')}
async function push(args){
 report('upload');
 const child=spawn('git',args,{windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,LC_ALL:'C',GIT_TERMINAL_PROMPT:'0'}});
 let pending='',err='',last='';
 child.stderr.on('data',buf=>{
  const part=buf.toString();err=(err+part).slice(-4000);
  const lines=(pending+part).split(/[\r\n]/);pending=lines.pop().slice(-2000);
  for(const line of lines){
   const m=/^(Counting objects|Compressing objects|Writing objects):\s*(\d+)%/.exec(line);
   if(!m)continue;const stage=({'Counting objects':'count','Compressing objects':'compress','Writing objects':'upload'})[m[1]]+m[2];
   if(stage!==last){last=stage;report(stage);if(stage==='upload100')report('confirm')}
  }
 });
 await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error(err.trim()||'推送失败')))});
}
async function main(){
 if(action==='workbench-status'){
  const [route,power]=await Promise.all([storedRoute(sessionId),vmPowerStatus()]);
  const empty={status:'idle',events:[],artifacts:[],approvals:[]};
  if(!route)return {activity:empty,power};
  const scope=desktopScope(sessionId,route.host,route.project);
  const [activity,vm]=await Promise.all([
   readJson(path.join(desktopDirectory(scope),'structured','status.json'),empty),
   route.vmTools?vmStatus(scope):null
  ]);
  return {activity:{...activity,vm},power,route};
 }
 if(action==='vm-power-status')return vmPowerStatus();
 if(action==='vm-power-start')return requestVMPower('start');
 if(action==='vm-power-stop')return requestVMPower('stop',confirmedConnections,confirmedBusy);
 if(action==='session-config'){const route=await storedRoute(sessionId);return {bound:!!route,route};}
 if(action==='session-connect'){
  const route=await resolveStoredRoute(sessionId,{host,project,identity,remoteModel,localRoot:path.resolve('.')});
  if(route.vmTools)await connectVM(route,sessionId,route.localRoot,{explicitWake:true});
  return bindRoute(sessionId,route);
 }
 if(['vm-connect','vm-status','vm-disconnect'].includes(action)){
  const scope=desktopScope(sessionId,host,project);
  if(action==='vm-connect')return connectVM({host,project,identity,remoteModel},sessionId,path.resolve('.'),{explicitWake:true});
  if(action==='vm-disconnect')return disconnectVM(scope);
  return vmStatus(scope);
 }
 if(['agent-connect','agent-status','agent-approve','agent-open'].includes(action)){
  const scope=desktopScope(sessionId,host,project);
  const directory=path.join(desktopDirectory(scope),'structured');
  if(action==='agent-connect')await prepareAgent({host,project,identity,vmTools},scope);
  const state=await readJson(path.join(directory,'status.json'),{status:'idle',artifacts:[],events:[],approvals:[]});
  if(action==='agent-approve'){
   if(turnId!==state.turn||!state.approvals.some(item=>item.id===requestId&&item.status==='pending'&&item.source==='panel')||typeof approved!=='boolean')throw Error('审批已过期，请刷新');
   const folder=path.join(directory,'approvals',state.turn);mkdirSync(folder,{recursive:true});
   try{writeFileSync(path.join(folder,requestId+'.json'),JSON.stringify({approved}),{flag:'wx',mode:0o600})}catch(e){if(e.code!=='EEXIST')throw e}
  }
  if(action==='agent-open'){
   const artifact=state.artifacts.find(item=>item.id===artifactId);
   if(!artifact||!artifact.localFile||!path.resolve(artifact.localFile).startsWith(path.resolve(directory)+path.sep))throw Error('成果文件无效');
   if(!/\.(pdf|docx|xlsx|pptx|png|jpe?g|webp|txt|md|csv)$/i.test(artifact.localFile))throw Error('此类型请从保存位置手动处理');
   await openDesktopFile(artifact.localFile);
  }
  if(vmTools)state.vm=await vmStatus(scope);
  return state;
 }
 if(action==='desktop-list'||action==='desktop-decide'){
  const directory=desktopDirectory(desktopScope(sessionId,host,project));
  if(action==='desktop-decide')await decideDesktopRequest(directory,requestId,approved);
  const connection=await readJson(path.join(directory,'connection.json'),{state:'disconnected'});
  if(connection.state==='connected'){
   try{process.kill(connection.pid,0)}catch{connection.state='disconnected'}
  }
  return {connection:connection.state,requests:await listDesktopRequests(directory)};
 }
 if(action==='quota'||action==='quota-enable'){
  if(!/^[\w][\w.@-]*$/.test(host)||typeof identity!=='string')throw Error('SSH 配置无效');
  const args=['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8',...(identity?['-o','IdentitiesOnly=yes','-i',identity]:[]),host];
  if(action==='quota-enable'){
   const install=`set -e; tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT; cat > "$tmp"; python3 "$tmp" install`;
   execute('ssh',[...args,install],readFileSync(new URL('./quota.py',import.meta.url)));
  }
  const probe='cd "$HOME/.local/state/dsh-remote" 2>/dev/null && test -f quota.py || { echo null; exit 0; }; if test -s quota.json; then cat quota.json; else echo "{}"; fi';
  return JSON.parse(execute('ssh',[...args,probe]));
 }
 if(action==='bind-chat'){
  if(!/^[\w.-]{1,180}$/.test(sessionId)|| !/^[\w][\w.@-]*$/.test(host)||!/^\w[\w-]{0,47}$/.test(project)||typeof identity!=='string')throw Error('会话绑定信息无效');
  await bindRoute(sessionId,{host,project,identity,localRoot:path.resolve('.'),remoteModel});return true;
 }
 if(['watch-status','watch-on','watch-off'].includes(action))return returnFiles(action,{host,project,identity});
 if(path.resolve(git('rev-parse','--show-toplevel').trim()).toLowerCase()!==path.resolve('.').toLowerCase())throw Error('请在 Git 仓库根目录打开工作区。');
 const branch=git('symbolic-ref','--short','HEAD').trim();
 if(action==='list')return {branch,changes:changes()};
 if(!/^[\w][\w.@-]*$/.test(host)||!/^\w[\w-]{0,47}$/.test(project)||!/^[a-zA-Z0-9_][\w./-]*$/.test(branch))throw Error('SSH 或分支设置无效');
 const opts=['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10',...(identity?['-o','IdentitiesOnly=yes','-i',identity]:[])];
 const dest=host+':projects/'+project;
 const sshCmd=['ssh',...opts].map(quote).join(' ');
 const net=(...args)=>git('-c','core.sshCommand='+sshCmd,...args);
 if(action==='pull'){
  if(changes().length)throw Error('本地有修改，已暂停拉取。请先处理本地变更。');
  net('fetch','--no-tags',dest,'refs/heads/'+branch);return git('merge','--ff-only','FETCH_HEAD').trim();
 }
 if(action!=='push')throw Error('未知操作');
 const cwd='"$HOME/projects/'+project+'"';
 report('check');
 // Untracked server outputs do not block unrelated uploads. Git updateInstead
 // still rejects tracked edits and any untracked path an upload would overwrite.
 execute('ssh',[...opts,host,'set -e; umask 077; mkdir -p '+cwd+'; cd '+cwd+'; if test ! -e .git; then test -z "$(ls -A)" || { echo "Remote directory is not empty" >&2; exit 1; }; git init -b '+quote(branch)+'; fi; test "$(git rev-parse --show-toplevel)" = "$(pwd -P)" || { echo "服务器目录不是 Git 仓库根目录" >&2; exit 1; }; test "$(git symbolic-ref --short HEAD)" = '+quote(branch)+' || { echo "服务器分支与本地分支不一致，请先核对分支" >&2; exit 1; }; test -z "$(git status --porcelain --untracked-files=no)" || { echo "服务器已有已跟踪文件的未提交改动，请先处理后再推送" >&2; git status --short --untracked-files=no >&2; exit 1; }; git config receive.denyCurrentBranch updateInstead']);
 if(files.length){
  report('scan');
  const current=new Map(changes().map(x=>[x.file,x.status]));
  if(!message.trim()||files.some(f=>!current.has(f)))throw Error('请刷新文件列表并填写提交说明。');
  if(files.some(f=>current.get(f)==='UU'||current.get(f).includes('U')||['AA','DD'].includes(current.get(f))))throw Error('请先解决合并冲突。');
  const paths=files.join('\0')+'\0';
  const add=files.filter(f=>current.get(f)==='??');
  if(add.length)execute('git',['--literal-pathspecs','add','--intent-to-add','--pathspec-from-file=-','--pathspec-file-nul'],add.join('\0')+'\0');
  report('commit');
  execute('git',['--literal-pathspecs','commit','--only','-m',message,'--pathspec-from-file=-','--pathspec-file-nul'],paths);
 }
 await push(['-c','core.sshCommand='+sshCmd,'push','--progress',dest,'HEAD:refs/heads/'+branch]);
 return '已推送 '+git('rev-parse','--short','HEAD').trim()+' 到 '+branch;
}
try{console.log(JSON.stringify({ok:true,result:await main()}))}catch(e){console.log(JSON.stringify({ok:false,error:e.message}));process.exitCode=1}
