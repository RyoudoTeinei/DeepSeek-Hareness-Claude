import {spawn,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {openLocalTools} from './local-tools.mjs';
import {decodeLaunch} from './chat-session.mjs';
import {serverTools} from './tool-routing.mjs';
const {action,host,project,identity='',localWorkspace='',tmuxSession,claudeSessionId}=decodeLaunch(process.argv.slice(2));
if(!/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/.test(host)|| !/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,47}$/.test(project))throw Error('SSH 主机或工作区名称无效');
if(identity && !existsSync(identity))throw Error('找不到指定的私钥文件');
const sshOpts=[...(identity?['-o','IdentitiesOnly=yes','-i',identity]:[]),'-o','ServerAliveInterval=20','-o','ServerAliveCountMax=3'];
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
function run(exe,args,capture=false){
 const r=spawnSync(exe,args,{stdio:capture?['inherit','pipe','inherit']:'inherit',encoding:'utf8'});
 if(r.error)throw r.error;
 if(r.status!==0)throw Error(exe+' 执行失败 ('+r.status+')');
 return capture?r.stdout.trim():'';
}
const ssh=(cmd,capture=false,tty=false)=>run('ssh',[...sshOpts,...(tty?['-tt']:['-n']),host,cmd],capture);
const key=createHash('sha256').update(host+'\n'+project).digest('hex').slice(0,16);
const session='dsh-'+key;
const targetSession=tmuxSession||session+'-claude';
const wd='"$HOME/projects/'+project+'"';
const prefix='set -e; umask 077; mkdir -p '+wd+'; cd '+wd+'; ';
const git=(...args)=>run('git',args,true);
let rl;
async function yes(msg){rl ??= createInterface({input:process.stdin,output:process.stdout}); return (await rl.question(msg+' [y/N] ')).trim().toLowerCase()==='y'}
function prepareClaude(name,mode){
 const state='"$HOME/.local/state/dsh-remote/'+name+'-mcp"';
 const runtime=readFileSync(new URL('./session-runtime.py',import.meta.url)).toString('base64');
 const config=Buffer.from(JSON.stringify({name,mode,sessionId:claudeSessionId,serverTools:serverTools.join(',')})).toString('base64');
 ssh(prefix+'mkdir -p '+state+'; printf %s '+quote(runtime)+' | base64 -d > '+state+'/session-runtime.py; python3 '+state+'/session-runtime.py prepare '+quote(config));
 return 'exec python3 '+state+'/session-runtime.py launch';
}
async function attachWithLocalTools(name,mark,start){
 const state='"$HOME/.local/state/dsh-remote/'+name+'-mcp"';
 const local=await openLocalTools(localWorkspace);
 const socketDir='/tmp/dsh-mcp-'+randomUUID().replaceAll('-','');
 const socketFile=socketDir+'/link.sock';
 const peer=readFileSync(new URL('./local-tools-peer.py',import.meta.url)).toString('base64');
 const peerTmp=state+'/peer-'+local.token.slice(0,16)+'.tmp';
 const attach='tmux set-option -t '+name+' mouse on; tmux attach -d -t ='+name;
 try{
  ssh(prefix+'mkdir -p '+state+'; printf %s '+quote(peer)+' | base64 -d > '+peerTmp+
   '; mv -f '+peerTmp+' '+state+'/peer.py; python3 '+state+'/peer.py setup; mkdir -m 700 '+socketDir);
  const cleanup='python3 '+state+'/peer.py disconnect '+quote(socketFile)+' '+quote(local.token)+
   '; rm -f '+socketFile+'; rmdir '+socketDir;
  const connect='set -e; umask 077; trap '+quote(cleanup)+' EXIT; python3 '+state+'/peer.py connect '+
   quote(socketFile)+' '+quote(local.token)+'; '+prefix+
   'if ! tmux has-session -t ='+name+' 2>/dev/null; then '+
   'tmux new-session -d -s '+name+' -c "$PWD" '+quote(start)+' \\; set-option -t '+name+' @dsh-session-runtime 1 \\; set-option -t '+name+' @dsh-execution-mode local; '+
   'touch '+mark+'; fi; '+attach;
  const exit=await new Promise((resolve,reject)=>{
   const child=spawn('ssh',[...sshOpts,'-o','ExitOnForwardFailure=yes','-R',
    socketFile+':127.0.0.1:'+local.port,'-tt',host,connect],{stdio:'inherit'});
   child.once('error',reject);
   child.once('close',resolve);
  });
  if(exit!==0)throw Error('本机工具 SSH 通道关闭，请检查服务器是否允许 Unix 套接字转发。');
 }finally{await local.close()}
}
async function main(){
 if(action==='sync'){
  const ui=spawnSync('powershell.exe',['-NoProfile','-STA','-File',fileURLToPath(new URL('./sync.ps1',import.meta.url))],{stdio:'inherit',env:{...process.env,DSH_SYNC_HOST:host,DSH_SYNC_PROJECT:project,DSH_SYNC_IDENTITY:identity}});
  if(ui.error||ui.status!==0)throw Error(ui.error?.message||'无法打开同步窗口');
  return;
 }
 if(['claude','shell'].includes(action)){
  const name=action==='claude'?targetSession:session+'-shell', mark='"$HOME/.local/state/dsh-remote/'+name+'"';
  // tmux atomically rejects duplicate names; attach only after the winner creates it.
  const start=action==='shell'?'exec bash -l':prepareClaude(name,localWorkspace?'local':'remote');
  const probe=ssh('if tmux has-session -t ='+name+' 2>/dev/null; then echo live; elif test -e '+mark+'; then echo ended; else echo new; fi',true);
  if(action==='claude'&&localWorkspace){
   await attachWithLocalTools(name,mark,start);
   return;
  }
  if(action==='shell'&&probe==='ended'&&!await yes('原会话已结束。启动一个新会话？'))return;
  rl?.close();
  // An explicit reconnect takes over the interactive client, while the Claude
  // process and conversation remain running in the existing tmux session.
  const options=action==='claude'?' \\; set-option -t '+name+' @dsh-session-runtime 1 \\; set-option -t '+name+' @dsh-execution-mode remote':'';
  ssh(prefix+'command -v tmux >/dev/null || { echo "请先在服务器安装 tmux"; exit 1; }; mkdir -p "$HOME/.local/state/dsh-remote"; if ! tmux has-session -t ='+name+' 2>/dev/null; then tmux new-session -d -s '+name+' -c "$PWD" '+quote(start)+options+' || tmux has-session -t ='+name+'; touch '+mark+'; fi; tmux set-option -t '+name+' mouse on; exec tmux attach -d -t ='+name,false,true);return;
 }
 if(action==='image'){
  const tmp=mkdtempSync(path.join(tmpdir(),'dsh-image-')), file=path.join(tmp,'clipboard.png');
  try{
   run('powershell',['-NoProfile','-STA','-Command',"$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; $img=[Windows.Forms.Clipboard]::GetImage(); if(!$img){throw 'Clipboard contains no image'}; $img.Save('"+file.replaceAll("'","''")+"',[Drawing.Imaging.ImageFormat]::Png); $img.Dispose()"]);
   const dest='.local/share/dsh-remote/'+key+'/'+randomUUID()+'.png';
   ssh('umask 077; mkdir -p '+path.posix.dirname(dest));
   run('scp',[...sshOpts,file,host+':'+dest]);
   const full=ssh('realpath '+dest,true);
   const buffer='dsh-image-'+randomUUID();
   ssh('tmux set-buffer -b '+buffer+' -- '+quote(full)+' && tmux paste-buffer -d -p -b '+buffer+' -t ='+targetSession);
   console.log('已插入远程图片路径，回到 Claude 确认发送。');
  }finally{rmSync(tmp,{recursive:true,force:true})}return;
 }
 if(!['status','pull','push'].includes(action))throw Error('未知操作');
 // Direct fetch/push over SSH, no cloud Git credentials or external repository needed.
 const branch=git('symbolic-ref','--short','HEAD'); if(!/^[a-zA-Z0-9_][a-zA-Z0-9_.\/-]*$/.test(branch))throw Error('需要普通命名分支');
 const remote=host+':projects/'+project;
 const sshCmd=['ssh',...sshOpts].map(quote).join(' ');
 const net=(...args)=>git('-c','core.sshCommand='+sshCmd,...args);
 const checkRemote='test "$(git rev-parse --show-toplevel)" = "$(pwd -P)"';
 const remoteStatus=()=>ssh(prefix+checkRemote+' && git status --short --branch',true);
 const localStatus=git('status','--short','--branch');
 console.log('本地 '+localStatus);
 if(action==='push' && await yes('确认 Claude 已停止修改文件；如远端目录为空，初始化仓库？')){
  ssh(prefix+'if test ! -e .git; then test -z "$(ls -A)" || { echo "非空目录不能自动初始化"; exit 1; }; git init -b '+quote(branch)+'; fi; '+checkRemote);
 }
 console.log('服务器 '+remoteStatus());
 if(action==='status')return;
 if(git('status','--porcelain'))throw Error('请先检查并在本地手动提交所需文件；未提交修改已保留。');
 if(action==='push'){
  if(!await yes('将当前分支快进推送到远端同名分支？请确认 Claude 已空闲。'))return;
  ssh(prefix+checkRemote+' && test "$(git symbolic-ref --short HEAD)" = '+quote(branch)+' && test -z "$(git status --porcelain)" && git config receive.denyCurrentBranch updateInstead');
  net('push',remote,'HEAD:refs/heads/'+branch);
 }else{
  if(!await yes('仅拉取服务器已提交的同名分支，快进到本地？'))return;
  net('fetch','--no-tags',remote,'refs/heads/'+branch);git('merge','--ff-only','FETCH_HEAD');
 }
 console.log('同步完成。');
}
try{await main()}catch(e){console.error(e.message);process.exitCode=1}finally{rl?.close()}
