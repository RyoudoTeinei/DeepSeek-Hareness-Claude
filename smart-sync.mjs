import {spawn,spawnSync} from 'node:child_process';
import {readdirSync,mkdirSync,readFileSync,writeFileSync,renameSync,existsSync,unlinkSync,statSync,realpathSync,cpSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {returnFiles} from './return-files.mjs';

export const defaultPresets=[
 {name:'代码和文档',extensions:['.py','.js','.ts','.tsx','.jsx','.md','.txt','.json','.yaml','.yml','.toml','.sh','.bat','.cmd'],enabled:true,max_mib:10},
 {name:'图片和 PDF',extensions:['.png','.jpg','.jpeg','.webp','.gif','.pdf'],enabled:true,max_mib:25},
 {name:'模型权重',extensions:['.pt','.pth','.ckpt','.safetensors','.gguf'],enabled:false,max_mib:100},
 {name:'视频',extensions:['.mp4','.mov','.mkv','.avi','.webm'],enabled:false,max_mib:100},
 {name:'压缩包',extensions:['.zip','.tar','.tar.gz','.gz','.7z'],enabled:false,max_mib:100},
];
function compactReport(report){
 if(!report)return report;
 const counts={};for(const row of report.files||[])counts[row.status]=(counts[row.status]||0)+1;
 return {...report,counts,files:(report.files||[]).filter(row=>!['equal','equivalent','excluded','transferred','merged','formatted','deleted'].includes(row.status))};
}
function processAlive(pid){
 if(!Number.isInteger(pid)||pid<=0)return false;
 try{process.kill(pid,0);return true}catch{return false}
}
function launchSync(state,executable,args){
 const child=spawn(executable,args,{windowsHide:true,detached:true,stdio:'ignore'});
 if(child.pid){
  const file=path.join(state,'launch.json'),temp=file+'.'+randomUUID();
  writeFileSync(temp,JSON.stringify({pid:child.pid,time:Date.now()}));
  renameSync(temp,file);
 }
 child.on('error',error=>writeFileSync(path.join(state,'status.json'),JSON.stringify({health:'failed',error:error.message})));
 child.unref();
}
export function smartSync(action,{host,project,identity='',smartSettings,diffPath,choice,expected,items,diffOffset,diffOnly,planToken,createRemote,workspacePath}){
 if(!/^[\w][\w.@-]*$/.test(host)||!/^\w[\w-]{0,47}$/.test(project))throw Error('无效的服务器配置');
 const root=path.resolve(action==='smart-status'&&workspacePath?workspacePath:'.');
 const key=createHash('sha256').update(JSON.stringify([process.platform==='win32'?root.toLowerCase():root,host,project])).digest('hex').slice(0,24);
 const metadata=path.join(root,'.dsh-sync');
 const state=path.join(metadata,'state',key);
 const recovery=path.join(metadata,'backups',key);
 const legacy=process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'DSH-Remote-Claude','smart-sync',key):null;
 const registry=path.join(os.homedir(),'.dsh','smart-sync-projects');
 const file=path.join(state,'config.json');
 const saveConfig=config=>{const temp=file+'.'+randomUUID();writeFileSync(temp,JSON.stringify(config,null,2));renameSync(temp,file)};
 const peer=fileURLToPath(new URL('./smart-sync/smart_sync.py',import.meta.url));
 const defaults={ignores:['node_modules','.venv','__pycache__','.cache','.env','.env.*','*.pem','*.key','checkpoints','datasets'],presets:defaultPresets,maxMiB:100,autoMerge:false,retentionDays:7,retentionMiB:2048,keepVersions:2};
 const read=(p,fallback)=>{try{return JSON.parse(readFileSync(p,'utf8'))}catch{return fallback}};
 function status(){
  const conf=read(file,{}),current=read(path.join(state,'status.json'),null);
  const review=read(path.join(state,'review.json'),null);
  const report=review?.time>Math.max(current?.time||0,current?.error_time||0)?review:current;
  const worker=read(path.join(state,'running.json'),null);
  const supervisor=read(path.join(state,'supervisor.json'),null);
  const owner=read(path.join(state,'supervisor.lock'),null);
  const launch=read(path.join(state,'launch.json'),null);
  const workerRunning=processAlive(worker?.pid),supervising=processAlive(owner?.pid);
  const launching=Date.now()-(launch?.time||0)<60000&&processAlive(launch?.pid);
  const running=workerRunning||supervising;
  const stopping=(running||launching)&&existsSync(path.join(state,'stop.request'));
  const starting=!workerRunning&&!stopping&&launching&&(!supervising||supervisor?.message==='启动同步进程');
  return {running,starting,supervisor,progress:read(path.join(state,'progress.json'),null),stopping,state,report:compactReport(report),initialized:!!conf.initialized||!!current?.time,
   settings:conf.uiSettings||defaults};
 }
 if(action==='smart-status')return status();
 const wantsStart=action==='smart-start'||action==='smart-init';
 if(wantsStart||action==='smart-plan'){
  const current=status();
  if(current.running||current.starting||current.stopping)return current;
 }
 if(action==='smart-stop'&&!existsSync(file))return status();
 if(!existsSync(metadata)){
  try{if(returnFiles('watch-status',{host,project,identity}).enabled)throw Error('请先暂停 Mutagen 兼容同步，再初始化项目内 .dsh-sync，避免旧引擎同步备份数据')}
  catch(e){if(!e.message.includes('请先安装 Mutagen'))throw e}
 }

 if(existsSync(metadata)&&realpathSync(metadata)!==metadata)throw Error('项目 .dsh-sync 不能是符号链接或重定向目录');
 if(!existsSync(file)&&legacy&&existsSync(path.join(legacy,'config.json'))){
  for(const name of ['running.json','supervisor.json']){
   const owner=read(path.join(legacy,name),null);
   if(owner?.pid){let alive=false;try{process.kill(owner.pid,0);alive=true}catch{};if(alive)throw Error('请先暂停旧智能同步任务，再迁移项目内数据')}
  }
  mkdirSync(state,{recursive:true});
  cpSync(legacy,state,{recursive:true,force:false,errorOnExist:true});
  const previous=read(file,{});
  if(existsSync(path.join(state,'recovery'))&&!existsSync(recovery)){
   mkdirSync(path.dirname(recovery),{recursive:true});renameSync(path.join(state,'recovery'),recovery);
  }
  if(previous.left?.recovery&&existsSync(previous.left.recovery)&&!existsSync(recovery)){
   mkdirSync(path.dirname(recovery),{recursive:true});
   cpSync(previous.left.recovery,recovery,{recursive:true,force:false,errorOnExist:true});
  }
  previous.migration={left:previous.left,right:previous.right};
  previous.state=state;previous.left={root,recovery};previous.enabled=false;
  saveConfig(previous);
 }
 mkdirSync(state,{recursive:true});
 mkdirSync(registry,{recursive:true});
 writeFileSync(path.join(registry,key+'.json'),JSON.stringify({state}));
 const exclude=spawnSync('git',['-C',root,'rev-parse','--git-path','info/exclude'],{encoding:'utf8',windowsHide:true});
 if(exclude.status===0){
  const excludePath=path.resolve(root,exclude.stdout.trim());
  const content=existsSync(excludePath)?readFileSync(excludePath,'utf8'):'';
  if(!content.split(/\r?\n/).includes('/.dsh-sync/')){
   mkdirSync(path.dirname(excludePath),{recursive:true});writeFileSync(excludePath,content+'\n/.dsh-sync/\n');
  }
 }
 if(action==='smart-stop'){const config=read(file,null);if(config){config.enabled=false;saveConfig(config)}writeFileSync(path.join(state,'stop.request'),'stop');return status()}
 const options={...defaults,...(smartSettings||status().settings)};
 if(!Array.isArray(options.ignores)||options.ignores.some(p=>typeof p!=='string'||!p.trim()||/[\r\n\0]/.test(p)))throw Error('请检查忽略规则，每行填写一条');
 if(!Array.isArray(options.presets)||options.presets.length>100)throw Error('后缀预设格式无效');
 for(const row of options.presets){
  if(!row.name||typeof row.enabled!=='boolean'||!Array.isArray(row.extensions)||row.extensions.some(s=>typeof s!=='string'||!/^\.[^/\\*?\[\]\s]+$/.test(s))||!(row.max_mib>0&&row.max_mib<=1024))
   throw Error('请检查后缀和大小：后缀以点开头，单文件上限不超过 1024 MiB');
 }
 for(const [name,min,max] of [['maxMiB',1,1024],['retentionDays',1,3650],['retentionMiB',1,1048576],['keepVersions',1,100]]){
  if(!Number.isFinite(options[name])||options[name]<min||options[name]>max)throw Error('同步设置数值超出范围：'+name);
 }
 const existing=read(file,null);
 if(action==='smart-save'&&!existing)throw Error('请先开启一次智能同步以建立配置');
 if(!['smart-start','smart-save','smart-plan','smart-inspect','smart-resolve','smart-resolve-batch','smart-init'].includes(action))throw Error('未知操作');
 let config=existing;
 const opts=['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10',...(identity?['-i',identity,'-o','IdentitiesOnly=yes']:[]),host];
 const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
 function progress(stage){if(process.env.DSH_PROGRESS)process.stderr.write('!P:'+stage+'!\r\n')}
 function ssh(command,input){
  const r=spawnSync('ssh',[...opts,command],{input,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:4*1024*1024});
  if(r.error||r.status!==0){
   const detail=r.stderr?.trim().split(/\r?\n/).at(-1);
   if(detail?.includes('Permission denied (publickey'))throw Error('SSH 公钥登录失败，请检查用户名和密钥');
   throw Error(detail||r.error?.message||'SSH 连接失败');
  }
  return r.stdout.trim();
 }
 const previewFile=path.join(state,'preview.json');
 const savedPreview=action==='smart-init'?read(previewFile,null):null;
 if(action==='smart-init'&&(!savedPreview||savedPreview.token!==planToken||
    JSON.stringify(savedPreview.settings)!==JSON.stringify(options)||
    !!savedPreview.setup!==!!createRemote)){
  throw Error('预览已变化，请重新检查');
 }

 if(['smart-start','smart-init','smart-plan'].includes(action)){
  try{if(returnFiles('watch-status',{host,project,identity}).enabled)throw Error('请先暂停当前 Mutagen 同步，再启用智能同步，避免两个引擎同时写文件。')}
  catch(e){if(!e.message.includes('请先安装 Mutagen'))throw e}
  progress('connect');
  if(action==='smart-plan'&&!status().initialized){
   const probe=`from pathlib import Path
p=Path.home()/'projects'/${JSON.stringify(project)}
if p.is_symlink() or (p.exists() and not p.is_dir()):raise ValueError('Remote project is not a regular directory')
print('new' if not p.exists() else 'existing' if any(x.name!='.dsh-sync' for x in p.iterdir()) else 'empty')
`;
   const setup=ssh('python3 -c '+quote(probe));
   if(setup==='new'||setup==='empty'){
    const token=randomUUID();
    writeFileSync(previewFile,JSON.stringify({token,settings:options,setup}));
    return {...status(),setup:{kind:setup,project,token}};
   }
   if(setup!=='existing')throw Error('无法确认服务器项目状态');
  }
  progress('prepare');
  const files={};
  for(const name of ['smart_sync.py','project_rules.py'])files[name]=readFileSync(new URL('./smart-sync/'+name,import.meta.url)).toString('base64');
  const version=createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0,16);
  const code=`import sys,json,pathlib,base64,shutil
d=json.load(sys.stdin)
h=pathlib.Path.home()
project=h/'projects'/d['project']
if project.is_symlink() or (project.exists() and not project.is_dir()):raise ValueError('Remote project is not a regular directory')
if d.get('createRemote') and project.exists() and any(x.name!='.dsh-sync' for x in project.iterdir()):
 raise ValueError('服务器项目已有文件，请重新检查')
p=h/'.local/share/dsh-smart-sync'/d['version']
p.mkdir(parents=True,exist_ok=True)
for n,v in d['files'].items():(p/n).write_bytes(base64.b64decode(v))
if d.get('createRemote'):
 project.mkdir(parents=True,exist_ok=True)
elif not project.is_dir():
 raise ValueError('服务器项目不存在，请重新检查并确认创建')
destination=project/'.dsh-sync/backups'/d['key']
old=pathlib.Path(d['oldRecovery']) if d.get('oldRecovery') else None
if old and old!=destination and old.exists():
 if h.resolve() not in old.resolve().parents:raise ValueError('Invalid previous backup directory')
 destination.mkdir(parents=True,exist_ok=True)
 for source in old.rglob('*'):
  if source.is_symlink():raise ValueError('Symlink in previous backup directory')
  target=destination/source.relative_to(old)
  if source.is_dir():target.mkdir(parents=True,exist_ok=True)
  elif target.exists():
   if source.read_bytes()!=target.read_bytes():raise ValueError('Backup migration conflict: '+str(source))
  else:
   target.parent.mkdir(parents=True,exist_ok=True)
   shutil.copy2(source,target)
print(h)
`;
  const remoteHome=ssh('python3 -c '+quote(code),JSON.stringify({files,version,project,key,createRemote,oldRecovery:existing?.right?.recovery}));
  if(!remoteHome.startsWith('/')||remoteHome.includes('\n'))throw Error('无法确定远程用户目录');
  config={...existing,migration:existing?.migration||(existing?{left:existing.left,right:existing.right}:undefined),left:{root,recovery},
   right:{host,identity,script:remoteHome+'/.local/share/dsh-smart-sync/'+version+'/smart_sync.py',
    root:remoteHome+'/projects/'+project,recovery:remoteHome+'/projects/'+project+'/.dsh-sync/backups/'+key},state};
 }
 if(!config)throw Error('请先点击初始化同步或扫描差异');
 const candidates=[['python',[]],['py',['-3']],['python3',[]]];
 const python=candidates.find(([exe,prefix])=>spawnSync(exe,[...prefix,'-c','import sys;sys.exit(sys.version_info<(3,10))'],{windowsHide:true}).status===0);
 if(!python)throw Error('需要本机 Python 3.10 或更新版本');
 function ui(request){
  const r=spawnSync(python[0],[...python[1],'-X','utf8',peer,'ui','--config',file],{input:JSON.stringify(request),encoding:'utf8',windowsHide:true,timeout:request.action==='resolve-batch'?1750000:180000,maxBuffer:16*1024*1024,stdio:['pipe','pipe','inherit']});
  if(r.error||r.status!==0)throw Error(r.error?.message||r.stderr||'差异检查失败');
  const response=JSON.parse(r.stdout);if(response.error)throw Error(response.error);return response.result;
 }
 if(['smart-inspect','smart-resolve','smart-resolve-batch'].includes(action)){
  if(action!=='smart-inspect'){
   const current=status();
   if(current.running||current.starting||current.stopping)throw Error('暂停完成后再处理差异');
  }
  if(action!=='smart-resolve-batch'&&(typeof diffPath!=='string'||!diffPath))throw Error('请选择文件');
  if(action==='smart-resolve'||action==='smart-resolve-batch'){
   try{if(returnFiles('watch-status',{host,project,identity}).enabled)throw Error('请先暂停 Mutagen 同步再处理差异')}
   catch(e){if(!e.message.includes('请先安装 Mutagen'))throw e}
   if(action==='smart-resolve-batch'){
    const batch=ui({action:'resolve-batch',items});
    const report=status().report;
    if(report){
     const completed=new Set(batch.filter(row=>row.resolved).map(row=>row.path));
     writeFileSync(path.join(state,'review.json'),JSON.stringify({...report,time:Date.now()/1000,files:report.files.filter(row=>!completed.has(row.path))}));
    }
    return {...status(),batch};
   }
   const result=ui({action:'resolve',path:diffPath,side:choice,expected});
   return {...status(),resolved:result,plan:compactReport(ui({action:'plan'}))};
  }
  return {...status(),comparison:ui({action:'inspect',path:diffPath,diffOffset,diffOnly})};
 }
 if(action==='smart-start'&&!status().initialized)throw Error('首次使用请先初始化同步，预览后确认');
 if(wantsStart){
  const current=status();
  if(current.running||current.starting||current.stopping)return current;
 }
 Object.assign(config,{ignores:options.ignores,presets:options.presets,max_bytes:options.maxMiB*1048576,auto_merge:options.autoMerge,
  retention:{days:options.retentionDays,max_bytes:options.retentionMiB*1048576,keep:options.keepVersions},
  settle_seconds:1,interval_seconds:3,uiSettings:options});
 const temp=file+'.'+randomUUID();writeFileSync(temp,JSON.stringify(config,null,2));renameSync(temp,file);
 if(action==='smart-plan'){
  const plan=ui({action:'plan'});
  writeFileSync(previewFile,JSON.stringify({token:plan.token,settings:options}));
  writeFileSync(path.join(state,'review.json'),JSON.stringify(compactReport(plan)));
  return {...status(),plan:compactReport(plan)};
 }
 if(action==='smart-init'){
  if(!savedPreview.setup&&ui({action:'plan'}).token!==planToken)
   throw Error('文件已变化，请重新检查');
  config.initialized=true;saveConfig(config);
 }
 if(['smart-start','smart-init'].includes(action)){
  progress('start');
  config.enabled=true;saveConfig(config);
  if(existsSync(path.join(state,'stop.request')))unlinkSync(path.join(state,'stop.request'));
  launchSync(state,process.execPath,[fileURLToPath(new URL('./smart-supervisor.mjs',import.meta.url)),state,python[0],...python[1],'-X','utf8',peer,'watch','--config',file]);
 }
 return status();
}

