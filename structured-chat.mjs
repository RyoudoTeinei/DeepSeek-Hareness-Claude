import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {readFile,mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import {once} from 'node:events';
import path from 'node:path';
import {atomicJson,desktopDirectory,desktopScope,readJson} from './desktop-state.mjs';
import {receiveArtifact,sshArguments} from './desktop-runtime.mjs';
import {StructuredEvents} from './structured-events.mjs';
import {vmStatus,stageVMAttachment,connectVM} from './vm-controller.mjs';
import {vmChatConnection} from './vm-runtime.mjs';

const PREFIX='DSH_AGENT:';
const MAX_BYTES=100*1024*1024;
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const SAFE_NAME=value=>{
 let name=path.win32.basename(path.posix.basename(value||'attachment')).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(-120)||'attachment';
 if(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name))name='_'+name;
 return name;
};
const remoteScript='"$HOME/.local/state/dsh-remote/structured-v1/structured-peer.py"';

export function selectManualTurn(messages){
  const tail=messages.slice(messages.findLastIndex(message=>message.role==='assistant'||message.role==='tool')+1);
  // A failed/interrupted attempt need not append an assistant message. Earlier
  // manual messages remain in the tail; never replay them with the latest one.
  const selected=tail.findLast(message=>message.role==='user'&&message.source?.kind==='user');
  if(!selected)throw Error('本轮没有可发送的手动消息，请输入一条新消息');
  manualTurnIdentity(selected);
  if(!Array.isArray(selected.content))throw Error('消息内容格式无效');
  return selected;
}

export function manualTurnIdentity(message){
  if(typeof message.source?.rpcId==='string'&&message.source.rpcId.trim())return message.source.rpcId;
  if(typeof message.id==='string'&&message.id.trim())return 'message:'+message.id;
  throw Error('本轮消息缺少稳定标识，请重新发送一条新消息');
}

function connect(cfg,command,signal){
  const child=spawn('ssh',[...sshArguments(cfg),'-T',cfg.host,command],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  child.stdin.on('error',()=>{});
  let stderr='';child.stderr.on('data',data=>{stderr=(stderr+data).slice(-1200)});
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error(stderr||'SSH 通道中断')))});
  done.catch(()=>{});
  const stop=()=>child.kill();
  signal?.addEventListener('abort',stop,{once:true});
  child.once('close',()=>signal?.removeEventListener('abort',stop));
  if(signal?.aborted)stop();
  return {child,done};
}

async function writeChunk(stream,chunk){if(!stream.write(chunk))await once(stream,'drain');}

export async function prepareAgent(cfg,scope,signal){
  const source=await readFile(new URL('./structured-peer.py',import.meta.url),'utf8');
  const watcher=await readFile(new URL('./server-watch.py',import.meta.url),'utf8');
  const native=await readFile(new URL('./native-peer.py',import.meta.url),'utf8');
  const reader=await readFile(new URL('./chat-peer.py',import.meta.url),'utf8');
  const bootstrap=`import json,sys,os,pathlib,uuid
os.umask(0o077)
p=json.load(sys.stdin)
root=pathlib.Path.home()/'.local/state/dsh-remote/structured-v1'
root.mkdir(parents=True,exist_ok=True)
for name,contents in [('structured-peer.py',p['source']),('server-watch.py',p['watcher']),('native-peer.py',p['native']),('chat-peer.py',p['reader'])]:
 target=root/name
 if not target.exists() or target.read_text()!=contents:
  temp=root/('source-'+uuid.uuid4().hex+'.tmp');temp.write_text(contents,encoding='utf-8');temp.replace(target)
state=root/'sessions'/p['scope'];state.mkdir(parents=True,exist_ok=True)
binding=state/'binding.json'
if binding.exists() and json.loads(binding.read_text())['project']!=p['project']:raise ValueError('Session binding mismatch')
temp=state/('binding-'+uuid.uuid4().hex+'.tmp');temp.write_text(json.dumps({'project':p['project'],'vmTools':p.get('vmTools',False)}));temp.replace(binding)
print('DSH_AGENT_READY')`;
  const connection=connect(cfg,'python3 -c '+quote(bootstrap),signal);
  let stdout='';connection.child.stdout.on('data',data=>{stdout=(stdout+data).slice(-1024)});
  connection.child.stdin.end(JSON.stringify({scope,project:cfg.project,source,watcher,native,reader,vmTools:cfg.vmTools===true}));
  const timer=setTimeout(()=>connection.child.kill(),30_000);
  try{await connection.done;if(!stdout.includes('DSH_AGENT_READY'))throw Error('结构化会话服务未就绪');}
  finally{clearTimeout(timer);}
}

