import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import path from 'node:path';

const legacySession=(host,project)=>'dsh-'+createHash('sha256').update(host+'\n'+project).digest('hex').slice(0,16)+'-claude';

export function routeFile(sessionId){
 return path.join(process.env.LOCALAPPDATA,'DSH-Remote-Claude','chat-routes',
  createHash('sha256').update(sessionId).digest('hex')+'.json');
}

export function readChatRoute(sessionId){
 const route=JSON.parse(readFileSync(routeFile(sessionId),'utf8'));
 return {...route,tmuxSession:route.tmuxSession||legacySession(route.host,route.project)};
}

export function bindChatRoute(sessionId,{host,project,identity}){
 const file=routeFile(sessionId);
 let previous;
 try{previous=readChatRoute(sessionId)}catch(error){if(error.code!=='ENOENT')throw error}
 let route;
 if(previous?.host===host&&previous.project===project){
  route={...previous,identity};
 }else{
  const seed=JSON.stringify([host,project,sessionId]);
  const digest=createHash('sha256').update(seed).digest('hex');
  const uuid=createHash('sha1').update(Buffer.from('6ba7b8119dad11d180b400c04fd430c8','hex')).update(seed).digest().subarray(0,16);
  uuid[6]=(uuid[6]&15)|80;
  uuid[8]=(uuid[8]&63)|128;
  const hex=uuid.toString('hex');
  route={host,project,identity,tmuxSession:'dsh-'+digest.slice(0,24)+'-claude',
   claudeSessionId:[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-')};
 }
 mkdirSync(path.dirname(file),{recursive:true});
 const temp=file+'.'+randomUUID();
 writeFileSync(temp,JSON.stringify(route),{mode:0o600});
 renameSync(temp,file);
 return route;
}

export function decodeLaunch(argv){
 if(argv[0]==='--launch')return JSON.parse(Buffer.from(argv[1],'base64').toString('utf8'));
 const [action,host,project,identity='',localWorkspace='']=argv;
 return {action,host,project,identity,localWorkspace};
}

