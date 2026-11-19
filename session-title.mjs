export const PLACEHOLDER_TITLE='Claude 远程任务';

export function titleForRequest(request){
 const texts=[];
 for(const message of request.messages||[]){
  if(message.role!=='user')continue;
  const kind=message.source?.kind;
  const blocks=(message.content||[]).filter(b=>b.type==='text').map(b=>b.text);
  if(kind==='user'){texts.push(...blocks);continue;}
  if(kind!=='dsh-session-title-llm'&&!(kind==='plugin'&&message.source.plugin==='dsh-session-title-llm'))continue;
  for(const text of blocks){
   const start=text.indexOf('\n');if(start<0)continue;
   try{
    const value=JSON.parse(text.slice(start+1));
    const rows=Array.isArray(value)?value:value.messages;
    if(Array.isArray(rows))for(const row of rows)if(typeof row.text==='string')texts.push(row.text);
   }catch{}
  }
 }
 const clean=texts.map(text=>text.replace(/\[File [^\n]+\]/g,'').replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim()).find(Boolean);
 return clean?Array.from(clean).slice(0,48).join(''): '附件处理';
}

export function installTitleRepair(ctx,hasRoute){
 const inFlight=new Set();
 let closed=false;ctx.effect?.(()=>()=>{closed=true});
 async function repair(session){
  if(closed||inFlight.has(session.id))return;
  const current=ctx.sessionTitle.get(session);
  if(current?.title!==PLACEHOLDER_TITLE||current.source.kind==='user')return;
  inFlight.add(session.id);
  try{if(await hasRoute(session.id)&&!closed)await ctx.sessionTitle.refresh(session);}catch{}
  finally{inFlight.delete(session.id);}
 }
 ctx.on('session/created',session=>{setTimeout(()=>void repair(session),200)});
 ctx.on('session/event',(session,event)=>{if(event.type==='user/message')void repair(session)});
 for(const session of ctx.sessions.list())void repair(session);
}
