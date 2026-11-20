window.__ModuleLoader__.load({
 id:'dsh-plugin-remote-claude',
 factory(require){
  const React=require('react'), h=React.createElement;
  const id='dsh-plugin-remote-claude',kind='remote-claude-workbench';
  const quote=s=>"'"+s.replaceAll("'","''")+"'";
  const home='~/.dsh/profiles/desktop/node_modules/dsh-plugin-remote-claude';
  function launchCommand(request,script=home+'/bridge.mjs'){
   const bytes=new TextEncoder().encode(JSON.stringify(request));let encoded='';for(const byte of bytes)encoded+=String.fromCharCode(byte);
   return 'node (Resolve-Path '+quote(script)+') --launch '+quote(btoa(encoded))+'\r';
  }
  const labels={claude:'接入 Claude',shell:'服务器终端',sync:'文件同步 · 选择文件 / 推送 / 拉取',image:'上传剪贴板图片'};
  const inject=['sidebarRight','sidebarRightTabs','slots','webTerminals','workspaces','uiWorkspace'];
  // DSH does not expose its xterm instance. Keep native selection in the existing
  // renderer, and send wheel reports explicitly through the supported input API.
  function installTerminalMouse(root,getModel){
   let selectText=true,pixels=0,lastDirection=0;
   const screen=()=>root.querySelector('.xterm-screen');
   const mouseEnabled=()=>root.querySelector('.xterm')?.classList.contains('enable-mouse-events');
   function wheel(e){
    const surface=screen(),model=getModel(),state=model?.state.getSnapshot();
    if(!surface||!surface.contains(e.target)||!state?.writable||!mouseEnabled()||e.ctrlKey||!Number.isFinite(e.deltaY)||e.deltaY===0)return;
    const bounds=surface.getBoundingClientRect(),cols=state.info?.cols,rows=state.info?.rows;
    if(!cols||!rows||!bounds.width||!bounds.height)return;
    e.preventDefault();e.stopImmediatePropagation();
    const direction=Math.sign(e.deltaY);
    if(direction!==lastDirection)pixels=0;
    lastDirection=direction;
    const unit=e.deltaMode===1?bounds.height/rows:e.deltaMode===2?bounds.height:1;
    pixels+=Math.abs(e.deltaY)*unit;
    const count=Math.min(6,Math.floor(pixels/40));
    if(!count)return;
    pixels=Math.min(pixels-count*40,39);
    const x=Math.max(1,Math.min(cols,Math.floor((e.clientX-bounds.left)*cols/bounds.width)+1));
    // The last row belongs to tmux's status line, not the Claude conversation.
    const y=Math.max(1,Math.min(rows-1,Math.floor((e.clientY-bounds.top)*rows/bounds.height)+1));
    model.write(('\x1b[<'+(direction<0?64:65)+';'+x+';'+y+'M').repeat(count));
   }
   function down(e){
    if(selectText&&e.button===0&&screen()?.contains(e.target)&&mouseEnabled()){
     // xterm's documented Shift gesture forces local selection, even while the
     // application requests mouse capture. It preserves Unicode/column handling.
     Object.defineProperty(e,'shiftKey',{value:true});
    }
   }
   function copy(){
    if(!root.querySelector('.xterm-selection div'))return false;
    root.querySelector('.xterm-helper-textarea')?.focus();
    return document.execCommand('copy');
   }
   function key(e){
    if(e.ctrlKey&&!e.altKey&&e.key.toLowerCase()==='c'&&root.querySelector('.xterm-selection div')){
     e.preventDefault();e.stopImmediatePropagation();copy();
    }
   }
   root.addEventListener('wheel',wheel,{capture:true,passive:false});
   root.addEventListener('mousedown',down,true);
   root.addEventListener('keydown',key,true);
   return {copy,setSelectText(value){selectText=!!value;},dispose(){
    root.removeEventListener('wheel',wheel,true);root.removeEventListener('mousedown',down,true);root.removeEventListener('keydown',key,true);
   }};
  }
  // Claude's logomark, embedded for offline use (Waishnav/devspace, website/logos/claude.svg).
  const claudeMark='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#D97757"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>');
  function ClaudeLogo({size=24,className=''}){
   return h('img',{className:'cw-claude-logo '+className,src:claudeMark,width:size,height:size,alt:'',draggable:false});
  }
  const workbenchTab={
   id,kind,multiple:true,keepMounted:true,priority:'builtin',title:()=>'Claude 工作台',
   guide:[{id:'new',order:21,title:()=>'Claude 工作台',description:()=>'云端对话与本地项目',icon:ClaudeLogo}]
  };
  const WORKBENCH_CSS=`
/* Hallmark · redesign: app · DSH desktop shell and Claude workspace */
[data-row-key^="workspace:"]:has(>[data-dsh-claude-control=open]){--cw-sidebar-ink:#9f482e;--cw-sidebar-wash:#f5e6dd}
body[data-ds-dark-theme] [data-row-key^="workspace:"]:has(>[data-dsh-claude-control=open]){--cw-sidebar-ink:#edb398;--cw-sidebar-wash:#49342e}
[data-row-key^="workspace:"]:has(>[data-dsh-claude-control=open]) :is([class*="_folder"],[class*="_projectText"]){color:var(--cw-sidebar-ink)}
[data-row-key^="workspace:"]>[data-dsh-claude-control=open]{display:inline-flex;align-items:center;gap:4px;flex:none;color:var(--cw-sidebar-ink);font-size:11px;line-height:16px;opacity:1}
[data-row-key^="workspace:"]>[data-dsh-claude-control=open]:hover{background:var(--cw-sidebar-wash)}
.cw-claude-logo{display:inline-block;flex:none;vertical-align:middle}
.dsh-claude-workspace,.dsh-sync-pane,.dsh-desktop-requests,[data-dsh-claude-control],.dsh-quota{
 --cw-text:var(--dsw-alias-label-primary,#202328);--cw-muted:var(--dsw-alias-label-secondary,#777d87);--cw-faint:var(--dsw-alias-label-tertiary,#9298a2);
 --cw-bg:var(--dsw-alias-bg-base,#fff);--cw-surface:var(--dsw-alias-bg-layer-1,#fff);--cw-soft:var(--dsw-alias-interactive-bg-hover,#f5f6f8);
 --cw-border:var(--dsw-alias-border-l2,#e7e9ed);--cw-blue:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 94%,var(--cw-text));--cw-green:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 65%,var(--cw-text));--cw-red:var(--dsw-alias-state-error-primary,#d54747);--cw-mono:var(--dsw-font-mono,Consolas,monospace)
}
.cw-icon{display:inline-block;flex:none;vertical-align:middle}.cw-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.dsh-claude-workspace{box-sizing:border-box;width:100%;height:100%;overflow:auto;container-type:inline-size;background:var(--cw-bg);color:var(--cw-text);font:inherit;font-size:14px;line-height:1.5;padding:28px 26px}
.dsh-claude-workspace *{box-sizing:border-box}.cw-content{width:100%;max-width:600px;margin:0 auto;display:flex;flex-direction:column;gap:22px}
.dsh-claude-workspace{--cw-accent:#98482f;--cw-on-accent:#fff;--cw-danger:#983d36;--cw-on-danger:#fff;--cw-tint:color-mix(in srgb,var(--cw-accent) 6%,var(--cw-bg))}
body[data-ds-dark-theme] .dsh-claude-workspace{--cw-accent:#edb398;--cw-on-accent:#33231d;--cw-danger:#edada4;--cw-on-danger:#381b19}
.cw-project-header{display:grid;gap:16px;min-width:0}
.cw-project-identity{display:flex;align-items:center;gap:12px}
.cw-project-icon{width:40px;height:44px;display:grid;place-items:center;flex:none}
.cw-project-name{flex:1;min-width:0}.cw-project-header h1{margin:0;font-size:24px;font-weight:650;line-height:1.25;letter-spacing:-.03em;text-wrap:balance;overflow-wrap:anywhere}
.cw-project-name>span{font-size:12px;color:var(--cw-accent)}
.cw-route{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px;align-items:baseline;margin:0;font-size:12px}
.cw-route dt{color:var(--cw-muted)}.cw-route dd{margin:0;font:12px/1.6 var(--cw-mono);overflow-wrap:anywhere}
.cw-connection-badge{display:inline-flex;gap:6px;align-items:center;white-space:nowrap;font-size:11px;line-height:1.4;font-weight:550;border-radius:6px;padding:4px 7px;color:var(--cw-muted);background:var(--cw-soft)}.cw-connection-badge i{width:5px;height:5px;border-radius:50%;background:currentColor}.cw-connection-badge[data-state=connected],.cw-connection-badge[data-state=running]{color:var(--cw-green);background:color-mix(in srgb,var(--cw-green) 9%,transparent)}.cw-connection-badge[data-state=connecting]{color:var(--cw-blue);background:color-mix(in srgb,var(--cw-blue) 9%,transparent)}.cw-connection-badge[data-state=failed]{color:var(--cw-red);background:color-mix(in srgb,var(--cw-red) 9%,transparent)}
.cw-actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.cw-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:37px;border:1px solid var(--cw-border);border-radius:8px;background:var(--cw-surface);color:var(--cw-text);padding:8px 13px;font:inherit;font-size:12.5px;font-weight:550;line-height:1.4;cursor:pointer;transition:background .15s,border-color .15s,opacity .15s}.cw-btn:hover{background:var(--cw-soft)}.cw-primary{background:var(--cw-blue);border-color:var(--cw-blue);color:var(--dsw-alias-label-primary-inverted,#fff);padding-inline:15px;box-shadow:0 1px 2px #0000000d}.cw-primary:hover{background:color-mix(in srgb,var(--cw-blue) 90%,#000);border-color:transparent}.cw-primary>.cw-icon:last-child{margin-left:5px}.cw-secondary{font-weight:450}.cw-small{min-height:28px;padding:4px 9px;font-size:11px}.cw-btn:disabled{opacity:.5;cursor:not-allowed;box-shadow:none}.cw-btn[aria-busy=true]{opacity:.85;cursor:wait}
.cw-connect-area{display:flex;flex-direction:column;align-items:flex-start;gap:9px}.cw-connect-caption{margin:0;color:var(--cw-muted);font-size:11.5px;line-height:1.65}.cw-text-button{display:inline-flex;align-items:center;gap:5px;flex:none;border:0;background:transparent;color:var(--cw-muted);padding:2px 0;font:inherit;font-size:11.5px;cursor:pointer;text-decoration:none}.cw-text-button:hover{color:var(--cw-blue)}.cw-text-button:disabled{opacity:.45;cursor:not-allowed}
.cw-settings{border:1px solid var(--cw-border);border-radius:10px;background:var(--cw-surface);overflow:clip}.cw-settings>summary{display:flex;align-items:center;gap:8px;padding:13px 14px;cursor:pointer;list-style:none;font-size:12px}.cw-settings>summary::-webkit-details-marker{display:none}.cw-settings-label{display:flex;align-items:center;gap:8px;font-weight:550}.cw-settings-label .cw-icon{color:var(--cw-muted)}.cw-settings-value{margin-left:auto;font-size:11px;color:var(--cw-muted);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:45%}.cw-settings-chevron{color:var(--cw-faint);transition:transform .16s}.cw-settings[open] .cw-settings-chevron{transform:rotate(90deg)}.cw-settings[open]>summary{border-bottom:1px solid var(--cw-border)}.cw-settings-body{padding:16px}.cw-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,.8fr);gap:14px}.cw-fields label,.cw-advanced label{display:flex;flex-direction:column;gap:6px;min-width:0;font-size:11.5px;color:var(--cw-muted)}.cw-field-full{grid-column:1/-1}
.cw-fields input,.cw-fields select,.cw-advanced input{display:block;width:100%;min-width:0;min-height:35px;background:var(--cw-bg);border:1px solid var(--cw-border);border-radius:7px;color:var(--cw-text);padding:7px 10px;font:inherit;font-size:12px;outline:none;transition:border-color .15s}.cw-fields input:disabled,.cw-fields input[readonly],.cw-fields select:disabled,.cw-advanced input:disabled,.cw-advanced input[readonly]{color:var(--cw-muted);background:var(--cw-soft);-webkit-text-fill-color:var(--cw-muted)}.cw-fields input::placeholder,.cw-advanced input::placeholder{color:var(--cw-faint)}.cw-select{position:relative;display:block}.cw-select select{appearance:none;padding-right:29px;cursor:pointer}.cw-select>.cw-icon{position:absolute;right:11px;top:11px;pointer-events:none;transform:rotate(90deg);color:var(--cw-muted)}.cw-advanced{margin-top:14px;font-size:11.5px;color:var(--cw-muted)}.cw-advanced>summary{cursor:pointer;display:list-item;list-style:disclosure-closed inside}.cw-advanced[open]>summary{list-style-type:disclosure-open}.cw-advanced summary span{margin-left:6px;color:var(--cw-faint);font-size:10.5px}.cw-advanced label{margin-top:9px}.cw-field-hint{font-size:10.5px;line-height:1.65;color:var(--cw-faint);margin:12px 0 0}.cw-runtime-note{display:block;font-size:10px;color:var(--cw-faint);margin-top:8px}
.cw-activity{border:1px solid var(--cw-border);border-radius:12px;background:var(--cw-surface);min-width:0;overflow:hidden}.cw-section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 16px 12px}.cw-section-heading h3{font-size:12.5px;font-weight:600;margin:0}.cw-task-state{font-size:10.5px;color:var(--cw-muted)}.cw-task-state[data-state=completed]{color:var(--cw-green)}.cw-task-state[data-state=running],.cw-task-state[data-state=preparing]{color:var(--cw-blue)}.cw-task-state[data-state=failed]{color:var(--cw-red)}
.cw-timeline{list-style:none;margin:0;padding:0 16px 7px;max-height:350px;overflow:auto}.cw-event{display:flex;align-items:center;gap:10px;min-height:51px;padding:10px 0;position:relative}.cw-event+.cw-event{border-top:1px solid color-mix(in srgb,var(--cw-border) 65%,transparent)}.cw-event-icon{width:29px;height:29px;border-radius:7px;display:flex;align-items:center;justify-content:center;background:var(--cw-soft);color:var(--cw-muted);flex:none}.cw-event-copy{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}.cw-event-title{font-size:12px;font-weight:500}.cw-event-detail{font-size:10.5px;color:var(--cw-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.cw-event-result{display:flex;align-items:center;gap:7px;color:var(--cw-green);flex:none}.cw-event[data-state=started] .cw-event-result{color:var(--cw-blue)}.cw-event[data-state=failed] .cw-event-result{color:var(--cw-red)}.cw-duration{font-size:10px;font-variant-numeric:tabular-nums;color:var(--cw-faint)}.cw-history-toggle{margin:0 16px 12px}.cw-empty{display:flex;align-items:center;gap:12px;padding:19px 16px 25px}.cw-empty-icon{width:42px;height:42px;display:flex;align-items:center;justify-content:center;border:1px dashed var(--cw-border);border-radius:10px;color:var(--cw-faint);flex:none}.cw-empty strong{display:block;font-size:12px;font-weight:500;margin-bottom:3px}.cw-empty p{margin:0;color:var(--cw-muted);font-size:11px;line-height:1.6}.cw-activity-foot{display:flex;align-items:center;gap:6px;padding:11px 16px;border-top:1px solid var(--cw-border);font-size:10.5px;color:var(--cw-muted);background:color-mix(in srgb,var(--cw-soft) 40%,transparent);flex-wrap:wrap}.cw-activity-foot .cw-text-button{margin-left:auto;font-size:10.5px}
.cw-artifacts{border-top:1px solid var(--cw-border);padding:13px 16px}.cw-artifacts h4{font-size:11.5px;font-weight:550;margin:0 0 9px}.cw-artifact{display:flex;gap:9px;align-items:center;padding:7px 0}.cw-artifact>.cw-icon{color:var(--cw-muted)}.cw-artifact>div{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}.cw-artifact strong{font-size:11.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cw-artifact small{font-size:10px;color:var(--cw-faint)}
.cw-error{display:flex;align-items:flex-start;gap:9px;border:1px solid color-mix(in srgb,var(--cw-red) 25%,var(--cw-border));border-radius:8px;padding:12px;background:color-mix(in srgb,var(--cw-red) 4%,var(--cw-bg));font-size:12px;color:var(--cw-text);min-width:0}.cw-error>.cw-icon{color:var(--cw-red);margin-top:1px}.cw-error>div{min-width:0;flex:1}.cw-error strong{font-weight:550;font-size:12px}.cw-error p{font-size:11px;color:var(--cw-muted);overflow-wrap:anywhere;margin:4px 0 0}.cw-error details{margin-top:7px;font-size:10.5px}.cw-error pre,.cw-approval pre{white-space:pre-wrap;overflow-wrap:anywhere;font:10.5px/1.6 var(--cw-mono);max-height:180px;overflow:auto;margin:8px 0 0}.cw-inline-message{display:flex;align-items:center;gap:7px;color:var(--cw-green);font-size:11px}.cw-approval{border:1px solid color-mix(in srgb,var(--cw-blue) 25%,var(--cw-border));border-radius:8px;padding:12px;margin:0 14px 10px}.cw-approval-title{display:flex;align-items:center;gap:7px;font-size:12px}.cw-approval-title .cw-icon{color:var(--cw-blue)}.cw-approval details{font-size:10.5px;color:var(--cw-muted);margin:8px 0}.cw-approval .cw-btn{min-height:29px;font-size:11px}
.cw-workspace-footer{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:9px;font-size:10.5px;color:var(--cw-faint);padding:0 2px 4px}.cw-disconnect{font-size:10.5px}.cw-disconnect:hover{color:var(--cw-red)}
.dsh-claude-workspace :is(button,input,select,summary):focus-visible,[data-dsh-claude-control]:focus-visible,.dsh-quota summary:focus-visible{outline:2px solid var(--cw-blue);outline-offset:3px}.cw-spinner{display:inline-block;width:13px;height:13px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:cw-spin .8s linear infinite;flex:none}@keyframes cw-spin{to{transform:rotate(360deg)}}
@container (max-width:370px){.cw-project-header h1{font-size:23px}.cw-fields{grid-template-columns:1fr}.cw-actions{gap:7px}.cw-connect-area>.cw-actions{width:100%}.cw-primary{flex:1;padding-inline:10px}.cw-secondary{padding-inline:10px}.cw-activity-foot{gap:5px}.cw-duration{display:none}.cw-settings-value{max-width:40%}}
@media(max-width:420px){.dsh-claude-workspace{padding:22px 16px}.cw-content{gap:19px}}
@media(prefers-reduced-motion:reduce){.cw-spinner{animation:none}.dsh-claude-workspace *{transition:none!important}}
body[data-ds-dark-theme] .dsh-claude-workspace{color-scheme:dark}
.dsh-sync-pane{box-sizing:border-box;width:100%;height:100%;min-height:0;display:flex;flex-direction:column;gap:12px;padding:20px;color:var(--cw-text);background:var(--cw-bg);font:inherit;font-size:12px;line-height:1.5;overflow:auto}.dsh-sync-pane>header{display:flex;align-items:center;gap:9px;padding-bottom:12px;border-bottom:1px solid var(--cw-border)}.dsh-sync-pane header strong{font-size:15px;flex:1;font-weight:600}.dsh-sync-pane button,.dsh-sync-pane>input{font:inherit;color:var(--cw-text);background:var(--cw-surface);border:1px solid var(--cw-border);border-radius:7px;padding:6px 10px}.dsh-sync-pane button{cursor:pointer}.dsh-sync-pane button:hover{background:var(--cw-soft)}.dsh-sync-pane button:disabled{opacity:.45;cursor:not-allowed}.dsh-sync-pane input{accent-color:var(--cw-blue)}.sync-meta{font-size:11px;line-height:1.7;color:var(--cw-muted);overflow-wrap:anywhere}.sync-line{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.sync-line>span{margin-right:auto;color:var(--cw-muted)}.sync-files{flex:1;min-height:140px;overflow:auto;border-block:1px solid var(--cw-border)}.sync-files label{display:flex;align-items:center;gap:8px;padding:9px 4px;border-bottom:1px solid color-mix(in srgb,var(--cw-border) 50%,transparent)}.sync-files label:hover{background:var(--cw-soft)}.sync-files small{color:var(--dsw-alias-state-warn-primary,#bd8033);width:30px;font-size:10px;flex:none}.sync-files span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-sync-pane footer{display:flex;gap:8px;flex-wrap:wrap}.dsh-sync-pane footer button:last-child{background:var(--cw-blue);border-color:transparent;color:var(--dsw-alias-label-primary-inverted,#fff)}.dsh-sync-pane>small{font-size:10.5px;color:var(--cw-muted)}.dsh-sync-pane output{font-size:11px;max-height:160px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-desktop-requests{padding:16px;border:1px solid var(--cw-border);border-radius:12px;background:var(--cw-surface);font:inherit;font-size:12px;color:var(--cw-text)}.dsh-desktop-requests header,.dsh-desktop-requests article>div,.dsh-desktop-requests footer{display:flex;align-items:center;justify-content:space-between;gap:9px}.dsh-desktop-requests p{font-size:11px;color:var(--cw-muted);line-height:1.6}.dsh-desktop-requests small{color:var(--cw-muted);font-size:10px}.dsh-desktop-requests article{border-top:1px solid var(--cw-border);padding-top:12px;margin-top:12px}.dsh-desktop-requests code,.desktop-destination{font:10.5px var(--cw-mono);overflow-wrap:anywhere}.dsh-desktop-requests button{font:inherit;font-size:11px;border:1px solid var(--cw-border);border-radius:6px;padding:5px 9px;background:var(--cw-surface);color:var(--cw-text);cursor:pointer}
.dsh-claude-action{font:inherit;font-size:12px;line-height:1.5;color:var(--cw-muted);background:transparent;border:0;border-radius:6px;padding:4px 7px;cursor:pointer;white-space:nowrap}.dsh-claude-action:hover{background:var(--cw-soft);color:var(--cw-text)}[data-dsh-claude-control=open]{font-size:11px;opacity:.8}[data-dsh-claude-control=add]{font-size:12px}[data-dsh-claude-control=commands]{display:flex;align-items:center;flex-wrap:wrap;gap:3px;flex:none;padding:6px 8px;color:var(--cw-muted);background:var(--cw-bg);border-bottom:1px solid var(--cw-border);font:inherit;font-size:12px}[data-dsh-claude-control=commands]>details{position:relative;margin-right:8px}[data-dsh-claude-control=commands] summary{cursor:pointer;font-weight:550;color:var(--cw-text);list-style:none;padding:4px 6px;border-radius:6px}[data-dsh-claude-control=commands] summary:hover{background:var(--cw-soft)}[data-dsh-claude-control=commands] details[open]{display:grid;gap:3px}[data-dsh-claude-control=commands] details button{text-align:left}[data-dsh-claude-control=commands] button[aria-pressed=true]{color:var(--cw-blue);background:color-mix(in srgb,var(--cw-blue) 8%,transparent)}[data-dsh-claude-control=commands]>span{font-size:10px;color:var(--cw-muted)}
.dsh-quota{position:fixed;left:16px;bottom:56px;z-index:25;font:inherit;font-size:11px;line-height:1.5;color:var(--cw-text)}.dsh-quota summary{cursor:pointer;list-style:none;background:var(--cw-surface);color:var(--cw-muted);border:1px solid var(--cw-border);border-radius:7px;padding:4px 9px}.dsh-quota summary:hover{background:var(--cw-soft);color:var(--cw-text)}.dsh-quota section{position:absolute;left:0;bottom:calc(100% + 9px);width:min(260px,80vw);padding:16px;background:var(--cw-bg);color:var(--cw-text);border:1px solid var(--cw-border);border-radius:12px;box-shadow:0 8px 28px #00000016}.dsh-quota section>*{display:block}.dsh-quota section strong{font-size:12px;font-weight:550;margin-top:14px}.dsh-quota progress{width:100%;height:5px;accent-color:var(--cw-blue);margin:7px 0}.dsh-quota small{color:var(--cw-muted);font-size:10.5px}.dsh-quota button{margin-top:10px;color:var(--cw-blue);font:inherit;background:transparent;border:0;cursor:pointer}

.cw-power-copy summary{list-style:none;cursor:pointer}.cw-power-copy summary::-webkit-details-marker{display:none}.cw-power-copy summary small{font-size:11px;font-weight:400;color:var(--cw-muted)}.cw-power-copy[open] summary>.cw-icon{transform:rotate(90deg)}.cw-power-confirm li{align-items:center;flex-wrap:wrap}.cw-power-confirm li code{font:11px var(--cw-mono)}.cw-power-confirm [data-busy=true]{color:var(--cw-blue);font-weight:600}.cw-recovery .cw-btn{margin-top:8px}.cw-advanced .cw-fields{margin-top:10px}.cw-event-detail,.cw-connect-caption{font-size:12px}
.cw-event[data-state=unconfirmed] .cw-event-result{color:var(--cw-faint)}
.cw-power{border:1px solid var(--cw-border);border-radius:10px;background:var(--cw-surface);padding:14px}.cw-power-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.cw-power-symbol{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;background:var(--cw-soft);color:var(--cw-muted);flex:none}.cw-power-copy{flex:1;min-width:120px}.cw-power-title{display:flex;gap:8px;align-items:center;font-size:12px;font-weight:550}.cw-power-status{font-size:10px;font-weight:400;color:var(--cw-muted)}.cw-power-status[data-state=running]{color:var(--cw-green)}.cw-power-copy p,.cw-power-note{font-size:10.5px;line-height:1.6;color:var(--cw-muted);margin:3px 0 0}.cw-power-note{margin-top:10px;color:var(--cw-faint)}.cw-power-confirm{margin-top:12px;padding-top:12px;border-top:1px solid var(--cw-border);font-size:11px}.cw-power-confirm p{margin:0 0 8px;line-height:1.65}.cw-power-confirm ul{list-style:none;margin:0 0 10px;padding:0;max-height:130px;overflow:auto}.cw-power-confirm li{display:flex;justify-content:space-between;gap:10px;padding:4px 0;color:var(--cw-muted);overflow-wrap:anywhere}.cw-power-confirm .cw-primary{background:var(--cw-red);border-color:transparent;color:#fff}.cw-power .cw-error{margin-top:10px}
.cw-connection-panel{border:1px solid var(--cw-border);border-radius:12px;background:var(--cw-surface);overflow:clip}
.cw-connection-panel[data-mode=first]{border-color:color-mix(in srgb,var(--cw-accent) 25%,var(--cw-border))}
.cw-connection-panel>.cw-settings{border:0;border-radius:0;background:transparent}
.cw-connection-panel>.cw-settings>summary{padding:12px 16px;background:var(--cw-tint);color:var(--cw-accent)}
.cw-connection-panel .cw-settings-label{font-size:14px}.cw-connection-panel .cw-settings-label .cw-icon{color:inherit}
.cw-connection-panel h2,.cw-section-heading h2,.cw-power-confirm h3{margin:0;font-size:14px;font-weight:600;line-height:1.5}
.cw-connection-panel>h2{padding:14px 16px 0}.cw-connection-panel>.cw-error{margin:12px 16px 0}
.cw-connection-panel[data-mode=recover]>.cw-error{border:0;border-inline-start:2px solid var(--cw-danger);border-radius:0;padding:2px 10px;background:transparent}
.cw-connection-panel[data-mode=recover] .cw-error p{font-size:12px}
.cw-connection-panel>.cw-text-button{margin-inline:16px}
.cw-connect-area{padding:16px;gap:12px}.cw-connection-panel>.cw-settings+.cw-connect-area{border-top:1px solid var(--cw-border)}
.cw-connect-area .cw-primary{white-space:nowrap;background:var(--cw-accent);color:var(--cw-on-accent);border-color:transparent;box-shadow:none;min-height:40px}
.cw-connect-area .cw-secondary{border-color:transparent;background:transparent}
.cw-connect-area .cw-secondary:hover{background:var(--cw-soft)}
.cw-connect-area .cw-primary:hover,.cw-power-confirm .cw-primary:hover{filter:brightness(.92)}
.cw-connect-area .cw-btn:active:not(:disabled),.cw-power .cw-btn:active:not(:disabled){transform:translateY(1px)}
.cw-field{display:grid;gap:6px;min-width:0;align-content:start}.cw-fields .cw-field label{margin:0}
.cw-fields input[aria-invalid=true]{border-color:var(--cw-danger)}.cw-field-error{font-size:11px;color:var(--cw-danger)}
.cw-fields :disabled{cursor:not-allowed}.cw-fields input,.cw-fields select{border-color:color-mix(in srgb,var(--cw-text) 48%,var(--cw-bg))}
.cw-fields input[aria-invalid=true]:not([readonly]){border-color:var(--cw-danger)}
.cw-content :is(button,input,select,summary):focus-visible{outline-color:var(--cw-accent)}
.cw-field-required{font-size:11px;font-weight:400;color:var(--cw-muted);margin-inline-start:6px}
.cw-duration,.cw-field-hint,.cw-runtime-note{color:var(--cw-muted)}
.cw-fields .cw-field>label{display:block}.cw-advanced>summary span,.cw-fields input::placeholder,.cw-advanced input::placeholder{color:var(--cw-muted)}
.cw-power-title{display:grid;grid-template-columns:auto 1fr;gap:1px 3px;align-items:center}
.cw-power-status{grid-column:1/-1;font-size:11px}.cw-power-confirm h3{color:var(--cw-danger);margin-bottom:4px}
.cw-power-confirm p{font-size:12px;color:var(--cw-muted)}
.cw-power-confirm ul{border-block:1px solid var(--cw-border);max-height:185px;margin:12px 0;padding:0}
.cw-power-confirm li{flex-wrap:nowrap;padding:8px 0}.cw-power-confirm li+li{border-top:1px solid var(--cw-border)}
.cw-power-confirm li>div{display:grid;min-width:0;gap:2px}.cw-power-confirm li strong{font-size:12px;color:var(--cw-text);overflow-wrap:anywhere}
.cw-power-confirm li small{font-size:11px}.cw-power-confirm li>span{flex:none;font-size:11px}
.cw-power-confirm li [data-busy=true]{color:var(--cw-danger)}.cw-power-confirm [data-busy=true]::before{content:'';display:inline-block;background:currentColor;width:5px;height:5px;border-radius:50%;margin-inline-end:5px;vertical-align:middle}
.cw-power-confirm .cw-actions{justify-content:flex-end}.cw-power-confirm .cw-btn{min-height:34px;padding-inline:12px}
.cw-power-row>.cw-btn{min-height:32px}
.cw-power-confirm .cw-primary{background:var(--cw-danger);color:var(--cw-on-danger);flex:none}
.cw-workspace-footer{justify-content:flex-end}
`;
  const iconPaths={
   spark:['M12 2v5m0 10v5M2 12h5m10 0h5M4.9 4.9l3.5 3.5m7.2 7.2 3.5 3.5M4.9 19.1l3.5-3.5m7.2-7.2 3.5-3.5'],
   folder:['M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3Z'],
   terminal:['m5 7 5 5-5 5M13 17h6'],cloud:['M6 18a4 4 0 0 1-.5-8 6.5 6.5 0 0 1 12.6-1A4.5 4.5 0 0 1 18 18Z'],
   arrow:['M5 12h14m-5-5 5 5-5 5'],chevron:['m9 5 7 7-7 7'],check:['m5 12 4 4L19 6'],
   file:['M6 3h8l4 4v14H6ZM14 3v5h4M9 12h6m-6 4h6'],edit:['m14 5 5 5M4 20l4-1L20 7l-5-5L3 14Z'],
   search:['M16 16l5 5','M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0'],
   settings:['M4 7h16M4 17h16M8 4v6m8 4v6'],link:['m8 12 8 0M9 7H6a5 5 0 0 0 0 10h3m6-10h3a5 5 0 0 1 0 10h-3'],
   alert:['M12 3 2 21h20ZM12 9v5m0 3v.5'],stop:['M7 7h10v10H7Z'],clock:['M12 7v5l3 2','M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0'],
   refresh:['M20 7v5h-5M4 17v-5h5','M6 6a8 8 0 0 1 13 3M18 18a8 8 0 0 1-13-3']
   ,power:['M12 2v10','M6.5 5.5a8.5 8.5 0 1 0 11 0']
  };
  function Icon({name='spark',size=18,className=''}){return h('svg',{viewBox:'0 0 24 24',width:size,height:size,fill:'none',stroke:'currentColor',strokeWidth:1.65,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true,className:'cw-icon '+className},...(iconPaths[name]||iconPaths.file).map((d,i)=>h('path',{d,key:i})))}
  const toolNames={Bash:['执行命令','terminal'],Read:['读取文件','file'],Write:['创建文件','file'],Edit:['编辑文件','edit'],NotebookEdit:['编辑笔记本','edit'],Grep:['搜索内容','search'],Glob:['查找文件','search'],ToolSearch:['选择工具','search'],Skill:['使用技能','spark'],Agent:['分派任务','spark'],TaskStop:['停止任务','stop'],WebSearch:['搜索网页','search'],WebFetch:['读取网页','cloud']};
  function toolPresentation(name){const short=String(name||'').split('__').pop();const [label,icon]=toolNames[short]||['运行工具','terminal'];return {label,icon};}
  function activityRows(events){
   const rows=[];
   for(const event of events||[]){
    if(event.status==='started'){rows.push({...event,key:event.id||'event-'+rows.length});continue;}
    const row=event.id?rows.find(r=>r.id===event.id):rows.find(r=>r.tool===event.tool&&r.status==='started');
    if(row)Object.assign(row,{...event,detail:event.detail||row.detail,startedAt:row.time});else rows.push({...event,key:event.id||'event-'+rows.length});
   }
   return rows;
  }
  function ErrorNotice({message,title='操作未完成'}){
   if(!message)return null;
   const raw=String(message),lines=raw.trim().split('\n'),last=lines.at(-1).replace(/^(?:[A-Za-z]*Error):\s*/,'');
   return h('div',{className:'cw-error',role:'alert'},h(Icon,{name:'alert',size:17}),h('div',null,h('strong',null,title),h('p',null,last.slice(0,220)),(lines.length>1||last.length>220)&&h('details',null,h('summary',null,'查看错误详情'),h('pre',null,raw))));
  }
  const statusStores=new Map();
  const emptySnapshot=()=>({activity:{status:'idle',events:[],artifacts:[],approvals:[]},power:{state:'loading',connections:[]},error:''});
  function workbenchStore(sessionId){
   if(statusStores.has(sessionId))return statusStores.get(sessionId);
   const subscribers=new Set();
   let snapshot=emptySnapshot(),timer,pending;
   const visible=()=>!document.hidden&&[...subscribers].find(client=>client.visible);
   function schedule(){
    clearTimeout(timer);
    if(!visible())return;
    const busy=['preparing','running'].includes(snapshot.activity.status)||['starting','stopping'].includes(snapshot.power.state);
    timer=setTimeout(refresh,busy?2000:12000);
   }
   function refresh(){
    clearTimeout(timer);
    if(pending)return pending;
    const client=visible();
    if(!client)return Promise.resolve();
    pending=Promise.resolve().then(()=>client.read()).then(result=>{
     snapshot={...result,error:''};
    }).catch(error=>{snapshot={...snapshot,error:error.message}}).finally(()=>{
     pending=null;
     for(const entry of subscribers)entry.notify(snapshot);
     schedule();
    });
    return pending;
   }
   const store={refresh,invalidate:async()=>{if(pending)await pending;return refresh()},subscribe(client){
    subscribers.add(client);client.notify(snapshot);
    if(subscribers.size===1)document.addEventListener('visibilitychange',refresh);
    return ()=>{
     subscribers.delete(client);
     if(!subscribers.size){
      clearTimeout(timer);document.removeEventListener('visibilitychange',refresh);statusStores.delete(sessionId);
     }else schedule();
    };
   },schedule};
   statusStores.set(sessionId,store);return store;
  }
  function useWorkspaceStatus(rpc,sessionId,enabled,panel,tabVisible){
   const [snapshot,setSnapshot]=React.useState(emptySnapshot);
   const rpcRef=React.useRef(rpc),storeRef=React.useRef();rpcRef.current=rpc;
   const shown=React.useRef(tabVisible);
   React.useEffect(()=>{
    shown.current=tabVisible;
    if(tabVisible)void storeRef.current?.refresh();else storeRef.current?.schedule();
   },[tabVisible]);
   React.useEffect(()=>{
    setSnapshot(emptySnapshot());
    if(!enabled||!panel.current)return;
    const store=workbenchStore(sessionId);storeRef.current=store;
    let onScreen=false;
    const client={read:()=>rpcRef.current({action:'workbench-status'}),notify:setSnapshot,get visible(){return shown.current&&onScreen}};
    const unsubscribe=store.subscribe(client);
    const observer=new IntersectionObserver(entries=>{
     onScreen=entries.some(entry=>entry.isIntersecting);
     if(client.visible)void store.refresh();else store.schedule();
    });
    observer.observe(panel.current);
    return ()=>{observer.disconnect();unsubscribe();storeRef.current=null};
   },[sessionId,enabled]);
   return {state:snapshot.activity,power:snapshot.power,route:snapshot.route,error:snapshot.error,refresh:async()=>{
    const store=storeRef.current;
    if(store)await store.invalidate();
   }};
  }
  async function syncRequest(ctx,session,request,progress){
   const shells=await ctx.webTerminals.launchShells(session,new AbortController().signal);
   const shell=shells.shells.find(s=>/(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(s.path));
   if(!shell)throw Error('缺少 PowerShell');
   const uid=crypto.randomUUID(),model=ctx.webTerminals.view(session,uid,uid,undefined,shell.path);
   let remaining='',sent=false,revision=-1,buffer='',key='',encoded='',off,unmount,timer;
   try{return await new Promise((resolve,reject)=>{
    timer=setTimeout(()=>reject(Error('读取同步结果超时，请刷新核对仓库状态')),request.action==='push'?1830000:245000);
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
      while((match=/!(READY|ACK|D|END|P):([a-zA-Z0-9+/=]+)!/.exec(buffer))){
       buffer=buffer.slice(match.index+match[0].length);
       if(match[1]==='READY'&&!key){key=match[2];const bytes=new TextEncoder().encode(JSON.stringify(request));let out='';for(const b of bytes)out+=String.fromCharCode(b);remaining=btoa(out);if(remaining.length>4*1024*1024){reject(Error('选择的文件列表过大，请分批推送'));return}sendChunk()}
       else if(key && match[1]==='ACK' && match[2]===key && remaining)sendChunk();
       else if(key && match[1]==='P')progress?.(match[2]);
       else if(key && match[1]==='D')encoded+=match[2];
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
  function SyncPanel({rpc,cfg,workspace,back,terminal,tabVisible}){
   const [data,setData]=React.useState({branch:'',changes:[]}),[sel,select]=React.useState(new Set()),[q,filter]=React.useState(''),[msg,message]=React.useState(''),[busy,lock]=React.useState(false),[notice,note]=React.useState(''),[confirm,review]=React.useState('');
   const guard=React.useRef(false);
   const [watch,setWatch]=React.useState(null),[watchError,setWatchError]=React.useState('');
   React.useEffect(()=>{
    if(!tabVisible)return;
    let alive=true,pending=false;
    async function read(){if(pending||guard.current)return;pending=true;try{const result=await rpc({...cfg,action:'watch-status'});if(alive){setWatch(result);setWatchError('')}}catch(e){if(alive)setWatchError(e.message)}finally{pending=false}}
    void read();const timer=setInterval(read,15000);return ()=>{alive=false;clearInterval(timer)};
   },[cfg.host,cfg.project,workspace?.path,tabVisible]);
   async function switchWatch(){
    if(guard.current||!watch)return;
    guard.current=true;lock(true);
    try{setWatch(await rpc({...cfg,action:watch.enabled?'watch-off':'watch-on'}));setWatchError('')}
    catch(e){setWatchError(e.message)}finally{guard.current=false;lock(false)}
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
   React.useEffect(()=>{void act('list')},[]);
   const visible=data.changes.filter(x=>x.file.toLowerCase().includes(q.toLowerCase()));
   const button=(text,fn,disabled=false)=>h('button',{type:'button',onClick:fn,disabled:busy||disabled},text);
   const toggle=(paths,on)=>select(prev=>{const next=new Set(prev);for(const p of paths){if(on)next.add(p);else next.delete(p)}return next});
   return h('section',{className:'dsh-sync-pane'},
    h('header',null,button('‹ 工作台',back),h('strong',null,'文件同步'),button('打开本地终端',terminal)),
    h('div',{className:'sync-meta'},workspace?.path,' · '+(data.branch||'…'),h('br'),cfg.host+'  ~/projects/'+cfg.project),
    h('input',{placeholder:'按文件路径筛选',value:q,onChange:e=>filter(e.target.value)}),
    h('div',{className:'sync-line'},h('span',null,visible.length+' 项 · 已选 '+sel.size),button('刷新',()=>act('list')),button('全选全部 '+data.changes.length+' 项',()=>toggle(data.changes.map(x=>x.file),true)),button('选择筛选结果',()=>toggle(visible.map(x=>x.file),true)),button('清空选择',()=>select(new Set()))),
    h('label',{className:'sync-meta'},h('input',{type:'checkbox',checked:!!watch?.enabled,disabled:busy||!watch,onChange:switchWatch}),' 自动回传服务器文件（无需提交，关闭面板后继续）'),
    h('small',null,watchError || (watch?.enabled?'服务器 → 本地 · '+watch.status+' · 冲突 '+watch.conflicts:'首次开启会同步远端已有文件；两边独立修改同一文件时保留冲突。')),
    h('div',{className:'sync-files'},visible.map(x=>h('label',{key:x.file,title:x.file},h('input',{type:'checkbox',checked:sel.has(x.file),disabled:busy,onChange:e=>toggle([x.file],e.target.checked)}),h('small',null,x.status==='??'?'新增':x.status.trim()),h('span',null,x.file)))),
    h('input',{placeholder:'提交说明（勾选文件时必填）',value:msg,onChange:e=>message(e.target.value)}),
    confirm?h('div',null,h('p',null,confirm==='push'?'确认远程 Claude 已空闲。将推送当前分支已有提交和勾选的 '+sel.size+' 个文件。':'将远程分支快进合并到当前本地分支。'),button('取消',()=>review('')),button('确认'+(confirm==='push'?'推送':'拉取'),()=>act(confirm))):h('footer',null,button('拉取远程提交',()=>review('pull')),button('推送到服务器',()=>review('push'),sel.size>0&&!msg.trim())),
    parts && h('div',{role:'status'},h('div',null,stages[parts[1]],' · ',seconds,' 秒',parts[2]?' · '+parts[2]+'%':''),h('progress',{max:100,...(parts[2]?{value:Number(parts[2])}:{}),style:{width:'100%',accentColor:'#d97757'}})),
    h('output',{role:'status'},notice));
  }

  function DesktopRequests({rpc,cfg,tabVisible}){
   const [data,setData]=React.useState({connection:'disconnected',requests:[]});
   const [error,setError]=React.useState('');
   const busy=React.useRef(false);
   React.useEffect(()=>{
    if(!tabVisible)return;
    let active=true;
    async function refresh(){
     if(busy.current)return;busy.current=true;
     try{const result=await rpc({...cfg,action:'desktop-list'});if(active){setData(result);setError('')}}
     catch(e){if(active)setError(String(e.message||e))}finally{busy.current=false}
    }
    void refresh();const timer=setInterval(refresh,4000);
    return ()=>{active=false;clearInterval(timer)};
   },[cfg.host,cfg.project,tabVisible]);
   async function decide(id,approved){
    if(busy.current)return;busy.current=true;
    try{setData(await rpc({...cfg,action:'desktop-decide',requestId:id,approved}));setError('')}
    catch(e){setError(String(e.message||e))}finally{busy.current=false}
   }
   const statuses={pending:'等待你确认',running:'正在处理',completed:'已完成',denied:'已拒绝',failed:'处理失败',expired:'已过期'};
   return h('section',{className:'dsh-desktop-requests','aria-label':'本机操作请求'},
    h('header',null,h('strong',null,'本机操作'),h('small',null,data.connection==='connected'?'已连接':'等待桌面模式连接')),
    h('p',null,'Claude 可请求下载成果或用本机应用打开文档、图片。每次操作由你确认。网页预览请让 Claude 在服务器生成截图。'),
    error&&h('output',{role:'alert'},error),
    data.requests.length===0?h('small',null,'当前没有请求。连接后可告诉 Claude：“将项目中的报告下载到我的电脑”。'):null,
    ...data.requests.slice(0,20).map(item=>h('article',{key:item.request.id},
     h('div',null,h('b',null,item.request.action==='open_file'?'下载并打开':'下载成果'),h('small',null,statuses[item.status]||item.status)),
     h('code',null,item.request.path),h('p',null,item.request.reason),
     item.localFile&&h('p',{className:'desktop-destination'},'保存位置：'+item.localFile),
     item.code&&h('p',null,({TRANSFER_FAILED:'文件传输失败，请检查文件是否存在后重新请求。',OPEN_FAILED:'文件已下载，本机应用未能打开。',LOCAL_UNAVAILABLE:'连接曾中断，请让 Claude 重新请求。'})[item.code]||item.code),
     item.status==='pending'?h('footer',null,
      h('button',{type:'button',onClick:()=>decide(item.request.id,false)},'拒绝'),
      h('button',{type:'button',disabled:data.connection!=='connected',onClick:()=>decide(item.request.id,true)},item.request.action==='open_file'?'允许下载并打开':'允许下载')):null)));
  }
  function AgentStatus({rpc,cfg,state,refresh,onOpenTerminal}){
   const [expanded,expand]=React.useState(false),[error,setError]=React.useState('');
   const rows=activityRows(state.events),visible=expanded?rows:rows.slice(-4);
   const statusText={idle:'等待任务',preparing:'准备中',running:'进行中',completed:'已完成',failed:'未完成',cancelled:'已停止'};
   async function act(action,extra){try{await rpc({...cfg,action,...extra});await refresh();setError('')}catch(e){setError(e.message)}}
   const approvals=(state.approvals||[]).filter(item=>item.status==='pending');
   return h('section',{className:'cw-activity','aria-label':'最近活动'},
    h('header',{className:'cw-section-heading'},h('h2',null,'最近活动'),h('span',{className:'cw-task-state','data-state':state.status},statusText[state.status]||'等待任务')),
    h(ErrorNotice,{message:error}),
    ...approvals.map(item=>h('article',{className:'cw-approval',key:item.id},
     h('div',{className:'cw-approval-title'},h(Icon,{name:'alert',size:16}),h('strong',null,'需要确认 · '+toolPresentation(item.tool).label)),
     h('details',{open:true},h('summary',null,'查看操作内容'),h('pre',null,JSON.stringify(item.input,null,2))),
     item.source==='panel'?h('div',{className:'cw-actions'},h('button',{className:'cw-btn',onClick:()=>act('agent-approve',{requestId:item.id,turnId:state.turn,approved:false})},'拒绝'),h('button',{className:'cw-btn cw-primary',onClick:()=>act('agent-approve',{requestId:item.id,turnId:state.turn,approved:true})},'允许本次')):h('button',{className:'cw-text-button',onClick:onOpenTerminal},'前往 Claude 终端确认',h(Icon,{name:'arrow',size:14})))),
    visible.length?h('ol',{className:'cw-timeline'},...visible.map(item=>{
     const info=toolPresentation(item.tool),pending=item.status==='started',running=pending&&['running','preparing'].includes(state.status),failed=item.status==='failed';
     const detail=String(item.detail||'').replace(/^\/workspaces\/[a-f0-9]{32}\//,'');
     const duration=item.startedAt&&item.time?Math.max(0,(item.time-item.startedAt)/1000):null;
     return h('li',{key:item.key,className:'cw-event','data-state':pending&&!running?'unconfirmed':item.status},
      h('span',{className:'cw-event-icon'},h(Icon,{name:info.icon,size:16})),
      h('div',{className:'cw-event-copy'},h('span',{className:'cw-event-title'},info.label),detail&&h('span',{className:'cw-event-detail',title:detail},detail)),
      h('span',{className:'cw-event-result',title:item.tool},duration!==null&&duration>=1&&h('span',{className:'cw-duration'},Math.round(duration)+' 秒'),running?h('span',{className:'cw-spinner','aria-label':'执行中'}):h(Icon,{name:failed?'alert':pending?'clock':'check',size:15}),h('span',{className:'cw-sr-only'},running?'执行中':failed?'执行失败':pending?'未收到完成记录':'已完成')));
    })):h('div',{className:'cw-empty'},h('span',{className:'cw-empty-icon'},h(Icon,{name:'terminal',size:22})),h('div',null,h('strong',null,'从左侧开始对话'),h('p',null,'发送消息或添加附件，运行进度会显示在这里。'))),
    rows.length>4&&h('button',{className:'cw-text-button cw-history-toggle',onClick:()=>expand(!expanded),'aria-expanded':expanded},expanded?'收起活动':'查看全部 '+rows.length+' 项',h(Icon,{name:'chevron',size:13})),
    (state.artifacts||[]).length>0&&h('div',{className:'cw-artifacts'},h('h4',null,'成果文件'),...(state.artifacts||[]).map(item=>h('article',{className:'cw-artifact',key:item.id},h(Icon,{name:'file',size:19}),h('div',null,h('strong',null,item.name),h('small',null,(item.size<1024?item.size+' B':Math.round(item.size/1024)+' KB')+' · 已保存')),h('button',{className:'cw-btn cw-small',onClick:()=>act('agent-open',{artifactId:item.id})},'打开')))),
    h('footer',{className:'cw-activity-foot'},h(Icon,{name:cfg.vmTools?'folder':'cloud',size:13}),cfg.vmTools?'文件修改直接保存到本机项目':'成果文件可回传到本机',null));
  }
  function PowerControls({rpc,power,refresh,onBusyChange,disabled}){
   const [busy,setBusy]=React.useState(''),[review,setReview]=React.useState(null),[error,setError]=React.useState('');
   const guard=React.useRef(false);
   const cancelButton=React.useRef(null),powerButton=React.useRef(null),reviewTitle=React.useId();
   React.useEffect(()=>{
    if(!review)return;
    if(power.state==='stopped'){
     setReview(null);
     if(powerButton.current?.closest('.cw-power')?.contains(document.activeElement))powerButton.current.focus();
    }else cancelButton.current?.focus();
   },[review,power.state]);
   function cancelReview(){setReview(null);powerButton.current?.focus()}
   async function operate(action,reviewed){
    if(guard.current||disabled)return;guard.current=true;setBusy(action);onBusyChange(true);setError('');
    try{
     const result=await rpc({action:'vm-power-'+action,...(reviewed?{confirmedConnections:reviewed.map(c=>c.connectionId),confirmedBusy:reviewed.filter(c=>c.busy).map(c=>c.connectionId)}:{})});
     if(result.status==='needs-confirmation'){setReview(result.connections);return;}
     setReview(null);await refresh();
    }catch(e){setError(e.message)}finally{guard.current=false;setBusy('');onBusyChange(false)}
   }
   const phase=busy==='start'?'starting':busy==='stop'?'stopping':power.state;
   const labels={loading:'读取中',running:'已启动',stopped:'已关闭',starting:'正在启动',stopping:'正在关闭',unknown:'状态未知',unavailable:'未配置'};
   const running=phase==='running',transition=!!busy||['starting','stopping','loading'].includes(phase);
   const busyCount=review?.filter(item=>item.busy).length||0;

   return h('section',{className:'cw-power','aria-label':'虚拟机电源'},
    h('div',{className:'cw-power-row'},h('span',{className:'cw-power-symbol'},h(Icon,{name:'power',size:18})),h('details',{className:'cw-power-copy'},
     h('summary',{className:'cw-power-title'},'执行虚拟机',h(Icon,{name:'chevron',size:12}),h('span',{className:'cw-power-status','data-state':phase,role:'status'},labels[phase]||'状态未知',running?' · '+(power.connections?.length||0)+' 个会话':'')),
     h('p',null,power.memoryMiB?((power.memoryMiB/1024)+' GB 配置，'+power.cpus+' 核。关机保留项目文件和聊天记录。'):'接入时按需启动，关机保留项目文件和聊天记录。')),
     h('button',{className:'cw-btn cw-small',ref:powerButton,'aria-expanded':running?!!review:undefined,disabled:disabled||transition||!power.controlReady||['unknown','unavailable'].includes(phase),onClick:()=>review?cancelReview():operate(running?'stop':'start')},transition?h('span',{className:'cw-spinner'}):null,phase==='stopping'?'正在关闭…':phase==='starting'?'正在启动…':review?'收起确认':running?'关闭虚拟机':'启动虚拟机')),
    !power.controlReady&&phase!=='loading'&&h('p',{className:'cw-power-note'},'请检查执行器配置，或重启 DSH 加载电源服务。'),
    review&&h('div',{className:'cw-power-confirm',role:'group','aria-labelledby':reviewTitle,onKeyDown:e=>{if(e.key==='Escape'&&!busy){e.preventDefault();e.stopPropagation();cancelReview()}}},
     h('h3',{id:reviewTitle},'关机会断开 '+review.length+' 个会话'),
     h('p',null,busyCount?busyCount+' 个会话正在执行任务，关机会中断命令。':'当前没有会话在执行任务。','项目文件和聊天记录会保留。'),
     h('ul',null,...[...review].sort((a,b)=>Number(!!b.busy)-Number(!!a.busy)).map(item=>h('li',{key:item.connectionId},h('div',null,h('strong',null,item.chatTitle||('会话 '+(item.scope||item.connectionId).slice(0,8))),h('small',null,item.title||item.project)),h('span',{'data-busy':!!item.busy},item.busy?'任务执行中':'已连接')))),
     h('div',{className:'cw-actions'},h('button',{className:'cw-btn cw-small',ref:cancelButton,disabled:!!busy,onClick:cancelReview},'取消'),h('button',{className:'cw-btn cw-small cw-primary',disabled:!!busy||disabled,onClick:()=>operate('stop',review)},'断开全部并关闭'))),
    h(ErrorNotice,{message:error||power.error}));
  }
  function Body({useTabInfo,launch,workspace,rpc,sessionId}){
   const tab=useTabInfo?useTabInfo().tab:null;
   const tabVisible=tab?.visible!==false;
   const [cfg,set]=React.useState(()=>{try{return JSON.parse(localStorage.getItem(workspace?id+':'+workspace.workspaceId:id))||defaults()}catch{return defaults()}});
   function defaults(){return {host:'',project:workspace?.remoteName||'my-test',identity:'',structuredChat:true,vmTools:true}}
   const [bound,setBound]=React.useState(false),[ready,setReady]=React.useState(false),[settingsOpen,showSettings]=React.useState(false);
   const [notice,notify]=React.useState(null),[working,setWorking]=React.useState(''),[syncOpen,showSync]=React.useState(false);
   const [advanced,showAdvanced]=React.useState(false),[touched,setTouched]=React.useState({});
   const invalidFocus=React.useRef(''),fieldId=React.useId();
   const fieldErrors={
    host:/^[\w][\w.@-]*$/.test(cfg.host||'')?'':'填写 SSH 别名或 user@host，例如 dev-server。',
    project:/^\w[\w-]{0,47}$/.test(cfg.project||'')?'':'使用 1 至 48 个字母、数字、下划线或连字符，首字符不能是连字符。',
    identity:/[\r\n\x00]/.test(cfg.identity||'')?'私钥路径需写在一行。':''
   };
   React.useEffect(()=>{
    if(invalidFocus.current){
     document.getElementById(fieldId+'-'+invalidFocus.current)?.focus();
     invalidFocus.current='';
    }
   },[touched,fieldId]);
   const [powerBusy,setPowerBusy]=React.useState(false),[configAttempt,retryConfig]=React.useReducer(n=>n+1,0),[configError,setConfigError]=React.useState('');
   const actionGuard=React.useRef(false),panel=React.useRef(null);
   React.useEffect(()=>{
    let active=true;setReady(false);setBound(false);notify(null);setConfigError('');showAdvanced(false);setTouched({});
    void rpc({action:'session-config'}).then(result=>{
     if(!active)return;
     let saved={};try{saved=JSON.parse(localStorage.getItem(workspace?id+':'+workspace.workspaceId:id))||{}}catch{}
     setBound(!!result.bound);showSettings(!result.bound);
     set({...defaults(),...saved,...(result.bound?result.route:{structuredChat:true,vmTools:true,desktopTools:false})});setReady(true);
    }).catch(error=>{if(active)setConfigError(error.message)});
    return()=>{active=false};
   },[sessionId,workspace?.workspaceId,configAttempt]);
   const {state,power,route,error,refresh}=useWorkspaceStatus(rpc,sessionId,ready&&!syncOpen,panel,tabVisible);
   // Another pane can bind an open first-use form while this tab is hidden.
   React.useEffect(()=>{
    if(ready&&!bound&&route){set(route);setBound(true);showSettings(false)}
   },[ready,bound,route]);
   React.useEffect(()=>{if(notice?.kind!=='success')return;const timer=setTimeout(()=>notify(null),5000);return()=>clearTimeout(timer)},[notice]);
   if(syncOpen)return h(SyncPanel,{rpc,cfg,workspace,tabVisible,back:()=>showSync(false),terminal:()=>tab?.actions.openTab('terminal',{})});
   async function start(op){
    if(actionGuard.current||powerBusy)return;
    actionGuard.current=true;setWorking(op);notify(null);
    try{
     const invalid=Object.keys(fieldErrors).filter(name=>fieldErrors[name]);
     if(invalid.length){
      showSettings(true);if(invalid[0]!=='host')showAdvanced(true);
      invalidFocus.current=invalid[0];setTouched(Object.fromEntries(invalid.map(name=>[name,true])));return;
     }
     localStorage.setItem(workspace?id+':'+workspace.workspaceId:id,JSON.stringify({host:cfg.host,project:cfg.project,identity:cfg.identity,remoteModel:cfg.remoteModel}));
     if(op==='sync'){showSync(true);return;}
     const connected=await launch(tab,op,cfg);
     if(op==='claude'&&connected){set(connected);setBound(true);showSettings(false);}
     notify({kind:'success',text:'终端已打开，可以继续当前会话。'});void refresh();
    }catch(e){notify({kind:'error',text:String(e.message||e)})}
    finally{actionGuard.current=false;setWorking('')}
   }
   async function disconnect(){
    if(actionGuard.current)return;actionGuard.current=true;setWorking('disconnect');notify(null);
    try{await rpc({...cfg,action:'vm-disconnect'});await refresh();notify({kind:'success',text:'已断开本机执行连接，聊天记录已保留。'})}
    catch(e){notify({kind:'error',text:e.message})}finally{actionGuard.current=false;setWorking('')}
   }
   const manuallyOff=power.manualOff&&power.state==='stopped';
   let phase=state.vm?.status||'offline';
   if(configError)phase='failed';
   else if(!ready)phase='loading';
   else if(working==='claude')phase='connecting';
   else if(!cfg.vmTools)phase='legacy';
   else if(error)phase='unknown';
   else if(manuallyOff)phase='offline';
   else if(bound&&!state.vm&&power.state==='loading')phase='loading';
   const phaseLabels={loading:'读取中',connecting:'连接中',connected:'已连接',running:'运行中',offline:'未连接',failed:'连接异常',legacy:'服务器模式',unknown:'状态待确认'};
   const connected=['connected','running'].includes(phase),title=workspace?.title||'Claude 工作区';
   const recovering=ready&&bound&&cfg.vmTools&&['failed','offline'].includes(phase);
   let caption='云端 Claude 将通过虚拟机读写上方的本机目录。';
   if(!cfg.vmTools)caption='沿用本聊天的服务器执行环境。';
   else if(connected)caption='在左侧对话，在右侧 Claude 终端确认操作。';
   else if(recovering)caption=(manuallyOff?'点击重连会启动虚拟机。':'')+'重连后继续本聊天，已保存的文件仍在项目中。';
   else if(bound)caption='继续使用本聊天已绑定的云端会话。';
   function field(name,label,placeholder){
    const message=touched[name]&&fieldErrors[name],inputId=fieldId+'-'+name;
    return h('div',{className:'cw-field'+(name==='host'?' cw-field-full':'')},h('label',{htmlFor:inputId},label,!bound&&name==='host'&&h('small',{className:'cw-field-required','aria-hidden':true},'必填')),
     h('input',{id:inputId,value:cfg[name]||'',readOnly:bound,placeholder,spellCheck:false,
      'aria-required':name!=='identity','aria-invalid':!!message,'aria-describedby':message?inputId+'-error':undefined,
      onBlur:()=>{if(!bound)setTouched(old=>({...old,[name]:true}))},onChange:e=>set({...cfg,[name]:e.target.value}),
      onKeyDown:e=>{if(!bound&&e.key==='Enter'&&!e.nativeEvent.isComposing){e.preventDefault();void start('claude')}}}),
     message&&h('small',{id:inputId+'-error',className:'cw-field-error',role:'alert'},message));
   }
   const modelNames={'':'服务器默认',sonnet:'Sonnet',opus:'Opus',haiku:'Haiku'};
   const settings=()=>h('details',{className:'cw-settings',open:settingsOpen,onToggle:e=>showSettings(e.currentTarget.open)},
    h('summary',null,h('span',{className:'cw-settings-label'},h(Icon,{name:bound?'settings':'link',size:16}),bound?'连接设置':'首次接入'),h('span',{className:'cw-settings-value'},bound?cfg.host:null),h(Icon,{name:'chevron',size:14,className:'cw-settings-chevron'})),
    h('div',{className:'cw-settings-body'},
     h('div',{className:'cw-fields'},field('host','SSH 主机','dev-server 或 user@host')),
     h('details',{className:'cw-advanced',open:advanced,onToggle:e=>showAdvanced(e.currentTarget.open)},h('summary',null,'更多设置',h('span',null,'远程目录、模型、私钥')),h('div',{className:'cw-fields'},
      field('project','远程工作区','服务器上的项目名称'),h('label',null,h('span',null,'启动模型'),h('span',{className:'cw-select'},h('select',{value:cfg.remoteModel||'',disabled:bound,onChange:e=>set({...cfg,remoteModel:e.target.value})},...Object.entries(modelNames).map(([value,text])=>h('option',{key:value,value},text))),h(Icon,{name:'chevron',size:13}))),
      field('identity','SSH 私钥','使用 SSH 配置时留空'))),
     bound&&h('p',{className:'cw-field-hint'},'本聊天的工作区已固定。运行中可在终端使用 /model 切换模型。'),
     bound&&cfg.vmTools&&state.vm?.executorVersion&&h('small',{className:'cw-runtime-note'},'执行器 CC '+state.vm.executorVersion+'（独立配置，未登录）')));
   const failure=notice?.kind==='error'?notice.text:error||state.vm?.error||state.error;
   return h('section',{ref:panel,className:'dsh-claude-workspace',onPaste:e=>{if([...e.clipboardData.items].some(i=>i.type.startsWith('image/'))){e.preventDefault();if(cfg.structuredChat)notify({kind:'success',text:'请将图片粘贴到左侧聊天输入框后发送。'});else void start('image')}}},
    h('div',{className:'cw-content'},
     h('header',{className:'cw-project-header'},
      h('div',{className:'cw-project-identity'},h('span',{className:'cw-project-icon'},h(ClaudeLogo,{size:30})),
       h('div',{className:'cw-project-name'},h('h1',null,title),h('span',null,'Claude 工作台')),
       h('span',{className:'cw-connection-badge','data-state':phase,role:'status'},h('i'),phaseLabels[phase]||'未连接')),
      h('dl',{className:'cw-route'},workspace&&h(React.Fragment,null,h('dt',null,'本机目录'),h('dd',{title:workspace.path},workspace.path)),
       ready&&bound&&cfg.host&&h(React.Fragment,null,h('dt',null,'云端主机'),h('dd',{title:cfg.host},cfg.host)))),
     configError&&h('div',{className:'cw-recovery'},h(ErrorNotice,{message:configError,title:'无法读取会话配置'}),h('button',{className:'cw-btn',onClick:retryConfig},'重新读取连接配置')),
     ready&&h('section',{className:'cw-connection-panel','data-mode':!bound?'first':recovering?'recover':'bound','aria-label':'会话连接'},
      !bound&&settings(),
      recovering&&h('h2',null,manuallyOff?'虚拟机已手动关闭':'恢复会话连接'),
      h(ErrorNotice,{message:failure,title:error?'连接状态读取失败':recovering?'连接中断':'操作未完成'}),
      error&&h('button',{className:'cw-text-button',onClick:refresh},'刷新连接状态'),
      h('div',{className:'cw-connect-area'},
      h('p',{className:'cw-connect-caption'},caption),
      h('div',{className:'cw-actions'},
       h('button',{className:'cw-btn cw-primary','data-action':'connect',disabled:!!working||powerBusy,'aria-busy':working==='claude',onClick:()=>start('claude')},working==='claude'?h('span',{className:'cw-spinner'}):h(Icon,{name:recovering?'refresh':'terminal',size:16}),working==='claude'?'正在连接…':connected?'打开 Claude 终端':recovering?'重连当前会话':bound?'继续会话':'接入 Claude'),
       h('button',{className:'cw-btn cw-secondary','data-action':'shell',disabled:!ready||!!working,onClick:()=>start('shell')},h(Icon,{name:'terminal',size:16}),'服务器终端')),
      !cfg.vmTools&&h('button',{className:'cw-text-button',disabled:!ready||!!working,onClick:()=>start('sync')},h(Icon,{name:'folder',size:14}),'文件同步',h(Icon,{name:'arrow',size:13})),
      !cfg.structuredChat&&h('button',{className:'cw-text-button',disabled:!ready||!!working,onClick:()=>start('image')},'上传剪贴板图片'))),

     notice?.kind==='success'&&h('div',{className:'cw-inline-message',role:'status'},h(Icon,{name:'check',size:15}),notice.text),
     ready&&bound&&cfg.structuredChat&&h(AgentStatus,{rpc,cfg,state,refresh,onOpenTerminal:()=>start('claude')}),
     bound&&settings(),
     ready&&h(PowerControls,{key:sessionId,rpc,power,refresh,onBusyChange:setPowerBusy,disabled:!!working}),
     !cfg.structuredChat&&cfg.desktopTools&&cfg.host&&h(DesktopRequests,{rpc,cfg,tabVisible}),
     cfg.vmTools&&bound&&connected&&h('footer',{className:'cw-workspace-footer'},h('button',{className:'cw-text-button cw-disconnect',title:'仅断开本聊天的虚拟机连接',disabled:!!working,onClick:disconnect},h(Icon,{name:'link',size:13}),working==='disconnect'?'正在断开…':'断开连接'))));
  }

  function apply(ctx){
   async function launch(session,tab,op,cfg){
    if(op==='claude'){
     cfg=await syncRequest(ctx,session,{...cfg,identity:cfg.identity||'',action:'session-connect',sessionId:session});
     if(cfg.structuredChat)op='native';
    }
    const choices=await ctx.webTerminals.launchShells(session,new AbortController().signal);
    const ps=choices.shells.find(s=>/(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(s.path));if(!ps)throw Error('当前 DSH 环境没有 Windows PowerShell 终端');
    const token=crypto.randomUUID();
    tab.actions.openTab('terminal',{params:{shellPath:ps.path,dshRemoteLaunch:token,dshRemoteOperation:op}});
    for(let n=0;n<150;n++){
     for(const t of ctx.sidebarRight.openTabs.getSnapshot()){
      if(t.sessionId!==session||t.kind!=='terminal')continue;
      const nav=ctx.sidebarRight.tabDomain.occurrence(session,{id:t.tabId}).navigation.getSnapshot();
      if(nav.params?.dshRemoteLaunch!==token)continue;
      const model=ctx.webTerminals.view(session,t.tabId,nav.address,nav.params.terminalId,ps.path);
      if(!model.state.getSnapshot()?.writable)continue;
      model.rename('Claude · '+(op==='shell'?'服务器终端':op==='native'?'Claude Code':labels[op])+' · '+cfg.project);
      model.write(launchCommand({action:op,host:cfg.host,project:cfg.project,identity:cfg.identity||'',sessionId:session,desktopMode:cfg.desktopTools?'desktop':'',remoteModel:cfg.remoteModel||'',vmTools:!!cfg.vmTools}));
      if(op==='claude'||op==='native'){
       const pane=document.querySelector('div[data-sidebar-right-tab="'+CSS.escape(t.tabId)+'"]');
       const target=pane && ctx.sidebarRight.focusedTarget(pane);
       if(target?.sessionId===session && pane.closest('[data-sidebar-right-panel="fullscreen"]'))ctx.sidebarRight.toggleFullscreen(target);
       document.querySelector('[data-composer-input]')?.focus();
      }
      return cfg;
     }
     await new Promise(r=>setTimeout(r,100));
    }
    throw Error('新终端未就绪，请检查本地 DSH 终端服务。');
   }

   const normalize=p=>p.replaceAll('\\','/').replace(/\/$/,'').toLowerCase();
   const registryKey=id+':folders';
   const readFolders=()=>JSON.parse(localStorage.getItem(registryKey)||'{}');
   const info=w=>{
    if(!w)return;
    const key=normalize(w.path), mapping=readFolders()[key];
    if(!mapping)return;
    return {...w,title:w.title||w.path.split(/[\\/]/).pop(),remoteName:mapping?.remoteName||'my-test'};
   };
   const workspaces=()=>ctx.workspaces.list.getSnapshot().items;
   async function openFolder(ws){
    await ctx.uiWorkspace.openWorkspace(ws.workspaceId);
    for(let i=0;i<120;i++){
     const target=ctx.sidebarRight.commandTarget(null);
     if(target && workspaces().find(w=>w.workspaceId===ws.workspaceId)?.sessionIds.includes(target.sessionId)){
      ctx.sidebarRight.openTabFromTarget(kind,target);return;
     }
     await new Promise(r=>setTimeout(r,100));
    }
    throw Error('本地工作区尚未就绪，请重试');
   }
   let adding=false;
   async function addFolder(){
    if(adding)return;adding=true;
    try{
     const picker=globalThis.__DSH_DIRECTORY_PICKER__;
     const path=await (picker?picker.pick():ctx.uiWorkspace.pickDirectory());
     if(!path)return;
     const ws=workspaces().find(w=>normalize(w.path)===normalize(path))||await ctx.workspaces.create({path});
     const key=normalize(path),map=readFolders();
     if(!map[key]){
      const slug=key.split('/').pop().replace(/[^a-z0-9_-]/g,'-').slice(0,28)||'project';
      map[key]={remoteName:slug+'-'+crypto.randomUUID().slice(0,8)};
      localStorage.setItem(registryKey,JSON.stringify(map));
     }
     refresh();await openFolder(ws);
    }catch(e){window.alert(e.message||String(e))}finally{adding=false}
   }
   let refresh=()=>{};
   const css=document.createElement('style');
   css.textContent=WORKBENCH_CSS;
      ctx.effect(()=>{
    const rows=document.createElement('style');
    const terminalMouseDisposers=[];
    const makeButton=(label,callback,role)=>{
     const button=document.createElement('button');button.type='button';button.dataset.dshClaudeControl=role;
     button.textContent=label;button.title=label;button.className='dsh-claude-action';
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
      if(!['claude','native'].includes(params?.dshRemoteOperation)||!params.dshRemoteLaunch)continue;
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
      if(params.dshRemoteOperation==='native'){
       const model=()=>navigation().params?.dshRemoteLaunch===params.dshRemoteLaunch?ctx.webTerminals.view(owner.sessionId,tabId,nav.address,params.terminalId,params.shellPath):null;
       const mouse=installTerminalMouse(root,model);terminalMouseDisposers.push(()=>mouse.dispose());
       let selecting=true;
       const toggle=makeButton('鼠标选字',()=>{selecting=!selecting;mouse.setSelectText(selecting);toggle.textContent=selecting?'鼠标选字':'鼠标操作 CC';toggle.setAttribute('aria-pressed',String(selecting));},'mouse-mode');
       toggle.title='默认拖选本机文字；切换后可点击 CC 菜单';toggle.setAttribute('aria-pressed','true');bar.append(toggle);
       bar.append(makeButton('复制选中',()=>{note.textContent=mouse.copy()?'已复制':'请先在终端拖选文字，再按 Ctrl+C';},'copy'));
       for(const [label,key] of [['↑ 翻页','\x1b[5~'],['↓ 翻页','\x1b[6~'],['回到底部','\x1b[1;5F']])bar.append(makeButton(label,()=>{const terminal=model();if(terminal?.state.getSnapshot()?.writable){terminal.write(key);root.querySelector('.xterm-helper-textarea')?.focus();}},'scroll'));
      }
      root.prepend(bar);
     }
    }
    function decorate(){
     decorateClaudeTerminals();
     const add=document.querySelector('button[aria-label="添加工作区"],button[aria-label="Add workspace"]');
     const header=add?.closest('[class*=headerActions]')?.parentElement; if(header && !header.parentElement.querySelector('[data-dsh-claude-control=add]')){const b=makeButton('＋ 添加 Claude 工作区',addFolder,'add');b.style.cssText+=';display:block;margin:2px 12px 6px;text-align:left;flex:none';header.after(b)}
     const folders=workspaces().filter(info);
     const registeredIds=new Set(folders.map(w=>w.workspaceId));
     for(const button of document.querySelectorAll('[data-dsh-claude-control=open]')){
      const owner=button.dataset.workspaceId;
      if(!registeredIds.has(owner)||button.parentElement?.dataset.rowKey!=='workspace:'+owner)button.remove();
     }
     for(const w of folders){
      const row=document.querySelector('[data-row-key="'+CSS.escape('workspace:'+w.workspaceId)+'"]');
      if(row && !row.querySelector('[data-dsh-claude-control=open]')){
       const open=makeButton('工作台',()=>openFolder(w),'open');
       const mark=document.createElement('img');
       mark.src=claudeMark;mark.alt='';mark.width=15;mark.height=15;mark.draggable=false;open.prepend(mark);
       open.dataset.workspaceId=w.workspaceId;
       open.title='打开 Claude 工作台';open.setAttribute('aria-label','打开 '+(w.title||w.path)+' 的 Claude 工作台');row.append(open);
      }
     }
    }
    refresh=()=>{};
    document.head.append(css,rows);refresh();decorate();const off=ctx.workspaces.list.subscribe(()=>{refresh();decorate()});const observer=new MutationObserver(decorate);observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-row-key']});
    return ()=>{observer.disconnect();off();terminalMouseDisposers.forEach(dispose=>dispose());document.querySelectorAll("[data-dsh-claude-control]").forEach(el=>el.remove());css.remove();rows.remove()};
   });
   ctx.effect(()=>{
    const dock=document.createElement('details'),toggle=document.createElement('summary'),card=document.createElement('section');
    dock.className='dsh-quota';toggle.textContent='◴  Claude 额度';toggle.title='查看 Claude 套餐额度';
    const style=document.createElement('style');
    style.textContent='';
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
     const next=cfg?.host?JSON.stringify([session,cfg.host,cfg.identity]):'';
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
   ctx.effect(()=>ctx.sidebarRightTabs.register(workbenchTab));
   for(const [name,component] of [['sidebar.right.pane.tab',Body],['sidebar.right.pane.tab.title',()=>h('span',{className:'dsh-claude-tab'},'Claude 工作台')]]){
    ctx.effect(()=>ctx.slots.inject(name,()=>ctx.slots.register({name,key:id,inject:session=>({sessionId:session,rpc:(req,progress)=>syncRequest(ctx,session,{...req,sessionId:session},progress),workspace:info(workspaces().find(w=>w.sessionIds.includes(session))),launch:(...args)=>launch(session,...args)})},component)));
   }
  }
  return {inject,apply};
 }
});