export async function uploadBytes(cfg,scope,name,data,signal){
  if(data.length>MAX_BYTES)throw Error('附件超过 100 MiB');
  const digest=createHash('sha256').update(data).digest('hex');
  const connection=connect(cfg,'python3 '+remoteScript+' upload '+scope,signal);
  let output='';connection.child.stdout.on('data',bytes=>{output+=bytes});
  const timer=setTimeout(()=>connection.child.kill(),300_000);
  try{
    await writeChunk(connection.child.stdin,JSON.stringify({name:SAFE_NAME(name),size:data.length,sha256:digest})+'\n');
    await writeChunk(connection.child.stdin,data);
    connection.child.stdin.end();await connection.done;
    const result=output.split('\n').filter(line=>line.startsWith(PREFIX)).map(line=>JSON.parse(line.slice(PREFIX.length))).find(frame=>frame.type==='uploaded');
    if(!result||result.sha256!==digest||result.size!==data.length)throw Error('附件上传校验失败');
    return result.path;
  }finally{clearTimeout(timer);if(connection.child.exitCode===null)connection.child.kill();}
}

// DSH projects file blocks into this canonical handle before provider dispatch.
// Accept a whole handle block only, and verify it against DSH's own immutable store.
const FILE_HANDLE=/^\[File ("(?:[^"\\]|\\.)*") \((\d+) bytes, sha256:([0-9a-f]{8})\): verbatim read-only copy saved at ("(?:[^"\\]|\\.)*")\. Read that path[\s\S]*\]$/;

const IMAGE_EXTENSIONS=new Map([['image/png','.png'],['image/jpeg','.jpg'],['image/webp','.webp'],['image/gif','.gif']]);
function inspectBlock(block,host){
  if(block.type==='file'){
    if(!block.attachment||!host.llm?.fileRequestText)throw Error('文件附件服务不可用');
    const handle=host.llm.fileRequestText(block.attachment);
    if(typeof handle!=='string'||!FILE_HANDLE.test(handle))throw Error('无法验证文件附件，请重新添加');
    return inspectBlock({type:'text',text:handle},host);
  }
  if(block.type==='image'){
    const ref=block.attachment,ext=IMAGE_EXTENSIONS.get(ref?.mediaType);
    if(!ext||!host.attachments?.readImage)throw Error('图片格式或附件服务不可用');
    if(ref.bytes>MAX_BYTES)throw Error('图片超过 100 MiB');
    const name=SAFE_NAME(ref.name||'image'+ext);
    return {kind:'image',name:name.endsWith(ext)?name:name+ext,ref};
  }
  if(block.type!=='text'||typeof block.text!=='string')throw Error('本轮含不支持的消息内容');
  const handle=FILE_HANDLE.exec(block.text);
  if(!handle){
    const text=block.text.replaceAll('\r\n','\n');
    if(/[\x00-\x08\x0b-\x1f\x7f]/.test(text))throw Error('消息包含无效控制字符');
    return {kind:'text',text};
  }
  const [,encodedName,rawSize,prefix,encodedPath]=handle;
  const local=JSON.parse(encodedPath),name=JSON.parse(encodedName),size=Number(rawSize);
  if(size>MAX_BYTES)throw Error('附件超过 100 MiB');
  const digest=path.basename(path.dirname(local));
  if(!/^[a-f0-9]{64}$/.test(digest)||!digest.startsWith(prefix)||!host.attachments?.fileHostPath||!host.attachments?.readFileStream)throw Error('无法验证 DSH 附件引用，请重新添加附件');
  const ref={attachmentId:'sha256:'+digest,name,bytes:size};
  const expected=host.attachments.fileHostPath(ref);
  if(!expected||path.resolve(expected).toLowerCase()!==path.resolve(local).toLowerCase())throw Error('附件路径不属于 DSH 附件存储');
  return {kind:'file',name,ref,digest};
}

