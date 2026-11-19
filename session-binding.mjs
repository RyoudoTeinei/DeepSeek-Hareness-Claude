import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile,link,unlink} from 'node:fs/promises';
import path from 'node:path';
import {desktopScope,readJson} from './desktop-state.mjs';

export function routeFile(sessionId,base=process.env.LOCALAPPDATA){
 if(typeof sessionId!=='string'||!/^[\w.-]{1,180}$/.test(sessionId))throw Error('会话标识无效');
 return path.join(base,'DSH-Remote-Claude','chat-routes',createHash('sha256').update(sessionId).digest('hex')+'.json');
}
export async function storedRoute(sessionId){return readJson(routeFile(sessionId));}
export function resolveRoute(previous,proposed){
 if(previous){
  if(previous.host!==proposed.host||previous.project!==proposed.project||path.resolve(previous.localRoot).toLowerCase()!==path.resolve(proposed.localRoot).toLowerCase())throw Error('此聊天已绑定其他工作区，请回到原工作区继续；新项目请使用新聊天。');
  return {...previous,executionMode:previous.vmTools?'vm':'legacy-server'};
 }
 return {...proposed,identity:proposed.identity||'',structuredChat:true,desktopTools:false,vmTools:true,executionMode:'vm',remoteModel:proposed.remoteModel||''};
}
export async function resolveStoredRoute(sessionId,proposed){
 desktopScope(sessionId,proposed.host,proposed.project);
 if(proposed.remoteModel&&!['sonnet','opus','haiku'].includes(proposed.remoteModel))throw Error('模型设置无效');
 return resolveRoute(await storedRoute(sessionId),proposed);
}
export async function bindRoute(sessionId,proposed){
 const route=await resolveStoredRoute(sessionId,proposed),file=routeFile(sessionId);
 await mkdir(path.dirname(file),{recursive:true});
 // Publish the complete JSON atomically, preserving the first writer's binding.
 const temp=file+'.'+randomUUID()+'.tmp';
 try{
  await writeFile(temp,JSON.stringify(route),{flag:'wx',mode:0o600});
  try{await link(temp,file);return route;}
  catch(error){if(error.code!=='EEXIST')throw error;return resolveRoute(await storedRoute(sessionId),proposed);}
 }finally{await unlink(temp).catch(()=>{});}
}
