import {outboundText} from './outbound.mjs';
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {structuredStream} from './structured-chat.mjs';
const route='dsh-remote-claude', model='claude-code';
const info={provider:route,id:model,name:'Claude Code · 远程工作区',inputModalities:['text','image']};
const routesDir=()=>path.join(process.env.LOCALAPPDATA,'DSH-Remote-Claude','chat-routes');
export const name='dsh-remote-claude-model';
export function apply(ctx){
 ctx.inject(['llm','attachments','agents','approval','userQuestions'],child=>child.llm.registerAdapter([route],{
  providerInfo:()=>({id:route,name:'Claude Code'}),
  providerRetryPolicy:()=>({mode:'normal',maxRetries:0,retryableCodes:[],backoff:{}}),
  imageRequestPricing:()=>undefined,imageRequestTarget:()=>undefined,
  listModels:async()=>[info],resolveModel:async()=>info,
  prepareCall:async()=>({model:info,stream:request=>stream(request,child)}),stream:request=>stream(request,child)
 }));
}
export async function* stream(request,host={}){
 if(request.purpose==='session-title'){
  const message=request.messages.find(item=>item.role==='user'&&item.source?.kind==='user');
  const text=(message?.content||[]).filter(block=>block.type==='text'&&!block.text.startsWith('[File ')).map(block=>block.text).join(' ').trim().slice(0,28)||'Claude 远程任务';
  yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};
  yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};return;
 }
 const id=request.sessionId;
 if(!id)throw Error('此模型仅用于已连接的 Claude 工作区会话。');
 let cfg;
 try{cfg=JSON.parse(readFileSync(path.join(routesDir(),createHash('sha256').update(id).digest('hex')+'.json'),'utf8'))}
 catch{throw Error('请在当前工作区点一次「接入 Claude」以绑定左右会话。')}
 if(cfg.structuredChat){yield* structuredStream(request,cfg,host);return;}
 const text=outboundText(request.messages);
 const key=createHash('sha256').update(cfg.host+'\n'+cfg.project).digest('hex').slice(0,16);
 const remoteSession=cfg.activeTmuxSession || 'dsh-'+key+'-claude';
 if(!/^dsh-[a-f0-9]{16,32}-claude$/.test(remoteSession))throw Error('会话绑定无效，请重新接入。');
 const script=readFileSync(new URL('./chat-peer.py',import.meta.url)).toString('base64');
 const cp=spawn('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-o','SendEnv=-*','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=4',...(cfg.identity?['-i',cfg.identity,'-o','IdentitiesOnly=yes']:[]),cfg.host,`python3 -c "import base64;exec(base64.b64decode('${script}'))"`],{windowsHide:true,signal:request.signal});
 let error='',body='',done=false;
 const completion=new Promise(resolve=>{cp.on('error',e=>resolve(e.message));cp.on('close',code=>resolve(code===0?'':error||'SSH 通道关闭'))});
 cp.stderr.on('data',b=>{error=(error+b).slice(-800)});cp.stdin.on('error',()=>{});
 const lines=createInterface({input:cp.stdout});cp.stdin.end(JSON.stringify({session:remoteSession,project:cfg.project,text}));
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
 }finally{lines.close();if(cp.exitCode===null)cp.kill()}
}