async function snapshotAttachment(item,service,destination,signal){
  if(item.kind==='image'){
    const {data}=await service.readImage(item.ref,signal);
    if(data.byteLength>MAX_BYTES)throw Error('图片超过 100 MiB');
    await writeFile(destination,data,{flag:'wx',mode:0o600,signal});
    return;
  }
  const digest=createHash('sha256');
  let total=0;
  async function* chunks(){
    for await(const part of service.readFileStream(item.ref,signal)){
      signal?.throwIfAborted();total+=part.byteLength;
      if(total>MAX_BYTES||total>item.ref.bytes)throw Error('附件长度校验失败');
      digest.update(part);yield part;
    }
  }
  await writeFile(destination,chunks(),{flag:'wx',mode:0o600,signal});
  if(total!==item.ref.bytes||digest.digest('hex')!==item.digest)throw Error('附件内容校验失败');
}

function inspectMessage(message,host){
  const items=message.content.map(block=>inspectBlock(block,host));
  const attachments=items.filter(item=>item.kind!=='text');
  if(attachments.length>10)throw Error('每轮最多上传 10 个附件');
  if(!attachments.length&&!items.some(item=>item.text.trim()))throw Error('消息为空');
  return {items,attachments};
}

export async function preparePrompt(message,host,upload,signal,plan=inspectMessage(message,host)){
  signal?.throwIfAborted();
  const {items,attachments}=plan;
  // Validate every byte before the first project write. Hold at most one file in memory.
  const temp=attachments.length?await mkdtemp(path.join(os.tmpdir(),'dsh-attachments-')):null;
  try{
    for(const [i,item] of attachments.entries()){
      item.snapshot=path.join(temp,String(i));
      await snapshotAttachment(item,host.attachments,item.snapshot,signal);
    }
    const texts=[];
    for(const item of items){
      signal?.throwIfAborted();
      if(item.kind==='text'){texts.push(item.text);continue;}
      const remote=await upload(item.name,await readFile(item.snapshot,{signal}));
      texts.push(item.kind==='image'?'用户图片位于项目内 '+JSON.stringify(remote)+'，请使用 Read 工具查看。':
        '用户附件 '+JSON.stringify(SAFE_NAME(item.name))+' 位于项目内 '+JSON.stringify(remote)+'，请按需读取。');
    }
    return {text:texts.join('\n\n'),count:attachments.length};
  }finally{if(temp)await rm(temp,{recursive:true,force:true});}
}

async function permission(host,request,event){
  const tool=event.request||{};
  if(tool.subtype!=='can_use_tool')return {behavior:'deny',message:'Unsupported control request'};
  const agent=host.agents?.get?.(request.sessionId);
  const input=tool.input||{};
  if(tool.tool_name==='AskUserQuestion'&&agent&&host.userQuestions?.ask){
    const questions=(input.questions||[]).slice(0,4).map((item,index)=>({id:event.request_id+'-'+index,question:String(item.question),header:item.header,options:item.options||[],multiSelect:!!item.multiSelect}));
    if(!questions.length)return {behavior:'deny',message:'No question supplied'};
    const response=await host.userQuestions.ask({agent,questions,signal:request.signal});
    const answers={};for(const item of questions){const answer=response.answers?.find(value=>value.id===item.id);answers[item.question]=answer?.custom||(answer?.selected||[]).join(', ');}
    return {behavior:'allow',updatedInput:{...input,answers}};
  }
  if(!agent||!host.approval?.request)return null;
  const outcome=await host.approval.request({agent,toolName:tool.tool_name,callId:tool.tool_use_id||event.request_id,reason:'服务器操作\n'+JSON.stringify(input,null,2).slice(0,8000),signal:request.signal});
  if(outcome==='unavailable')return null;
  return outcome==='allowed-once'?{behavior:'allow',updatedInput:input}:{behavior:'deny',message:'The desktop user did not approve this operation'};
}

