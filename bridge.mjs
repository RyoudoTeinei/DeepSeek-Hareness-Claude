import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
const [action,host,project,identity='']=process.argv.slice(2);
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
const ssh=(cmd,capture=false,tty=false)=>run('ssh',[...sshOpts,...(tty?['-tt']:[]),host,cmd],capture);
const key=createHash('sha256').update(host+'\n'+project).digest('hex').slice(0,16);
const session='dsh-'+key;
const wd='"$HOME/projects/'+project+'"';
const prefix='set -e; umask 077; mkdir -p '+wd+'; cd '+wd+'; ';
const git=(...args)=>run('git',args,true);
let rl;
async function yes(msg){rl ??= createInterface({input:process.stdin,output:process.stdout}); return (await rl.question(msg+' [y/N] ')).trim().toLowerCase()==='y'}
async function main(){
 if(action==='sync'){
  const ui=spawnSync('powershell.exe',['-NoProfile','-STA','-File',fileURLToPath(new URL('./sync.ps1',import.meta.url))],{stdio:'inherit',env:{...process.env,DSH_SYNC_HOST:host,DSH_SYNC_PROJECT:project,DSH_SYNC_IDENTITY:identity}});
  if(ui.error||ui.status!==0)throw Error(ui.error?.message||'无法打开同步窗口');
  return;
 }
 if(['claude','shell'].includes(action)){
  const name=session+'-'+action, mark='"$HOME/.local/state/dsh-remote/'+name+'"';
  // tmux atomically rejects duplicate names; attach only after the winner creates it.
  const start=action==='shell'?'exec bash -l':'export PATH="$HOME/.local/bin:$PATH"; exec claude';
  const probe=ssh('if tmux has-session -t ='+name+' 2>/dev/null; then echo live; elif test -e '+mark+'; then echo ended; else echo new; fi',true);
  if(probe==='ended'&&!await yes('原会话已结束。启动一个新会话？'))return;
  rl?.close();
  // An explicit reconnect takes over the interactive client, while the Claude
  // process and conversation remain running in the existing tmux session.
  ssh(prefix+'command -v tmux >/dev/null || { echo "请先在服务器安装 tmux"; exit 1; }; mkdir -p "$HOME/.local/state/dsh-remote"; if ! tmux has-session -t ='+name+' 2>/dev/null; then tmux new-session -d -s '+name+' -c "$PWD" '+quote(start)+' || tmux has-session -t ='+name+'; touch '+mark+'; fi; tmux set-option -t '+name+' mouse on; exec tmux attach -d -t ='+name,false,true);return;
 }
 if(action==='image'){
  const tmp=mkdtempSync(path.join(tmpdir(),'dsh-image-')), file=path.join(tmp,'clipboard.png');
  try{
   run('powershell',['-NoProfile','-STA','-Command',"$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; $img=[Windows.Forms.Clipboard]::GetImage(); if(!$img){throw 'Clipboard contains no image'}; $img.Save('"+file.replaceAll("'","''")+"',[Drawing.Imaging.ImageFormat]::Png); $img.Dispose()"]);
   const dest='.local/share/dsh-remote/'+key+'/'+randomUUID()+'.png';
   ssh('umask 077; mkdir -p '+path.posix.dirname(dest));
   run('scp',[...sshOpts,file,host+':'+dest]);
   const full=ssh('realpath '+dest,true);
   ssh('tmux set-buffer -b '+key+' -- '+quote(full)+' && tmux paste-buffer -d -p -b '+key+' -t ='+session+'-claude');
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
