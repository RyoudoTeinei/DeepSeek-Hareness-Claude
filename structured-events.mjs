// Translate the CLI wire into DSH blocks. Native tools run on the server;
// their activity is displayed as separate status blocks, never re-executed by DSH.
export class StructuredEvents {
  constructor(){this.next=0;this.message='';this.blocks=new Map();this.tools=new Map();this.lastText='';this.final=null;this.lastSequence=0;}
  whole(kind,text){
    if(!text)return [];
    const index=this.next++;
    return [{type:'block-start',index,blockType:kind},{type:kind==='text'?'text-delta':'reasoning-delta',index,text},
      {type:'block-end',index,block:{type:kind,text}}];
  }
  append(key,text){
    if(!text)return [];
    let block=this.blocks.get(key);
    const events=[];
    if(!block){block={index:this.next++,text:'',open:true};this.blocks.set(key,block);events.push({type:'block-start',index:block.index,blockType:'text'});}
    if(!block.open){events.push(...this.whole('text',text));block.text+=text;return events;}
    block.text+=text;
    events.push({type:'text-delta',index:block.index,text});
    return events;
  }
  close(key){
    const block=this.blocks.get(key);
    if(!block?.open)return [];
    block.open=false;
    return [{type:'block-end',index:block.index,block:{type:'text',text:block.text}}];
  }
  consume(frame){
    if(frame.sequence){if(frame.sequence<=this.lastSequence)return [];this.lastSequence=frame.sequence;}
    if(frame.type==='broker_error')throw Error(frame.message||'远端任务失败');
    if(frame.type!=='claude_event')return [];
    const event=frame.event;
    if(event.parent_tool_use_id)return [];
    const out=[];
    if(event.type==='stream_event'){
      const part=event.event||{};
      if(part.type==='message_start'){this.message=part.message?.id||'message-'+this.next;this.lastText='';}
      const key=this.message+':'+part.index;
      if(part.type==='content_block_start'&&part.content_block?.type==='text'){
        const text=part.content_block.text||'';out.push(...this.append(key,text));this.lastText+=text;
      }
      if(part.type==='content_block_delta'&&part.delta?.type==='text_delta'){
        out.push(...this.append(key,part.delta.text));this.lastText+=part.delta.text;
      }
      if(part.type==='content_block_stop')out.push(...this.close(key));
    }else if(event.type==='assistant'){
      const message=event.message||{};let complete='';
      for(const [index,block] of (message.content||[]).entries()){
        if(block.type==='text'){
          complete+=block.text;
          const key=(message.id||this.message)+':'+index;
          const prior=this.blocks.get(key)?.text||'';
          if(!prior)out.push(...this.append(key,block.text),...this.close(key));
          else if(block.text.startsWith(prior))out.push(...this.append(key,block.text.slice(prior.length)),...this.close(key));
        }
        if(block.type==='tool_use'&&!this.tools.has(block.id)){
          this.tools.set(block.id,block.name);
          const target=block.input?.file_path||block.input?.path||block.input?.command||'';
          out.push(...this.whole('reasoning','▶ '+block.name+(target?' · '+String(target).slice(0,1000):'')));
        }
      }
      if(complete)this.lastText=complete;
    }else if(event.type==='user'&&Array.isArray(event.message?.content)){
      for(const block of event.message.content){
        if(block.type==='tool_result')out.push(...this.whole('reasoning',(block.is_error?'✕ ':'✓ ')+(this.tools.get(block.tool_use_id)||'工具')+(block.is_error?' · 执行失败':' · 已完成')));
      }
    }else if(event.type==='result'){
      for(const key of this.blocks.keys())out.push(...this.close(key));
      this.final=event;
      if(event.is_error)throw Error((event.errors||[]).join('\n')||event.result||'Claude 本轮执行失败');
      if(typeof event.result==='string'&&event.result.trim()!==this.lastText.trim()){
        const missing=event.result.startsWith(this.lastText)?event.result.slice(this.lastText.length):event.result;
        out.push(...this.whole('text',missing));
      }
    }
    return out;
  }
}