export async function* structuredStream(request,cfg,host={}){
  const controlAbort=new AbortController();
  const controlSignal=request.signal?AbortSignal.any([request.signal,controlAbort.signal]):controlAbort.signal;
  const scope=desktopScope(request.sessionId,cfg.host,cfg.project);
  const directory=path.join(desktopDirectory(scope),'structured');
  await mkdir(directory,{recursive:true});
  const manual=selectManualTurn(request.messages);
  const turn=createHash('sha256').update(manualTurnIdentity(manual)).digest('hex').slice(0,32);
  const translator=new StructuredEvents();
  const artifacts=await readJson(path.join(directory,'artifacts.json'),[]);
  const state={turn,status:'preparing',artifacts,events:[],approvals:[]};
  let writes=Promise.resolve();
  const persist=()=>{const snapshot=structuredClone(state);writes=writes.then(()=>atomicJson(path.join(directory,'status.json'),snapshot));return writes;};
  async function decide(event){
    if(Object.hasOwn(host,'decide')&&typeof host.decide==='function')return host.decide(event,request);
    const entry={id:createHash('sha256').update(event.request_id).digest('hex').slice(0,32),tool:event.request?.tool_name||'tool',input:event.request?.input||{},status:'pending',source:'native'};
    state.approvals.push(entry);await persist();
    let result;
    try{result=await permission(host,{...request,signal:controlSignal},event);}
    catch{result=controlSignal.aborted?{behavior:'deny',message:'Approval cancelled'}:null;}
    if(result===null){
      entry.source='panel';await persist();
      const deadline=Date.now()+300_000;
      while(Date.now()<deadline&&!controlSignal.aborted){
        const answer=await readJson(path.join(directory,'approvals',turn,entry.id+'.json'));
        if(answer){result=answer.approved?{behavior:'allow',updatedInput:entry.input}:{behavior:'deny',message:'User denied this server operation'};break;}
        await new Promise(resolve=>setTimeout(resolve,500));
      }
    }
    result??={behavior:'deny',message:'Approval expired or cancelled'};
    entry.status=result.behavior==='allow'?'approved':'denied';await persist();return result;
  }
  await persist();
  let connection;
  try{
    yield* translator.whole('reasoning','正在准备远端会话与附件…');
    const plan=inspectMessage(manual,host);
    if(cfg.vmTools&&!['connected','running'].includes((await vmStatus(scope)).status)){
      yield* translator.whole('reasoning','正在恢复本聊天的虚拟机连接与云端会话…');
      await connectVM(cfg,request.sessionId,cfg.localRoot);
    }
    if(!cfg.vmTools)await prepareAgent(cfg,scope,request.signal);
    const prompt=await preparePrompt(manual,host,(name,data)=>cfg.vmTools?stageVMAttachment(scope,cfg.localRoot,name,data):uploadBytes(cfg,scope,name,data,request.signal),request.signal,plan);
    if(cfg.vmTools)yield* translator.whole('reasoning','工具运行位置：本地隔离虚拟机；文件写入当前共享项目');
    if(prompt.count)yield* translator.whole('reasoning','已上传并校验 '+prompt.count+' 个附件');
    state.status='running';await persist();
    const runner=cfg.headless===true?remoteScript:'"$HOME/.local/state/dsh-remote/structured-v1/native-peer.py"';
    connection=cfg.vmTools?vmChatConnection(scope):connect(cfg,'python3 '+runner+' turn '+scope);
    const lines=createInterface({input:connection.child.stdout});
    const wire={turn,text:prompt.text};
    if(cfg.remoteModel)wire.model=cfg.remoteModel;
    if(cfg.testBudget)wire.budget=cfg.testBudget;
    connection.child.stdin.write(JSON.stringify(wire)+'\n');
    let finished=false;
    const controls=new Set();
    const cancel=()=>{if(!connection.child.stdin.destroyed)connection.child.stdin.write('{"type":"cancel"}\n')};
    request.signal?.addEventListener('abort',cancel,{once:true});
    if(request.signal?.aborted)cancel();
    try{
      for await(const line of lines){
        if(!line.startsWith(PREFIX))continue;
        const frame=JSON.parse(line.slice(PREFIX.length));
        if(frame.type==='native_status')yield* translator.whole('reasoning',frame.message);
        if(frame.type==='claude_event'&&frame.event.type==='control_request'){
          const event=frame.event;
          yield* translator.whole('reasoning','等待确认 · '+(event.request?.tool_name||'服务器操作'));
          const pending=decide(event)
            .catch(()=>({behavior:'deny',message:'Approval cancelled'})).then(response=>{
              if(!connection.child.stdin.destroyed)connection.child.stdin.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:event.request_id,response}})+'\n');
            }).finally(()=>controls.delete(pending));
          controls.add(pending);
        }
        if(frame.type==='artifact_ready'){
          const record=frame.artifact;
          if(!/^[a-f0-9]{32}$/.test(record.id)||!/^[a-f0-9]{64}$/.test(record.sha256)||typeof record.name!=='string'||!Number.isSafeInteger(record.size)||record.size<0||record.size>MAX_BYTES)throw Error('成果信息无效');
          const folder=path.join(directory,'received',turn,record.id);await mkdir(folder,{recursive:true});
          const destination=path.join(folder,SAFE_NAME(record.name));
          const download=connect(cfg,'python3 '+remoteScript+' download '+scope+' '+turn+' '+record.id,request.signal);
          const downloadTimer=setTimeout(()=>download.child.kill(),300_000);
          download.child.stdin.end();
          const frames=createInterface({input:download.child.stdout});
          async function* converted(){for await(const value of frames)if(value.startsWith(PREFIX))yield 'DSH_DESKTOP:'+value.slice(PREFIX.length);}
          try{
            // A replay reuses an already verified immutable result.
            let valid=false;try{valid=createHash('sha256').update(await readFile(destination)).digest('hex')===record.sha256;}catch{}
            if(valid){for await(const _ of converted()){};}else await receiveArtifact(converted(),destination);
            await download.done;
            const verified=await readFile(destination);
            if(verified.length!==record.size||createHash('sha256').update(verified).digest('hex')!==record.sha256)throw Error('成果与发布记录不一致');
          }finally{clearTimeout(downloadTimer);frames.close();if(download.child.exitCode===null)download.child.kill();}
          if(!artifacts.some(item=>item.id===record.id))artifacts.push({...record,localFile:destination});
          if(artifacts.length>50)artifacts.splice(0,artifacts.length-50);
          await atomicJson(path.join(directory,'artifacts.json'),artifacts);await persist();
          yield* translator.whole('text','\n\n📎 已回传 **'+SAFE_NAME(record.name)+'**（'+record.size+' 字节）。可在工作台的“成果”中打开。');
        }
        if(frame.type==='broker_done'){finished=true;break;}
        const chunks=translator.consume(frame);
        if(frame.type==='claude_event'&&['assistant','user','result'].includes(frame.event.type)){
          const event=frame.event;
          if(event.type==='assistant')for(const block of event.message?.content||[])if(block.type==='tool_use'){
            const input=block.input||{},detail=input.description||input.file_path||input.path||input.skill||'';
            state.events.push({id:block.id,tool:block.name,status:'started',time:Date.now(),detail:typeof detail==='string'?detail.slice(0,200):''});
          }
          if(event.type==='user')for(const block of event.message?.content||[])if(block.type==='tool_result')state.events.push({id:block.tool_use_id,tool:translator.tools.get(block.tool_use_id)||'tool',status:block.is_error?'failed':'completed',time:Date.now()});
          state.events=state.events.slice(-30);await persist();
        }
        yield* chunks;
      }
      connection.child.stdin.end();
      try{await connection.done}catch(error){
        // A verified completion receipt wins over a late SSH teardown error.
        // Without both receipts the operation remains unconfirmed.
        if(!finished||!translator.final)throw error;
      }
      request.signal?.throwIfAborted();
      if(!finished||!translator.final)throw Error('远端未确认本轮完成，请检查状态后继续');
      state.status='completed';await persist();
      yield {type:'finish',reason:{kind:'stop'}};
    }finally{
      request.signal?.removeEventListener('abort',cancel);
      lines.close();
      if(connection.child.exitCode===null){cancel();setTimeout(()=>connection.child.kill(),3000).unref();}
    }
  }catch(error){state.status=request.signal?.aborted?'cancelled':'failed';state.error=request.signal?.aborted?'任务已停止':String(error.message||error);await persist();throw request.signal?.aborted?(request.signal.reason||Error('任务已停止')):error;}
  finally{controlAbort.abort();}
}
