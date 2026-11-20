import {createHash} from 'node:crypto';
import {readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {desktopScope,readJson} from './desktop-state.mjs';
import {publishRoute,routeFile,storedRoute} from './session-binding.mjs';

// Both the model adapter and the VM manager run in the DSH backend. Reserve
// the conversation before reading its route, including before the first await.
const turns=new Map(),migrations=new Map();
export function beginSessionTurn(id){
 if(migrations.has(id))throw Error('此聊天正在切换到本机虚拟机，请等切换结束后发送。');
 turns.set(id,(turns.get(id)||0)+1);
 return ()=>{const count=turns.get(id)-1;if(count)turns.set(id,count);else turns.delete(id)};
}
export function migrateOnce(id,operation){
 if(migrations.has(id))return migrations.get(id);
 if(turns.has(id))return Promise.reject(Error('当前聊天正在执行任务，请等本轮结束后切换。'));
 const task=Promise.resolve().then(operation).finally(()=>migrations.delete(id));
 migrations.set(id,task);return task;
}

export function serverTerminal(route){
 const key=createHash('sha256').update(route.host+'\n'+route.project).digest('hex').slice(0,16);
 return route.activeTmuxSession||'dsh-'+key+'-claude';
}

async function migrationSource(route,scope,file){
 if(route.structuredChat)return 'dsh-native-'+scope;
 const name=serverTerminal(route);
 if(name==='dsh-'+scope+'-claude')return name;
 if(name!==serverTerminal({host:route.host,project:route.project}))throw Error('旧终端与本聊天的绑定不一致。');
 for(const other of await readdir(path.dirname(file))){
  if(other===path.basename(file)||!other.endsWith('.json'))continue;
  const value=await readJson(path.join(path.dirname(file),other));
  if(value?.host===route.host&&!value.structuredChat&&serverTerminal(value)===name)
   throw Error('多个旧聊天共用这个服务器终端，无法唯一识别本聊天的历史。');
 }
 return name;
}

export function migrateBinding(cfg,connect,base=process.env.LOCALAPPDATA){
 return migrateOnce(cfg.sessionId,async()=>{
  const file=routeFile(cfg.sessionId,base),old=await storedRoute(cfg.sessionId,base);
  if(!old||cfg.scope!==desktopScope(cfg.sessionId,old.host,old.project)||old.host!==cfg.cloud.host||
     old.project!==cfg.project||(old.identity||'')!==(cfg.cloud.identity||'')||
     (old.localRoot&&(await realpath(old.localRoot)).toLowerCase()!==cfg.localRoot.toLowerCase()))throw Error('当前聊天的工作区绑定已变化，请重新打开工作台。');
  if(old.vmTools)return old;
  const name=await migrationSource(old,cfg.scope,file);
  const bridge=await connect();
  try{
   const proof=await bridge.forkHistory(name);
   const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
   if(!uuid.test(proof?.source)||!uuid.test(proof.id)||proof.id===proof.source||!Number.isSafeInteger(proof.messages)||proof.messages<1)
    throw Error('未收到有效的历史分叉确认。');
   if(JSON.stringify(await readJson(file))!==JSON.stringify(old))throw Error('迁移期间聊天绑定有变化，请重新打开工作台。');
   if(bridge.closed)throw Error('虚拟机已断开，请重新切换。');
   const next={...old,localRoot:cfg.localRoot,vmTools:true,executionMode:'vm',desktopTools:false,structuredChat:true,historyFork:proof};
   // Publish separately: a still-open legacy desktop terminal may update its own route.
   const saved=await publishRoute(file+'.vm',next);
   if(saved?.historyFork?.id!==proof.id)throw Error('当前聊天已绑定其他分叉，请刷新工作台。');
   return saved;
  }catch(error){await bridge.stop();throw error}
 });
}
