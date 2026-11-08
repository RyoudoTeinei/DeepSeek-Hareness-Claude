import {smartSync} from './smart-sync.mjs';
import {returnFiles} from './return-files.mjs';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,renameSync,readFileSync} from 'node:fs';
import path from 'node:path';
const {host,project,identity,action,sessionId,syncSettings,smartSettings,diffPath,choice,expected,items,diffOffset,diffOnly,planToken,createRemote,badgeEntries,files=[],message=''}=JSON.parse(readFileSync(0,'utf8').replace(/^\uFEFF/,''));
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
 if(action==='smart-badges'){
  if(!Array.isArray(badgeEntries)||badgeEntries.length>200)throw Error('工作区列表无效');
  const badges=[];
  for(const entry of badgeEntries){
   if(typeof entry.path!=='string'||!path.isAbsolute(entry.path))continue;
   try{
    const state=smartSync('smart-status',{host:entry.host,project:entry.project,workspacePath:entry.path});
    badges.push({id:entry.id,initialized:state.initialized,running:state.running,starting:state.starting,stopping:state.stopping,differences:state.report?.files.length||0,error:!!state.report?.error});
   }catch{}
  }
  return badges;
 }
 if(['smart-status','smart-start','smart-stop','smart-save','smart-plan','smart-inspect','smart-resolve','smart-resolve-batch','smart-init'].includes(action))return smartSync(action,{host,project,identity,smartSettings,diffPath,choice,expected,items,diffOffset,diffOnly,planToken,createRemote});
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
  const dir=path.join(process.env.LOCALAPPDATA,'DSH-Remote-Claude','chat-routes');mkdirSync(dir,{recursive:true});
  const file=path.join(dir,createHash('sha256').update(sessionId).digest('hex')+'.json'),temp=file+'.'+randomUUID();
  writeFileSync(temp,JSON.stringify({host,project,identity}),{mode:0o600});renameSync(temp,file);return true;
 }
 if(['watch-status','watch-on','watch-off','watch-apply'].includes(action))return returnFiles(action,{host,project,identity,syncSettings});
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