export function resumeSmartSync(){
 const base=path.join(os.homedir(),'.dsh','smart-sync-projects');
 if(!existsSync(base))return;
 for(const name of readdirSync(base)){
  let state,file;
  try{
   state=JSON.parse(readFileSync(path.join(base,name),'utf8')).state;file=path.join(state,'config.json');
   const config=JSON.parse(readFileSync(file,'utf8'));
   if(!config.enabled||existsSync(path.join(state,'stop.request')))continue;
   if(existsSync(path.join(state,'supervisor.lock'))&&processAlive(JSON.parse(readFileSync(path.join(state,'supervisor.lock'),'utf8')).pid))continue;
   if(existsSync(path.join(state,'running.json'))&&processAlive(JSON.parse(readFileSync(path.join(state,'running.json'),'utf8')).pid))continue;
   const candidates=[['python',[]],['py',['-3']],['python3',[]]];
   const python=candidates.find(([exe,prefix])=>spawnSync(exe,[...prefix,'-c','import sys;sys.exit(sys.version_info<(3,10))'],{windowsHide:true}).status===0);
   if(!python)continue;
   launchSync(state,'node',[fileURLToPath(new URL('./smart-supervisor.mjs',import.meta.url)),state,python[0],...python[1],'-X','utf8',fileURLToPath(new URL('./smart-sync/smart_sync.py',import.meta.url)),'watch','--config',file]);
  }catch{}
 }
}
