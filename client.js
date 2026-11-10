window.__ModuleLoader__.load({
 id:'dsh-plugin-remote-claude',
 factory(require){
  const React=require('react'), h=React.createElement;
  const id='dsh-plugin-remote-claude',kind='remote-claude-workbench';
  const quote=s=>"'"+s.replaceAll("'","''")+"'";
  const home='~/.dsh/profiles/desktop/node_modules/dsh-plugin-remote-claude';
  function launchCommand(request,script=home+'/bridge.mjs'){
   const bytes=new TextEncoder().encode(JSON.stringify(request));
   let payload='';for(const byte of bytes)payload+=String.fromCharCode(byte);
   return 'node (Resolve-Path '+quote(script)+') --launch '+quote(btoa(payload))+'\r';
  }
  const labels={claude:'接入 Claude',shell:'服务器 Terminal',sync:'文件同步',image:'上传剪贴板图片'};
  const inject=['sidebarRight','sidebarRightTabs','slots','webTerminals','workspaces','uiWorkspace'];
  function Guide({useTabInfo}){const {tab}=useTabInfo();return h('button',{onClick:()=>tab.actions.openTab(kind,{replaceTab:true})},'远程 Claude 工作台')}
  async function syncRequest(ctx,session,request,progress){
   const shells=await ctx.webTerminals.launchShells(session,new AbortController().signal);
   const shell=shells.shells.find(s=>/(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(s.path));
   if(!shell)throw Error('缺少 PowerShell');
   const uid=crypto.randomUUID(),model=ctx.webTerminals.view(session,uid,uid,undefined,shell.path);
   let remaining='',sent=false,revision=-1,buffer='',key='',encoded='',responseSequence=0,off,unmount,timer;
   try{return await new Promise((resolve,reject)=>{
    timer=setTimeout(()=>reject(Error('读取同步结果超时，请刷新核对仓库状态')),['push','smart-resolve-batch'].includes(request.action)?1830000:245000);
    function sendChunk(){
     const size=Math.min(2048,(model.state.getSnapshot().environment?.maxInputBytes||2049)-1);
     if(size<1){reject(Error('同步输入通道不可写'));return}
     const chunk=remaining.slice(0,size);remaining=remaining.slice(size);
     model.write(chunk+(remaining?'.':'!'));
    }
    function tick(){
     const state=model.state.getSnapshot();
     if(state.phase==='failed'||state.phase==='closed'){reject(Error(state.error?.message||'DSH 本地同步任务连接中断，请刷新文件列表并核对提交状态'));return}
     const render=state.render;
     if(render && render.revision!==revision){
      revision=render.revision;
      buffer+=(render.frame.data??render.frame.screen??'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\r\n]/g,'');
      let match;
      while((match=/!(READY|ACK|D|END|P):([a-zA-Z0-9+/=.]+)!/.exec(buffer))){
       buffer=buffer.slice(match.index+match[0].length);
       if(match[1]==='READY'&&!key){key=match[2];const bytes=new TextEncoder().encode(JSON.stringify(request));let out='';for(const b of bytes)out+=String.fromCharCode(b);remaining=btoa(out);if(remaining.length>4*1024*1024){reject(Error('选择的文件列表过大，请分批推送'));return}sendChunk()}
       else if(key && match[1]==='ACK' && match[2]===key && remaining)sendChunk();
       else if(key && match[1]==='P')progress?.(match[2]);
       else if(key && match[1]==='D'){
        const split=match[2].indexOf('.');
        if(split<0){encoded+=match[2];continue}
        const sequence=Number(match[2].slice(0,split));
        if(sequence>responseSequence){reject(Error('同步结果分段缺失，请重试'));return}
        if(sequence===responseSequence){encoded+=match[2].slice(split+1);responseSequence++}
        model.write('@'+sequence+'!');
       }
       else if(key && match[1]==='END' && match[2]===key){
        try{const resp=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))));if(!resp.ok)throw Error(resp.error);resolve(resp.result)}catch(e){reject(e)}
       }
      }
      model.acknowledge(revision);
     }
     if(!sent && state.writable){sent=true;model.write('node (Resolve-Path '+quote(home+'/sync-worker.mjs')+')'+'\r')}
    }
    off=model.state.subscribe(tick);unmount=model.mount();tick();
   })}finally{clearTimeout(timer);off?.();unmount?.();ctx.webTerminals.close(session,uid,uid,model.id)}
  }
  const syncId=id+'-sync',syncKind=kind+'-sync';
  function syncStatus(state){
   if(state?.starting)return {text:'启动中',tone:'running'};
   if(state?.error||state?.report?.error)return {text:'异常',tone:'warning'};
   if(state?.differences||state?.report?.files?.length)return {text:'有差异',tone:'warning'};
   return state?.running&&!state.stopping ? {text:'同步中',tone:'running'} : {text:'未同步',tone:'idle'};
  }
  const syncStages={connect:'连接服务器',prepare:'准备远端环境',start:'启动同步',local:'扫描本地',remote:'扫描服务器',compare:'比较文件',files:'同步文件',finish:'整理备份',idle:'等待文件变更',batch:'处理文件'};
  function SmartSyncPanel({rpc,cfg,legacyActive,onSyncState}){
   const [state,setState]=React.useState(null),[draft,setDraft]=React.useState(null),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('');
   const pending=React.useRef(false),actionQueued=React.useRef(false),reviewAfterPause=React.useRef(false);
   const [setup,setSetup]=React.useState(null),[taskProgress,setTaskProgress]=React.useState(null),[terminalLines,setTerminalLines]=React.useState([]);
   const [plan,setPlan]=React.useState(null),[comparison,setComparison]=React.useState(null),[reviewing,setReviewing]=React.useState(false),[choice,setChoice]=React.useState(''),[query,setQuery]=React.useState(''),[page,setPage]=React.useState(0),[message,setMessage]=React.useState('');
   const [selectedPath,setSelectedPath]=React.useState(''),[operation,setOperation]=React.useState(''),[elapsed,setElapsed]=React.useState(0);
   const [selected,setSelected]=React.useState(new Set()),[batchSide,setBatchSide]=React.useState(''),[fileErrors,setFileErrors]=React.useState({});
   const resultRef=React.useRef(null);
   React.useEffect(()=>{
    if(!busy)return;
    const began=Date.now();setElapsed(0);
    const timer=setInterval(()=>setElapsed(Math.floor((Date.now()-began)/1000)),1000);
    return ()=>clearInterval(timer);
   },[busy]);
   React.useEffect(()=>{if(comparison)resultRef.current?.scrollIntoView({block:'nearest',behavior:'smooth'})},[comparison]);
   React.useEffect(()=>{
    let alive=true;
    const read=async()=>{
     if(pending.current||actionQueued.current)return;
     pending.current=true;
     try{const result=await rpc({...cfg,action:'smart-status'});if(alive){setState(result);setDraft(current=>current||result.settings);onSyncState?.(result)}}
     catch(e){if(alive)setError(e.message)}
     finally{pending.current=false}
    };
    void read();const timer=setInterval(read,5000);
    return ()=>{alive=false;clearInterval(timer)};
   },[cfg.host,cfg.project]);
   function terminalStep(text){
    setTerminalLines(lines=>{
     const last=lines.at(-1);
     if(last?.text===text&&last.status==='active')return lines;
     return [...lines.slice(-5).map(line=>line.status==='active'?{...line,status:'done'}:line),{text,status:'active'}];
    });
   }
   function finishTerminal(status,detail){
    setTerminalLines(lines=>lines.map((line,index)=>
     index===lines.length-1&&line.status==='active'?{...line,status,detail}:line));
   }
   const watchPhase=state?.running&&!state?.starting&&!state?.stopping?state.progress?.phase:null;
   React.useEffect(()=>{
    if(busy)return;
    if(state?.stopping){terminalStep('等待当前操作结束');return}
    if(state?.starting){terminalStep('启动同步');return}
    if(state?.report?.error&&state.running){finishTerminal('failed',state.report.error);return}
    if(watchPhase&&watchPhase!=='idle'&&syncStages[watchPhase])terminalStep(syncStages[watchPhase]);
    else finishTerminal('done');
   },[busy,watchPhase,state?.running,state?.starting,state?.stopping,state?.report?.error]);
   async function act(action,extra={}){
    if(actionQueued.current)return;actionQueued.current=true;setElapsed(0);setBusy(true);setMessage('');
    const title={'smart-plan':'扫描两端文件','smart-inspect':'读取文件两端内容','smart-resolve':'保存所选版本','smart-resolve-batch':'批量处理所选文件','smart-init':'核对预览并启动同步','smart-start':'启动自动同步','smart-stop':'暂停自动同步','smart-save':'保存设置'}[action]||'处理请求';
    setOperation(title);setTaskProgress(null);
    terminalStep(title);
    if(action==='smart-inspect'){setSelectedPath(extra.diffPath);setComparison(null);setChoice('')}
    while(pending.current)await new Promise(r=>setTimeout(r,50));
    pending.current=true;setError('');
    try{
     const prepared={...draft,ignores:draft.ignoreText===undefined?draft.ignores:draft.ignoreText.split('\n').map(s=>s.trim()).filter(Boolean),
      presets:draft.presets.map(({extensionText,...row})=>({...row,extensions:extensionText===undefined?row.extensions:extensionText.split(',').map(s=>s.trim()).filter(Boolean)}))};
     delete prepared.ignoreText;
     const result=await rpc({...cfg,action,smartSettings:prepared,...extra},stage=>{
      const [phase,current,total]=stage.split('.');
      const text=phase==='batch'?'处理文件':syncStages[phase];
      if(!text)return;
      setOperation(text);
      setTaskProgress({phase,current:Number(current)||0,total:Number(total)||0});
      terminalStep(text);
     });
     if(result.setup){setSetup(result.setup);setPlan(null);setReviewing(false)}
     else if(action==='smart-plan')setSetup(null);
     const partialFailure=result.batch?.some(row=>!row.resolved);
     finishTerminal(partialFailure?'failed':'done',partialFailure?'部分文件未完成':undefined);
     setState(result);setDraft(prepared);
     onSyncState?.(result.plan?{...result,report:result.plan}:result);
     if(result.plan){
      setPlan(result.plan);setPage(0);setSelected(new Set());setFileErrors({});setBatchSide('');
      setReviewing(true);
     }
     if(result.comparison){setComparison(result.comparison);setChoice('')}
     if(result.batch){
      const completed=new Set(result.batch.filter(row=>row.resolved).map(row=>row.path));
      const failures=result.batch.filter(row=>!row.resolved);
      setFileErrors(Object.fromEntries(failures.map(row=>[row.path,row.error])));
      setSelected(previous=>new Set([...previous].filter(name=>!completed.has(name))));
      setBatchSide('');
      setPlan(previous=>{
       if(!previous)return previous;
       return {...previous,files:previous.files.filter(row=>!completed.has(row.path)),token:null};
      });
      if(completed.has(comparison?.path)){setComparison(null);setSelectedPath('');setChoice('')}
      if(failures.length)setError(failures.length+' 项未完成。请查看对应文件的提示，重新扫描后再试。');
      setMessage('已处理 '+completed.size+' 项'+(failures.length?'，未完成 '+failures.length+' 项':''));
     }
     if(result.resolved){setComparison(null);setSelectedPath('');setMessage('已处理 '+result.resolved.path+'，原版本已备份')}
     if(action==='smart-init'||action==='smart-start'){setSetup(null);setPlan(null);setReviewing(false);setComparison(null)}

    }
    catch(e){if(action==='smart-init'){setSetup(null);setPlan(null);setReviewing(false)}setError(e.message);finishTerminal('failed',e.message)}finally{pending.current=false;actionQueued.current=false;setBusy(false)}
   }
   React.useEffect(()=>{
    if(reviewAfterPause.current&&state&&!state.running&&!state.starting&&!state.stopping&&!busy){
     reviewAfterPause.current=false;
     scan();
    }
   },[state?.running,state?.starting,state?.stopping,busy]);
   if(!draft)return h('small',null,error||'读取同步状态…');
   const button=(label,fn,primary=false,disabled=false)=>h('button',{type:'button',disabled:disabled||busy||!!state?.stopping,onClick:fn,style:primary?{background:'#d97757',color:'#201611',fontWeight:700,padding:'12px 16px',fontSize:15}:{}},label);
   const number=(label,key,min=1)=>h('label',null,label,h('input',{type:'number',min,value:draft[key],disabled:busy,onChange:e=>setDraft({...draft,[key]:Number(e.target.value)}),style:{width:90,marginLeft:8}}));
   const update=(index,patch)=>setDraft({...draft,presets:draft.presets.map((row,i)=>i===index?{...row,...patch}:row)});
   const labels={upload:'待上传',download:'待下载',conflict:'内容冲突',blocked:'需要处理',retry:'等待重试','delete-local':'将删除本地文件','delete-remote':'将删除服务器文件',equal:'一致',equivalent:'仅换行差异',excluded:'已忽略',transferred:'已同步',merged:'已合并',formatted:'格式已统一',deleted:'已同步删除',resolved:'已处理'};
   const rows=(plan?.files||state?.report?.files||[]).filter(row=>!['equal','equivalent','excluded','transferred','merged','formatted','deleted'].includes(row.status));
   const visible=rows.filter(row=>row.path.toLowerCase().includes(query.toLowerCase()));
   function scan(){setBatchSide('');setComparison(null);setMessage('');void act('smart-plan')}
   const status=syncStatus(state);
   const running=!!state?.running;
   function primaryAction(){
    if(state?.starting||state?.stopping)return;
    if(running){
     reviewAfterPause.current=reviewing;
     void act('smart-stop');return;
    }
    if(setup){void act('smart-init',{createRemote:true,planToken:setup.token});return}
    if(state?.initialized){void act('smart-start');return}
    if(plan?.token){void act('smart-init',{planToken:plan.token});return}
    scan();
   }
   function openReview(){
    if(reviewing){setReviewing(false);setComparison(null);setPlan(null);return}
    if(running){setPlan(null);setReviewing(true);return}
    scan();
   }
   const canWrite=!running&&!state?.starting&&!state?.stopping;
   const progress=busy?taskProgress:running?state?.progress:null;
   const progressTitle=busy?operation:state?.stopping?'等待当前操作结束':state?.starting?'启动中':running?(state?.report?.error?'等待重试':syncStages[progress?.phase]||'等待同步进程'):state?.initialized?'已暂停':'就绪';
   const ratio=progress?.total?Math.min(1,progress.current/progress.total):0;
   const bar='['+'#'.repeat(Math.floor(ratio*20))+'.'.repeat(20-Math.floor(ratio*20))+']';
   const terminalStatus=progress?.total?bar+' '+progress.current+'/'+progress.total+' '+progressTitle:'[ '+progressTitle+' ]';
   const onPage=visible.slice(page*50,page*50+50);
   const canSelect=row=>canWrite&&['conflict','upload','download','delete-local','delete-remote'].includes(row.status)&&('left' in row)&&('right' in row);
   const eligible=onPage.filter(canSelect);
   const checked=rows.filter(row=>canSelect(row)&&selected.has(row.path));
   function toggleFiles(paths,include){
    setSelected(previous=>{
     const next=new Set(previous);
     for(const name of paths)if(include)next.add(name);else next.delete(name);
     return next;
    });
    setBatchSide('');
   }
   const expectedFor=row=>({left:row.left,right:row.right});
   function inspectFile(name,offset=0){
    void act('smart-inspect',{diffPath:name,diffOffset:offset,diffOnly:true});
   }
   const renderComparison=()=>comparison&&h('div',{ref:resultRef,style:{padding:10,border:'1px solid #d97757',borderRadius:8}},
    h('strong',{style:{overflowWrap:'anywhere'}},comparison.path),
    h('p',null,'服务器 → 本地',h('span',{style:{color:'#ffaaaa',marginLeft:12}},'− 删除'),h('span',{style:{color:'#a9e7b7',marginLeft:12}},'+ 新增')),
    comparison.differences?h('pre',{style:{maxHeight:390,overflow:'auto',background:'#0003',whiteSpace:'pre-wrap',overflowWrap:'anywhere',margin:'8px 0'}},
     comparison.differences.split('\n').filter((line,index,lines)=>index<lines.length-1||line).map((line,index)=>{
      const header=/^(--- 服务器|\+\+\+ 本地)$/.test(line);
      const removed=!header&&line.startsWith('-'),added=!header&&line.startsWith('+');
      return h('span',{key:index,style:{display:'block',padding:'0 6px',minHeight:'1em',background:added?'#204330':removed?'#532b2d':undefined,color:added?'#b5f5c4':removed?'#ffc0c0':line.startsWith('@@')?'#a6caff':undefined}},line);
     })):h('p',null,comparison.left.kind==='binary'||comparison.right.kind==='binary'?'此文件没有可显示的文本差异。':'两端没有文本行差异。'),
    comparison.next_diff_offset!==undefined&&button('查看后续差异',()=>inspectFile(comparison.path,comparison.next_diff_offset)),
    h('div',null,button('保留本地版本',()=>setChoice('left'),false,!canWrite),button('保留服务器版本',()=>setChoice('right'),false,!canWrite),button('稍后处理',()=>{setComparison(null);setSelectedPath('');setChoice('')})),
    choice&&h('div',null,h('p',null,'确认以'+(choice==='left'?'本地':'服务器')+'为准同步此文件？'+(comparison[choice].kind==='missing'?'这会删除另一侧文件。':'另一侧内容会被替换。')+'原版本会备份。'),
     button('确认处理此文件',()=>act('smart-resolve-batch',{items:[{path:comparison.path,side:choice,expected:{left:comparison.left.raw,right:comparison.right.raw}}]}),true,!canWrite),button('取消',()=>setChoice(''))));
   return h(React.Fragment,null,h('section',{className:'sync-card'},
    h('div',{className:'sync-card-heading'},h('strong',null,'自动同步'),
     h('button',{type:'button',className:'sync-pill','data-tone':status.tone,disabled:busy||(!state?.initialized&&!rows.length),onClick:openReview},status.text)),
    h('button',{type:'button',className:'sync-primary','data-running':running,disabled:busy||!!state?.starting||!!state?.stopping||(!running&&legacyActive),onClick:primaryAction},
     busy?operation+'…':state?.stopping?'暂停中…':state?.starting?'启动中…':running?'暂停同步':setup?(setup.kind==='new'?'创建并同步':'同步到空项目'):plan?.token&&!state?.initialized?'确认开启':'开启自动同步'),
    setup&&h('div',{className:'sync-line'},h('small',null,(setup.kind==='new'?'新建服务器项目 ':'空项目 ')+setup.project),button('取消',()=>setSetup(null))),
    legacyActive&&!running&&h('small',{role:'status'},'先暂停旧版同步'),
    (error||state?.report?.error)&&h('div',{role:'alert',className:'sync-error'},error||state.report.error),
    message&&h('small',{role:'status'},message),
    reviewing&&h('div',{className:'sync-review'},
     h('div',{className:'sync-line'},h('strong',null,state?.initialized?'检查差异':'首次同步'),
      h('small',null,rows.length?rows.length+' 项差异':'两端一致'),
      !running&&button('重新检查',scan),button('收起',()=>{setReviewing(false);setPlan(null);setComparison(null);setBatchSide('')})),
     !state?.initialized&&plan&&!plan.token&&h('small',null,'开启前需重新检查'),
     h('input',{placeholder:'筛选差异文件',value:query,onChange:e=>{setQuery(e.target.value);setPage(0)},style:{width:'100%',boxSizing:'border-box'}}),

     plan&&canWrite&&h('div',{style:{display:'flex',alignItems:'center',flexWrap:'wrap',gap:6,margin:'8px 0'}},
      h('label',null,h('input',{type:'checkbox',checked:eligible.length>0&&eligible.every(row=>selected.has(row.path)),disabled:busy||!eligible.length,onChange:e=>toggleFiles(eligible.map(row=>row.path),e.target.checked)}),'全选本页'),
      h('small',null,'已选 '+checked.length+' 项'),
      button('批量保留本地',()=>setBatchSide('left'),false,!checked.length||checked.length>200||checked.some(row=>row.left===null)),
      button('批量保留服务器',()=>setBatchSide('right'),false,!checked.length||checked.length>200||checked.some(row=>row.right===null)),
      button('清空选择',()=>{setSelected(new Set());setBatchSide('')},false,!checked.length)),
     checked.length>200&&h('small',null,'每批最多 200 项'),
     batchSide&&h('div',{style:{padding:8,border:'1px solid #d97757',borderRadius:6}},
      h('p',null,'保留 '+checked.length+' 项'+(batchSide==='left'?'本地':'服务器')+'版本？'),
      button('确认批量处理',()=>act('smart-resolve-batch',{items:checked.map(row=>({path:row.path,side:batchSide,expected:expectedFor(row)}))}),true),
      button('取消',()=>setBatchSide(''))),

     onPage.map(row=>h('div',{key:row.path,style:{padding:'6px 0',borderBottom:'1px solid #8883'}},
      h('div',{style:{display:'flex',gap:8,alignItems:'center'}},
       canSelect(row)&&h('input',{type:'checkbox','aria-label':'选择 '+row.path,checked:selected.has(row.path),disabled:busy,onChange:e=>toggleFiles([row.path],e.target.checked)}),
       h('span',{style:{flex:1,minWidth:0,overflowWrap:'anywhere'}},row.path,h('small',{style:{display:'block',color:'#d9a68c'}},labels[row.status]||row.status)),
       button(selectedPath===row.path&&busy?'正在读取…':'查看两端',()=>inspectFile(row.path))),
      fileErrors[row.path]&&h('small',{role:'alert',style:{color:'#efa98e'}},fileErrors[row.path]),
      selectedPath===row.path&&busy&&h('p',{role:'status'},operation+' · '+elapsed+' 秒'),
      selectedPath===row.path&&comparison?.path===row.path&&renderComparison())),
     h('div',null,page>0&&button('上一页',()=>setPage(page-1)),(page+1)*50<visible.length&&button('下一页',()=>setPage(page+1))),
     query&&!visible.length&&h('small',null,'无匹配文件')),
    h('details',null,h('summary',{style:{cursor:'pointer'}},'同步设置'),
    h('details',null,h('summary',null,'后缀规则'),
    draft.presets.map((row,i)=>h('div',{key:i,style:{borderBottom:'1px solid #8883',paddingBottom:8}},
     h('label',null,h('input',{type:'checkbox',checked:row.enabled,disabled:busy,onChange:e=>update(i,{enabled:e.target.checked})}),'同步此组'),
     h('input',{value:row.name,placeholder:'分组名称',disabled:busy,onChange:e=>update(i,{name:e.target.value}),style:{width:'50%',marginLeft:8}}),
     h('input',{value:row.extensionText??row.extensions.join(', '),placeholder:'.py, .md, .tar.gz',disabled:busy,onChange:e=>update(i,{extensionText:e.target.value}),style:{width:'100%',boxSizing:'border-box',marginTop:6}}),
     h('label',null,'单文件上限 MiB ',h('input',{type:'number',min:0.001,max:1024,value:row.max_mib,disabled:busy,onChange:e=>update(i,{max_mib:Number(e.target.value)}),style:{width:90}})),
     button('删除分组',()=>setDraft({...draft,presets:draft.presets.filter((_,n)=>n!==i)})))),
    button('增加后缀分组',()=>setDraft({...draft,presets:[...draft.presets,{name:'自定义',extensions:[],enabled:true,max_mib:100}]})),
    number('其他文件上限 MiB','maxMiB'),
    h('label',null,'忽略规则（每行一条）',h('textarea',{rows:4,value:draft.ignoreText??(draft.ignores||[]).join('\n'),disabled:busy,onChange:e=>setDraft({...draft,ignoreText:e.target.value}),style:{width:'100%',boxSizing:'border-box',background:'#8881',color:'inherit'}}))),
    h('label',null,h('input',{type:'checkbox',checked:!!draft.autoMerge,disabled:busy,onChange:e=>setDraft({...draft,autoMerge:e.target.checked})}),' 自动合并不重叠修改'),
    h('details',null,h('summary',null,'备份'),number('保留天数','retentionDays'),number('预算 MiB','retentionMiB'),number('保留版本','keepVersions')),
    button('保存',()=>act('smart-save')))),
    h('div',{className:'sync-terminal',role:'log','aria-label':'同步终端'},
     terminalLines.map((line,index)=>h('div',{key:index,className:'sync-terminal-line'},
      h('span',{className:'sync-terminal-mark','data-status':line.status,'aria-label':{active:'进行中',done:'完成',failed:'失败'}[line.status]},
       {active:'>',done:'✓',failed:'×'}[line.status]),
      h('span',null,line.text,line.detail?' · '+line.detail:''))),
     progress?.path&&h('div',null,'文件 '+progress.path),
     h('div',null,terminalStatus+(busy?' · '+elapsed+' 秒':''))));

  }

  function SyncPanel({rpc,cfg,workspace,back,terminal,onSyncState}){
   const [data,setData]=React.useState({branch:'',changes:[]}),[sel,select]=React.useState(new Set()),[q,filter]=React.useState(''),[msg,message]=React.useState(''),[busy,lock]=React.useState(false),[notice,note]=React.useState(''),[confirm,review]=React.useState('');
   const guard=React.useRef(false);
   const [watch,setWatch]=React.useState(null),[watchError,setWatchError]=React.useState('');
   const [syncDraft,setSyncDraft]=React.useState(null),[settingsOpen,setSettingsOpen]=React.useState(false);
   const [syncPending,setSyncPending]=React.useState('');
   const [legacyOpen,setLegacyOpen]=React.useState(false);
   const statusLabels={watching:'正在监听文件变化',scanning:'扫描文件',reconciling:'比较两端修改','staging-alpha':'上传到服务器','staging-beta':'下载到本地','connecting-alpha':'连接服务器','connecting-beta':'连接本地',disconnected:'连接已断开',transitioning:'应用文件修改','waiting-for-rescan':'等待重新扫描'};
   function receiveWatch(result){setWatch(result);setSyncDraft(current=>current||{maxFileMiB:result.options.maxFileMiB,ignores:result.options.ignores.join('\n')})}

   React.useEffect(()=>{
    let alive=true,pending=false;
    async function read(){if(pending||guard.current)return;pending=true;try{const result=await rpc({...cfg,action:'watch-status'});if(alive){receiveWatch(result);setWatchError('')}}catch(e){if(alive)setWatchError(e.message)}finally{pending=false}}
    void read();const timer=setInterval(read,15000);return ()=>{alive=false;clearInterval(timer)};
   },[cfg.host,cfg.project,workspace?.path]);
   async function changeWatch(action){
    if(guard.current||!watch)return;
    guard.current=true;lock(true);setSyncPending('');
    try{
     const result=await rpc({...cfg,action,syncSettings:{maxFileMiB:Number(syncDraft.maxFileMiB),ignores:syncDraft.ignores.split('\n').map(p=>p.trim()).filter(Boolean)}});
     receiveWatch(result);setWatchError('');
    }catch(e){setWatchError(e.message)}finally{guard.current=false;lock(false)}
   }
   function switchWatch(){
    if(watch?.enabled)void changeWatch('watch-off');
    else if(watch?.mode==='two-way-safe'&&watch?.paused)void changeWatch('watch-on');
    else setSyncPending('watch-on');
   }
   const [stage,report]=React.useState(''),[seconds,elapsed]=React.useState(0);
   const startTime=React.useRef(0);
   React.useEffect(()=>{if(!busy)return;const t=setInterval(()=>elapsed(Math.floor((Date.now()-startTime.current)/1000)),1000);return ()=>clearInterval(t)},[busy]);
   const stages={prepare:'准备所选文件',check:'检查服务器',scan:'检查本地变更',commit:'创建本地提交',count:'统计对象',compress:'压缩对象',upload:'上传对象',confirm:'等待服务器确认',refresh:'刷新文件列表'};
   const parts=/^([a-z]+)(\d+)?$/.exec(stage);
   async function act(action){
    if(guard.current)return;guard.current=true;lock(true);review('');note('正在处理…');
    startTime.current=Date.now();elapsed(0);if(action==='push')report('prepare');
    try{let result=action==='list'?'':await rpc({...cfg,action,files:[...sel],message:msg},report);if(action==='push')report('refresh');
     const list=await rpc({...cfg,action:'list'});setData(list);select(new Set());note(result||'');
    }catch(e){note(String(e.message||e))}finally{report('');guard.current=false;lock(false)}
   }
   React.useEffect(()=>{if(legacyOpen)void act('list')},[legacyOpen]);
   const visible=data.changes.filter(x=>x.file.toLowerCase().includes(q.toLowerCase()));
   const button=(text,fn,disabled=false)=>h('button',{type:'button',onClick:fn,disabled:busy||disabled},text);
   const toggle=(paths,on)=>select(prev=>{const next=new Set(prev);for(const p of paths){if(on)next.add(p);else next.delete(p)}return next});
   return h('section',{className:'dsh-sync-pane'},
    h('header',null,button('‹ 工作台',back),h('strong',null,'文件同步'),button('打开本地终端',terminal)),
    h('div',{className:'sync-meta'},workspace?.title||cfg.project),
    h(SmartSyncPanel,{rpc,cfg,legacyActive:watch?.enabled,onSyncState}),
    h('details',{className:'sync-legacy',onToggle:e=>setLegacyOpen(e.currentTarget.open)},h('summary',null,'旧版同步'),
    h('input',{placeholder:'按文件路径筛选',value:q,onChange:e=>filter(e.target.value)}),
    h('div',{className:'sync-line'},h('span',null,visible.length+' 项 · 已选 '+sel.size),button('刷新',()=>act('list')),button('全选全部 '+data.changes.length+' 项',()=>toggle(data.changes.map(x=>x.file),true)),button('选择筛选结果',()=>toggle(visible.map(x=>x.file),true)),button('清空选择',()=>select(new Set()))),
    h('label',{className:'sync-meta'},h('input',{type:'checkbox',checked:!!watch?.enabled,disabled:busy||!watch,onChange:switchWatch}),' '+(watch?.mode==='one-way-safe'?'旧版单向回传':'Mutagen 双向同步')+'（兼容模式）'),
    h('small',{role:'status'},watchError || ((watch?.paused?'已暂停 · ':'')+(watch?.mode==='one-way-safe'?'服务器 → 本地 · ':'本地 ↔ 服务器 · ')+(statusLabels[watch?.status]||watch?.status||'读取状态')+' · 冲突 '+(watch?.conflicts||0))),
    watch?.mode==='one-way-safe'&&button('升级为双向同步',()=>setSyncPending('watch-on')),
    watch?.problems?.length>0&&h('div',{role:'alert'},watch.problems.map((p,i)=>h('p',{key:i,style:{overflowWrap:'anywhere',color:'#efa98e'}},p))),
    watch?.conflicts>0&&h('details',null,h('summary',null,'查看冲突 · '+watch.conflicts+' 项'),
     h('ul',null,watch.conflictPaths.map(p=>h('li',{key:p,style:{overflowWrap:'anywhere'}},p))),
     watch.conflicts>watch.conflictPaths.length&&h('small',null,'此处显示前 '+watch.conflictPaths.length+' 项，处理后刷新可继续查看其余冲突。')),
    button(settingsOpen?'收起设置':'同步设置',()=>setSettingsOpen(!settingsOpen)),
    settingsOpen&&syncDraft&&h('div',{style:{display:'grid',gap:8}},
     h('label',null,'单文件传输上限（MiB） ',h('input',{type:'number',min:1,max:102400,value:syncDraft.maxFileMiB,disabled:busy,onChange:e=>setSyncDraft({...syncDraft,maxFileMiB:e.target.value})})),
     h('label',null,'忽略规则（每行一个，作用于两端）',h('textarea',{rows:7,value:syncDraft.ignores,disabled:busy,onChange:e=>setSyncDraft({...syncDraft,ignores:e.target.value}),style:{width:'100%',boxSizing:'border-box',background:'#8881',color:'inherit',border:'1px solid #8885',borderRadius:6}})),
     button('应用设置',()=>setSyncPending('watch-apply'))),
    syncPending&&h('div',{style:{padding:10,border:'1px solid #d97757',borderRadius:8}},
     h('p',null,'重新扫描两端并保留冲突文件？'),
     button('取消',()=>setSyncPending('')),button(syncPending==='watch-on'?'确认开启双向同步':'确认应用设置',()=>changeWatch(syncPending))),
    h('div',{className:'sync-files'},visible.map(x=>h('label',{key:x.file,title:x.file},h('input',{type:'checkbox',checked:sel.has(x.file),disabled:busy,onChange:e=>toggle([x.file],e.target.checked)}),h('small',null,x.status==='??'?'新增':x.status.trim()),h('span',null,x.file)))),
    h('input',{placeholder:'提交说明（勾选文件时必填）',value:msg,onChange:e=>message(e.target.value)}),
    confirm?h('div',null,h('p',null,confirm==='push'?'确认远程 Claude 已空闲。将推送当前分支已有提交和勾选的 '+sel.size+' 个文件。':'将远程分支快进合并到当前本地分支。'),button('取消',()=>review('')),button('确认'+(confirm==='push'?'推送':'拉取'),()=>act(confirm))):h('footer',null,button('拉取远程提交',()=>review('pull')),button('推送到服务器',()=>review('push'),sel.size>0&&!msg.trim())),
    parts && h('div',{role:'status'},h('div',null,stages[parts[1]],' · ',seconds,' 秒',parts[2]?' · '+parts[2]+'%':''),h('progress',{max:100,...(parts[2]?{value:Number(parts[2])}:{}),style:{width:'100%',accentColor:'#d97757'}})),
    h('output',{role:'status'},notice)));
  }

  const workspaceConfigEvent='dsh-remote-workspace-config';
  function workspaceConfig(workspaceId){
   try{return JSON.parse(localStorage.getItem(workspaceId?id+':'+workspaceId:id)||'null')}
   catch{return null}
  }
  function saveWorkspaceConfig(workspaceId,config){
   localStorage.setItem(workspaceId?id+':'+workspaceId:id,JSON.stringify(config));
   window.dispatchEvent(new CustomEvent(workspaceConfigEvent,{detail:workspaceId}));
  }
  const workspaceIcons={
   folder:'M2.5 5h5l2 2h8v9h-15z',
   connect:'M7 3v4m6-4v4M5 7h10v2a5 5 0 0 1-5 5v3',
   shell:'M4 6l4 4-4 4m6 0h6',
   sync:'M4 6h11m-3-3 3 3-3 3M16 14H5m3-3-3 3 3 3',
   image:'M3 4h14v12H3zM3 13l4-4 3 3 2-2 5 5',
  };
  function workspaceIcon(name){
   return h('svg',{viewBox:'0 0 20 20',width:16,height:16,fill:'none',stroke:'currentColor',
    strokeWidth:1.5,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},
    h('path',{d:workspaceIcons[name]}));
  }
  function Body({useTabInfo,launch,workspace,rpc,onSyncState,startInSync=false}){
   const tab=useTabInfo ? useTabInfo().tab : null;
   const workspaceId=workspace?.workspaceId;
   const [cfg,set]=React.useState(()=>workspaceConfig(workspaceId)||defaults());
   function defaults(){return {host:'',project:workspace?.remoteName || 'my-test',identity:''}}
   const [msg,notify]=React.useState(''),[opening,setOpening]=React.useState('');
   const [syncOpen,showSync]=React.useState(startInSync&&!!cfg.host);
   if(syncOpen)return h(SyncPanel,{rpc,cfg,workspace,onSyncState,back:()=>startInSync?tab.actions.openTab(kind,{replaceTab:true}):showSync(false),terminal:()=>tab.actions.openTab('terminal',{})});
   async function start(op){
    if(opening)return;
    notify('');
    try{
     if(!/^[\w][\w.@-]*$/.test(cfg.host))throw Error('请填写 SSH 主机');
     if(!/^\w[\w-]{0,47}$/.test(cfg.project))throw Error('请填写有效的远程目录名');
     if(/[\r\n\x00]/.test(cfg.identity))throw Error('请检查私钥路径');
     const previous=workspaceConfig(workspaceId);
     const sameConnection=previous?.host===cfg.host&&previous.project===cfg.project;
     const next={...cfg,connected:sameConnection&&previous.connected!==false};
     saveWorkspaceConfig(workspaceId,next);
     if(op==='sync'){showSync(true);return}
     setOpening(op);
     await launch(tab,op,cfg);
     if((op==='claude'||op==='shell')&&!next.connected)saveWorkspaceConfig(workspaceId,{...next,connected:true});
    }catch(error){notify(String(error.message||error))}
    finally{setOpening('')}
   }
   function field(key,label,placeholder){
    return h('label',{className:'connection-field'},h('span',null,label),
     h('input',{value:cfg[key],placeholder,autoComplete:'off',spellCheck:false,disabled:!!opening,onChange:e=>set({...cfg,[key]:e.target.value})}));
   }
   return h('section',{className:'dsh-claude-workspace',onPaste:e=>{
    if([...e.clipboardData.items].some(item=>item.type.startsWith('image/'))){e.preventDefault();void start('image')}
   }},
    h('header',null,h('h2',null,'Claude 工作区')),
    h('div',{className:'connection-project'},
     h('span',{className:'connection-project-icon'},workspaceIcon('folder')),
     h('div',null,h('strong',null,workspace?.title||'本地项目'),
      workspace&&h('div',{className:'connection-path',title:workspace.path},workspace.path))),
    h('form',{className:'sync-card connection-card',onSubmit:e=>{e.preventDefault();void start('claude')}},
     h('h3',null,'远程接入'),
     h('div',{className:'connection-fields'},field('host','SSH 主机','用户名@主机 或 SSH 别名'),field('project','远程目录','目录名')),
     h('details',null,h('summary',null,'SSH 私钥',cfg.identity&&h('small',null,'已设置')),
      field('identity','私钥路径','使用默认 SSH 配置时留空')),
     workspace&&h('label',{className:'connection-local-tools'},
      h('input',{type:'checkbox',checked:cfg.localTools!==false,disabled:!!opening,
       onChange:e=>set({...cfg,localTools:e.target.checked})}),
      '在本机工作区执行'),
     h('button',{type:'submit',className:'connection-primary',disabled:!!opening},
      opening==='claude'?'正在接入…':'接入 Claude'),
     h('div',{className:'connection-tools'},
      ...[['shell','服务器终端'],['sync','文件同步'],['image','上传图片']].map(([op,label])=>
       h('button',{key:op,type:'button',title:op==='image'?labels.image:label,disabled:!!opening,onClick:()=>start(op)},
        workspaceIcon(op),h('span',null,opening===op?'处理中…':label)))),
     msg&&h('output',{role:'alert',className:'sync-error'},msg)));
  }
  function apply(ctx){
   async function launch(session,tab,op,cfg){
    const choices=await ctx.webTerminals.launchShells(session,new AbortController().signal);
    const ps=choices.shells.find(s=>/(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(s.path));if(!ps)throw Error('当前 DSH 环境没有 Windows PowerShell 终端');
    const token=crypto.randomUUID();
    const route=['claude','image'].includes(op)?await syncRequest(ctx,session,{...cfg,identity:cfg.identity||'',action:'bind-chat',sessionId:session}):{};
    tab.actions.openTab('terminal',{params:{shellPath:ps.path,dshRemoteLaunch:token,dshRemoteOperation:op}});
    for(let n=0;n<150;n++){
     for(const t of ctx.sidebarRight.openTabs.getSnapshot()){
      if(t.sessionId!==session||t.kind!=='terminal')continue;
      const nav=ctx.sidebarRight.tabDomain.occurrence(session,{id:t.tabId}).navigation.getSnapshot();
      if(nav.params?.dshRemoteLaunch!==token)continue;
      const model=ctx.webTerminals.view(session,t.tabId,nav.address,nav.params.terminalId,ps.path);
      if(!model.state.getSnapshot()?.writable)continue;
      const request={...route,action:op,host:cfg.host,project:cfg.project,identity:cfg.identity||''};
      if(op==='claude'&&cfg.localTools!==false){
       const workspace=workspaces().find(w=>w.sessionIds.includes(session));
       if(!workspace?.path)throw Error('请先打开本地文件夹工作区');
       request.localWorkspace=workspace.path;
      }
      model.rename('Claude · '+(op==='shell'?'服务器 Terminal':labels[op])+' · '+cfg.project);
      model.write(launchCommand(request));
      if(op==='claude'){
       const pane=document.querySelector('div[data-sidebar-right-tab="'+CSS.escape(t.tabId)+'"]');
       const target=pane && ctx.sidebarRight.focusedTarget(pane);
       if(target?.sessionId===session && pane.closest('[data-sidebar-right-panel="fullscreen"]'))ctx.sidebarRight.toggleFullscreen(target);
       document.querySelector('[data-composer-input]')?.focus();
      }
      return;
     }
     await new Promise(r=>setTimeout(r,100));
    }
    throw Error('新终端未就绪，请检查本地 DSH 终端服务。');
   }

   const registryKey=id+':folders';
   const info=w=>{
    if(typeof w?.path!=='string'||!w.path)return;
    const path=w.path.replaceAll('\\','/').replace(/\/$/,'');
    let remoteName;
    try{remoteName=JSON.parse(localStorage.getItem(registryKey)||'{}')[path.toLowerCase()]?.remoteName}catch{}
    const name=path.split('/').pop()||'project';
    const slug=name.toLowerCase().replace(/[^a-z0-9_]+/g,'-').replace(/^-+|-+$/g,'').slice(0,28)||'project';
    const suffix=String(w.workspaceId||'').replace(/[^a-z0-9]/gi,'').slice(-10);
    return {...w,title:w.title||name,remoteName:remoteName||slug+(suffix?'-'+suffix:'')};
   };
   const workspaces=()=>ctx.workspaces.list.getSnapshot().items;
   async function openFolder(ws,tabKind=kind){
    await ctx.uiWorkspace.openWorkspace(ws.workspaceId);
    for(let i=0;i<120;i++){
     const target=ctx.sidebarRight.commandTarget(null);
     if(target && workspaces().find(w=>w.workspaceId===ws.workspaceId)?.sessionIds.includes(target.sessionId)){
      ctx.sidebarRight.openTabFromTarget(tabKind,target);return;
     }
     await new Promise(r=>setTimeout(r,100));
    }
    throw Error('本地工作区尚未就绪，请重试');
   }
   const badgeStates=new Map();
   function setWorkspaceBadge(workspaceId,state){
    if(!workspaceId)return;
    const config=workspaceConfig(workspaceId);
    if(config?.host&&config.connected===false&&(state.initialized||state.running||state.starting)){
     saveWorkspaceConfig(workspaceId,{...config,connected:true});
    }
    badgeStates.set(workspaceId,syncStatus(state));
    const row=document.querySelector('[data-row-key="'+CSS.escape('workspace:'+workspaceId)+'"]');
    const badge=row?.querySelector('[data-dsh-claude-control=sync-status]');
    if(badge)paintBadge(badge,badgeStates.get(workspaceId));
   }
   function paintBadge(badge,status){
    const {text,tone}=status||syncStatus(null);
    if(badge.textContent!==text)badge.textContent=text;
    badge.dataset.tone=tone;
    badge.title=text+' · 打开文件同步';
    badge.setAttribute('aria-label',badge.title);
   }
   // The Claude starburst is from the wordmark on https://claude.com/.
   const claudeStarburst = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 125 125"><path fill="#d97757" d="M54.375 118.75L56.125 111L58.125 101L59.75 93L61.25 83.125L62.125 79.875L62 79.625L61.375 79.75L53.875 90L42.5 105.375L33.5 114.875L31.375 115.75L27.625 113.875L28 110.375L30.125 107.375L42.5 91.5L50 81.625L54.875 76L54.75 75.25H54.5L21.5 96.75L15.625 97.5L13 95.125L13.375 91.25L14.625 90L24.5 83.125L49.125 69.375L49.5 68.125L49.125 67.5H47.875L43.75 67.25L29.75 66.875L17.625 66.375L5.75 65.75L2.75 65.125L0 61.375L0.25 59.5L2.75 57.875L6.375 58.125L14.25 58.75L26.125 59.5L34.75 60L47.5 61.375H49.5L49.75 60.5L49.125 60L48.625 59.5L36.25 51.25L23 42.5L16 37.375L12.25 34.75L10.375 32.375L9.625 27.125L13 23.375L17.625 23.75L18.75 24L23.375 27.625L33.25 35.25L46.25 44.875L48.125 46.375L49 45.875V45.5L48.125 44.125L41.125 31.375L33.625 18.375L30.25 13L29.375 9.75C29.0417 8.625 28.875 7.375 28.875 6L32.75 0.750006L34.875 0L40.125 0.750006L42.25 2.625L45.5 10L50.625 21.625L58.75 37.375L61.125 42.125L62.375 46.375L62.875 47.75H63.75V47L64.375 38L65.625 27.125L66.875 13.125L67.25 9.125L69.25 4.375L73.125 1.87501L76.125 3.25L78.625 6.875L78.25 9.125L76.875 18.75L73.875 33.875L72 44.125H73.125L74.375 42.75L79.5 36L88.125 25.25L91.875 21L96.375 16.25L99.25 14H104.625L108.5 19.875L106.75 26L101.25 33L96.625 38.875L90 47.75L86 54.875L86.375 55.375H87.25L102.125 52.125L110.25 50.75L119.75 49.125L124.125 51.125L124.625 53.125L122.875 57.375L112.625 59.875L100.625 62.25L82.75 66.5L82.5 66.625L82.75 67L90.75 67.75L94.25 68H102.75L118.5 69.125L122.625 71.875L125 75.125L124.625 77.75L118.25 80.875L109.75 78.875L89.75 74.125L83 72.5H82V73L87.75 78.625L98.125 88L111.25 100.125L111.875 103.125L110.25 105.625L108.5 105.375L97 96.625L92.5 92.75L82.5 84.375H81.875V85.25L84.125 88.625L96.375 107L97 112.625L96.125 114.375L92.875 115.5L89.5 114.875L82.25 104.875L74.875 93.5L68.875 83.375L68.25 83.875L64.625 121.625L63 123.5L59.25 125L56.125 122.625L54.375 118.75Z"/></svg>';
   const modelTrigger = '[data-composer-card] [class*="_triggerLabel"] > [data-model-id]';
   const claudeChoice = modelTrigger+'[data-provider-id="dsh-remote-claude"]';
   const heroMark = ' [class*="_fishHitbox"]';
   const claudeHero = '[data-composer-seat]:has('+claudeChoice+')'+heroMark;
   const deepseekHero = '[data-composer-seat]:has('+modelTrigger+'):not(:has('+claudeChoice+'))'+heroMark;
   const css=document.createElement('style');
   css.textContent=`
    ${claudeHero}{position:relative}
    ${claudeHero}>*{visibility:hidden}
    ${claudeHero}::after{content:'';position:absolute;inset:0;pointer-events:none;background:url("data:image/svg+xml,${encodeURIComponent(claudeStarburst)}") center/contain no-repeat}
    @media(prefers-reduced-motion:no-preference){${claudeHero}::after,${deepseekHero}{animation:dsh-claude-mark-in 160ms ease-out}}
    @keyframes dsh-claude-mark-in{from{opacity:0;transform:scale(.86)}to{opacity:1;transform:scale(1)}}

    .dsh-sync-pane{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;gap:8px;padding:14px;color:inherit;overflow:auto}
    .dsh-sync-pane header,.dsh-sync-pane footer,.sync-line{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.dsh-sync-pane header strong{flex:1;color:#d97757}.sync-meta,.dsh-sync-pane output{font-size:12px;overflow-wrap:anywhere}.dsh-sync-pane output{white-space:pre-wrap}
    .dsh-sync-pane button,.dsh-sync-pane>input{color:inherit;background:#8881;border:1px solid #8885;border-radius:6px;padding:5px 9px}.dsh-sync-pane button{cursor:pointer}.dsh-sync-pane button:disabled{opacity:.5}.dsh-sync-pane footer button:last-child{background:#d97757;color:#201611}
    .sync-terminal{margin:0;padding:10px;border:1px solid #8884;border-radius:7px;background:#000;color:#fff;min-height:54px;max-height:145px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.45 monospace}
    .sync-terminal-line{display:flex;align-items:baseline;gap:8px}
    .sync-terminal-mark{flex:0 0 1ch}
    .sync-terminal-mark[data-status=done]{color:#54d36b}
    .sync-terminal-mark[data-status=failed]{color:#ff7070}
    .sync-terminal-mark[data-status=active]{animation:dsh-sync-blink 1s step-end infinite}
    @keyframes dsh-sync-blink{50%{opacity:0}}
    @media(prefers-reduced-motion:reduce){.sync-terminal-mark[data-status=active]{animation:none}}
    .sync-card{display:grid;gap:10px;padding:12px;border:1px solid #8884;border-radius:10px;background:#8881}
    .sync-card-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}
    .sync-pill,[data-dsh-claude-control=sync-status]{font-size:11px!important;white-space:nowrap;padding:2px 6px!important;border:1px solid #8885!important;border-radius:5px;color:#b8bbc1!important;background:#8881!important}
    [data-tone=running].sync-pill,[data-dsh-claude-control=sync-status][data-tone=running]{color:#9fe3b3!important;border-color:#55a66c66!important;background:#55a66c22!important}
    [data-tone=warning].sync-pill,[data-dsh-claude-control=sync-status][data-tone=warning]{color:#f0bf7e!important;border-color:#be8b4666!important;background:#be8b4622!important}
    [data-dsh-claude-control=sync-status]{flex:none;margin-inline:5px}
    [data-dsh-claude-control=connect]{color:var(--dsw-alias-label-tertiary,#a5a9b0);border:0;background:transparent;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
    [data-dsh-claude-control=connect]:hover{color:var(--dsw-alias-label-primary,#fff)}
    html[data-input-modality=keyboard] [data-row-key^="workspace:"]:focus-within > [class*="_rowActions"]:has([data-dsh-claude-control=connect]){display:inline-flex}
    .dsh-sync-pane .sync-primary{min-height:38px;font-weight:650;background:#d97757;color:#201611}
    .dsh-sync-pane .sync-primary[data-running=true]{background:#49835b;color:#fff}
    .sync-review{display:grid;gap:8px;padding-top:8px;border-top:1px solid #8884}
    .sync-review>input{box-sizing:border-box;width:100%}
    .sync-error{color:#efa98e;overflow-wrap:anywhere;font-size:12px}
    .sync-card summary,.sync-legacy summary{cursor:pointer;color:#c5c8ce;font-size:13px}
    .sync-legacy[open]>summary{margin-bottom:10px}
    .sync-legacy>input,.sync-legacy>small,.sync-legacy>.sync-line,.sync-legacy>footer{margin:6px 0}
    .sync-files{flex:1;min-height:100px;overflow:auto;border-block:1px solid #8884}.sync-files label{display:flex;align-items:center;gap:8px;padding:4px}.sync-files label:hover{background:#8882}.sync-files input{accent-color:#d97757}.sync-files small{color:#d97757}.sync-files span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

    [data-dsh-claude-control=commands]{display:flex;gap:12px;align-items:start;flex:none;padding:6px 10px;color:#d97757;background:#d9775712;font-size:12px}
    [data-dsh-claude-control=commands] summary{cursor:pointer;font-weight:650;list-style:none}
    [data-dsh-claude-control=commands] details[open]{display:grid;gap:5px}
    [data-dsh-claude-control=commands] button{display:block;text-align:left}
    button:has(.dsh-claude-mark),[role=button]:has(.dsh-claude-mark){color:#d97757}
    button:has(.dsh-claude-mark):hover,button[aria-current]:has(.dsh-claude-mark){background:#d9775722}
    .dsh-claude-workspace{box-sizing:border-box;display:grid;align-content:start;gap:12px;padding:14px;width:100%;height:100%;overflow:auto}
    .dsh-claude-workspace>*{width:100%;max-width:720px;min-width:0;box-sizing:border-box}
    .dsh-claude-workspace h2{margin:0;color:#d97757;font-size:16px;font-weight:650}
    .connection-project{display:flex;align-items:center;gap:10px;padding:2px 0}
    .connection-project-icon{display:grid;place-items:center;flex:0 0 34px;height:34px;border:1px solid #8884;border-radius:8px;background:#8881;color:#c5c8ce}
    .connection-project>div{min-width:0}
    .connection-project strong{display:block;font-size:15px;overflow-wrap:anywhere}
    .connection-path{font-size:12px;color:#a5a9b0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}
    .connection-card{gap:12px}
    .connection-card h3{margin:0;font-size:15px;font-weight:650}
    .connection-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr));gap:10px}
    .connection-field{display:grid;min-width:0;gap:5px;font-size:12px;color:#c5c8ce}
    .connection-field input{box-sizing:border-box;min-width:0;width:100%;height:34px;padding:6px 9px;border:1px solid #8885;border-radius:6px;background:#0002;color:var(--text-primary,#eee);font:inherit;font-size:13px}
    .connection-card details[open]>summary{margin-bottom:8px}
    .connection-card summary small{margin-left:8px;color:#a5a9b0}
    .connection-local-tools{display:flex;align-items:center;gap:7px;font-size:12px;color:#c5c8ce}
    .connection-local-tools input{accent-color:#d97757}
    .connection-card button{min-height:34px;padding:6px 9px;border:1px solid #8885;border-radius:6px;background:#8881;color:inherit;font:inherit;cursor:pointer}
    .connection-card button:disabled{opacity:.55;cursor:default}
    .connection-card .connection-primary{min-height:38px;background:#d97757;color:#201611;border-color:transparent;font-weight:650}
    .connection-tools{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,112px),1fr));gap:8px}
    .connection-tools button{display:flex;align-items:center;justify-content:center;gap:6px;font-size:12px;white-space:nowrap}
    .connection-tools svg{flex:none;color:#b8bbc1}
    .connection-tools button:hover:not(:disabled){background:#8883}
    .dsh-claude-workspace :focus-visible{outline:2px solid #d97757;outline-offset:1px}
    [data-dockkit-tab]:has(.dsh-claude-tab),[data-dockkit-tab][title^="Claude ·"]{color:#d97757}
   `;
      ctx.effect(()=>{
    const makeButton=(label,callback,role)=>{
     const button=document.createElement('button');button.type='button';button.dataset.dshClaudeControl=role;
     button.textContent=label;button.title=label;button.style.cssText='color:#d97757;background:transparent;border:0;cursor:pointer;font:inherit;padding:2px 5px;white-space:nowrap';
     button.onclick=e=>{e.stopPropagation();Promise.resolve(callback()).catch(err=>window.alert(err.message))};
     return button;
    };

    function decorateClaudeTerminals(){
     for(const root of document.querySelectorAll('[data-sidebar-terminal]')){
      if(root.querySelector('[data-dsh-claude-control=commands]'))continue;
      const tabId=root.closest('[data-sidebar-right-tab]')?.dataset.sidebarRightTab;
      const owner=ctx.sidebarRight.openTabs.getSnapshot().find(t=>t.tabId===tabId && t.kind==='terminal');
      if(!owner)continue;
      const navigation=()=>ctx.sidebarRight.tabDomain.occurrence(owner.sessionId,{id:tabId}).navigation.getSnapshot();
      const nav=navigation(),params=nav.params;
      if(params?.dshRemoteOperation!=='claude'||!params.dshRemoteLaunch)continue;
      const bar=document.createElement('div');bar.dataset.dshClaudeControl='commands';
      const menu=document.createElement('details'), summary=document.createElement('summary'),note=document.createElement('span');
      summary.textContent='Claude Code ▾';menu.append(summary);bar.append(menu,note);note.setAttribute('role','status');
      for(const [label,cmd] of [['选择模型','/model'],['历史对话','/resume'],['会话状态','/status']]){
       menu.append(makeButton(label+'  '+cmd,()=>{
        menu.open=false;
        if(navigation().params?.dshRemoteLaunch!==params.dshRemoteLaunch)return;
        const model=ctx.webTerminals.view(owner.sessionId,tabId,nav.address,params.terminalId,params.shellPath);
        const cursor=root.querySelector('.xterm-rows .xterm-cursor');
        const row=cursor?.closest('.xterm-rows > div');
        // Fail closed on SSH prompts, pickers, permission dialogs and non-empty input.
        if(!model.state.getSnapshot()?.writable || !row || !/^❯\s*$/u.test(row.textContent.trim())){
         note.textContent='请在 Claude 空输入提示符处使用；也可直接键入 '+cmd;return;
        }
        model.write(cmd);root.querySelector('.xterm-helper-textarea')?.focus();
        note.textContent='已填入 '+cmd+'，按 Enter 执行';
       },'slash'));
      }
      root.prepend(bar);
     }
    }
    function decorate(){
     decorateClaudeTerminals();
     for(const w of workspaces().filter(info)){
      const row=document.querySelector('[data-row-key="'+CSS.escape('workspace:'+w.workspaceId)+'"]');
      const actions=row?.querySelector(':scope > [class*="_rowActions"]');
      if(!actions)continue;
      if(!actions.querySelector('[data-dsh-claude-control=connect]')){
       const icon=makeButton('接入 Claude',()=>openFolder(w),'connect');
       icon.className=actions.querySelector('button')?.className||'';
       icon.removeAttribute('style');
       icon.setAttribute('aria-label','接入 Claude');
       const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
       for(const [key,value] of Object.entries({viewBox:'0 0 20 20',width:'14',height:'14',fill:'none',
        stroke:'currentColor','stroke-width':'1.5','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(key,value);
       const shape=document.createElementNS(svg.namespaceURI,'path');
       shape.setAttribute('d',workspaceIcons.connect);
       svg.append(shape);icon.replaceChildren(svg);
       actions.prepend(icon);
      }
      const config=workspaceConfig(w.workspaceId);
      let badge=row.querySelector('[data-dsh-claude-control=sync-status]');
      if(!config?.host||!config.project||config.connected===false){badge?.remove();continue}
      if(!badge){
       badge=makeButton('未同步',()=>openFolder(w,syncKind),'sync-status');
       paintBadge(badge,badgeStates.get(w.workspaceId));
       row.append(badge);
      }
     }
    }
    let disposed=false,reading=false;
    async function readBadges(){
     if(reading||disposed)return;
     const session=ctx.sidebarRight.commandTarget(null)?.sessionId;
     if(!session)return;
     const entries=workspaces().filter(info).flatMap(w=>{
      const config=workspaceConfig(w.workspaceId);
      return config?.host?[{id:w.workspaceId,path:w.path,host:config.host,project:config.project}]:[];
     });
     if(!entries.length)return;
     reading=true;
     try{
      const badges=await syncRequest(ctx,session,{action:'smart-badges',badgeEntries:entries});
      if(!disposed)for(const badge of badges){
       const entry=entries.find(item=>item.id===badge.id),config=workspaceConfig(badge.id);
       if(entry&&config?.host===entry.host&&config.project===entry.project)setWorkspaceBadge(badge.id,badge);
      }
     }catch{}finally{reading=false}
    }
    function refresh(){decorate();void readBadges()}
    function configChanged(event){badgeStates.delete(event.detail);refresh()}
    document.head.append(css);
    const off=ctx.workspaces.list.subscribe(refresh);
    const observer=new MutationObserver(decorate);observer.observe(document.body,{childList:true,subtree:true});
    window.addEventListener(workspaceConfigEvent,configChanged);
    refresh();const badgeTimer=setInterval(readBadges,15000);
    return ()=>{disposed=true;clearInterval(badgeTimer);observer.disconnect();off();
     window.removeEventListener(workspaceConfigEvent,configChanged);
     document.querySelectorAll("[data-dsh-claude-control]").forEach(el=>el.remove());css.remove()};
   });
   ctx.effect(()=>{
    const dock=document.createElement('details'),toggle=document.createElement('summary'),card=document.createElement('section');
    dock.className='dsh-quota';toggle.textContent='◴  Claude 额度';toggle.title='查看 Claude 套餐额度';
    const style=document.createElement('style');
    style.textContent='.dsh-quota{position:fixed;left:16px;bottom:56px;z-index:25;font:12px/1.5 system-ui;color:var(--text-primary,#eee)}.dsh-quota summary{cursor:pointer;list-style:none;background:#292624;color:#efa98e;border:1px solid #675047;border-radius:18px;padding:2px 10px}.dsh-quota section{position:absolute;left:0;bottom:calc(100% + 8px);width:min(260px,80vw);padding:16px;background:#292726;color:#eee;border:1px solid #55504c;border-radius:14px;box-shadow:0 8px 32px #0005}.dsh-quota section>*{display:block}.dsh-quota section strong{margin-top:12px}.dsh-quota progress{width:100%;height:5px;accent-color:#d97757}.dsh-quota small{color:#bdb6b0}.dsh-quota button{margin-top:10px;color:#efa98e;background:transparent;border:0;cursor:pointer}';
    document.head.append(style);dock.append(toggle,card);document.body.append(dock);
    let key='',target=null,epoch=0,busy=false,last=0;
    const add=(tag,text)=>{const el=document.createElement(tag);el.textContent=text;card.append(el);return el};
    const stamp=t=>new Date(t*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    async function load(enable=false){
     if(!target||busy||!dock.open)return;
     const generation=epoch;busy=true;last=Date.now();
     if(!card.childElementCount)add('small','正在读取服务器额度…');
     try{
      const data=await syncRequest(ctx,target.session,{...target.cfg,action:enable?'quota-enable':'quota'});
      if(generation!==epoch)return;
      card.replaceChildren();add('b','Claude 套餐额度');
      if(data===null){add('small','在当前服务器启用 Claude 状态栏后即可读取额度。');add('button','启用额度显示').onclick=()=>load(true);return}
      for(const [id,label] of [['five_hour','5 小时'],['seven_day','每周']]){
       const w=data.windows?.[id],valid=w && (!w.reset||w.reset>Date.now()/1000);
       add('strong',label+'限额 · '+(valid?'剩余 '+w.remaining+'%':'等待更新'));
       if(valid){const bar=add('progress','');bar.max=100;bar.value=w.remaining;bar.setAttribute('aria-label',label+'剩余百分比');if(w.reset)add('small',stamp(w.reset)+' 重置')}
      }
      add('small',data.updated?'上次更新 '+stamp(data.updated)+' · 本地时间':'等待 Claude Code 返回用量');
     }catch(e){if(generation===epoch){card.replaceChildren();add('small','额度读取失败 · '+String(e.message||e).slice(0,160))}}
     finally{if(generation===epoch)busy=false}
    }
    function tick(){
     const session=ctx.sidebarRight.commandTarget(null)?.sessionId;
     const ws=info(workspaces().find(w=>w.sessionIds.includes(session)));
     let cfg;try{cfg=ws&&JSON.parse(localStorage.getItem(id+':'+ws.workspaceId)||'null')}catch{}
     const next=cfg?.host&&cfg.connected!==false?JSON.stringify([session,cfg.host,cfg.identity]):'';
     if(next!==key){epoch++;busy=false;key=next;target=next?{session,cfg}:null;dock.open=false;card.replaceChildren();last=0}
     dock.hidden=!next;
     if(dock.open&&Date.now()-last>=60000)void load();
    }
    dock.ontoggle=()=>{if(dock.open)void load()};
    const outside=e=>{if(dock.open&&!dock.contains(e.target))dock.open=false};
    const escape=e=>{if(e.key==='Escape'&&dock.open){dock.open=false;toggle.focus()}};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    tick();const timer=setInterval(tick,1500);
    return ()=>{epoch++;clearInterval(timer);document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);dock.remove();style.remove()};
   });
   ctx.effect(()=>ctx.sidebarRightTabs.register({id,kind,multiple:true,priority:'builtin',title:()=>'远程 Claude',guide:[{id:'new',order:21,title:()=>'远程 Claude',description:()=>'SSH、Git 和多模态工作区'}]}));
   ctx.effect(()=>ctx.sidebarRightTabs.register({id:syncId,kind:syncKind,multiple:false,priority:'builtin',title:()=>'文件同步'}));
   const slotProps=session=>{
    const workspace=info(workspaces().find(w=>w.sessionIds.includes(session)));
    return {rpc:(req,progress)=>syncRequest(ctx,session,req,progress),workspace,
     onSyncState:state=>setWorkspaceBadge(workspace?.workspaceId,state),launch:(...args)=>launch(session,...args)};
   };
   for(const [name,key,component] of [
    ['sidebar.right.tab.guide.entry',id,Guide],
    ['sidebar.right.pane.tab',id,Body],
    ['sidebar.right.pane.tab.title',id,()=>h('span',{className:'dsh-claude-tab'},'Claude 工作区')],
    ['sidebar.right.pane.tab',syncId,props=>h(Body,{...props,startInSync:true})],
    ['sidebar.right.pane.tab.title',syncId,()=>h('span',null,'文件同步')],
   ]){
    ctx.effect(()=>ctx.slots.inject(name,()=>ctx.slots.register({name,key,inject:slotProps},component)));
   }
  }
  return {inject,apply};
 }
});
