import {resumeSmartSync} from './smart-sync.mjs';
import {outboundText} from './outbound.mjs';
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {readChatRoute} from './chat-session.mjs';
const route='dsh-remote-claude';
const followTerminal='claude-code';
const models=[
 [followTerminal,'Claude Code · 跟随终端'],
 ['claude-opus-5-5','Opus 5.5'],
 ['claude-fable-5-1','Fable 5.1'],
 ['claude-sonnet-5-5','Sonnet 5.5'],
 ['claude-haiku-5-5','Haiku 5.5'],
].map(([id,name])=>({provider:route,id,name,inputModalities:['text']}));
function modelInfo(id){
 const entry=models.find(model=>model.id===id);
 if(!entry)throw Error('此 Claude 型号未注册，请重新选择模型。');
 return entry;
}
export const name='dsh-remote-claude-model';
export function apply(ctx){
 resumeSmartSync();
 ctx.inject(['llm'],child=>child.llm.registerAdapter([route],{
  providerInfo:()=>({id:route,name:'Claude Code'}),
  providerRetryPolicy:()=>({mode:'normal',maxRetries:0,retryableCodes:[],backoff:{}}),
  imageRequestPricing:()=>undefined,imageRequestTarget:()=>undefined,
  listModels:async()=>models,
  resolveModel:async(_provider,id)=>modelInfo(id),
  prepareCall:async(_provider,id)=>{
   const model=modelInfo(id);
   return {model,stream:request=>stream(request,model.id)};
  },
  stream:request=>stream(request,modelInfo(request.model).id),
 }));
}
export async function* stream(request,model){
 if(request.signal?.aborted)return;
 const id=request.sessionId;
 if(!id)throw Error('此模型仅用于已连接的 Claude 工作区会话。');
 let cfg;
 try{cfg=readChatRoute(id)}
 catch{throw Error('请在当前工作区点一次「接入 Claude」以绑定左右会话。')}
 const text=outboundText(request.messages);
 const script=readFileSync(new URL('./chat-peer.py',import.meta.url)).toString('base64');
 const cp=spawn('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=20','-o','ServerAliveCountMax=3',...(cfg.identity?['-i',cfg.identity,'-o','IdentitiesOnly=yes']:[]),cfg.host,`python3 -c "import base64;exec(base64.b64decode('${script}'))"`],{windowsHide:true});
 let error='',body='',done=false;
 const completion=new Promise(resolve=>{cp.on('error',e=>resolve(e.message));cp.on('close',code=>resolve(code===0?'':error||'SSH 通道关闭'))});
 cp.stderr.on('data',b=>{error=(error+b).slice(-800)});cp.stdin.on('error',()=>{});
 const lines=createInterface({input:cp.stdout});
 cp.stdin.write(JSON.stringify({session:cfg.tmuxSession,project:cfg.project,text,model:model===followTerminal?null:model})+'\n');
 const cancel=()=>{if(!done&&!cp.stdin.destroyed)cp.stdin.write('{"action":"cancel"}\n')};
 request.signal?.addEventListener('abort',cancel,{once:true});
 if(request.signal?.aborted)cancel();
 try{
  yield {type:'block-start',index:0,blockType:'text'};
  for await(const line of lines){
   const e=JSON.parse(line);if(e.error)throw Error(e.error);
   if(e.text){const delta=(body?'\n\n':'')+e.text;body+=delta;yield {type:'text-delta',index:0,text:delta}}
   if(e.done)done=true;
  }
  const failure=await completion;if(failure||!done)throw Error(failure||'回复未完成，请查看右侧终端。');
  yield {type:'block-end',index:0,block:{type:'text',text:body}};
  yield {type:'finish',reason:{kind:'stop'}};
 }finally{
  if(request.signal?.aborted&&!done&&cp.exitCode===null){cancel();await completion}
  request.signal?.removeEventListener('abort',cancel);
  cp.stdin.end();
  lines.close();
  if(cp.exitCode===null)cp.kill();
 }
}
