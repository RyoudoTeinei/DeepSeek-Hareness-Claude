// A persistent MCP process: background jobs and read-before-edit state survive calls.
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {randomBytes} from 'node:crypto';

export const VM_EXECUTOR_VERSION='2.1.322';
export const VM_TOOL_NAMES=new Set(['Read','Write','Edit','MultiEdit','Glob','Grep','LS','NotebookEdit','Bash','BashOutput','TaskOutput','TaskStop']);
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";

export class NativeVMClient{
 constructor(guest,sshArguments){this.guest=guest;this.sshArguments=sshArguments;this.pending=new Map();this.jobs=new Map();this.foreground=new Map();this.sequence=0;this.closed=false;}
 async start(){
  const jobSource=(await readFile(new URL('./vm-job.py',import.meta.url))).toString('base64');
  const source=Buffer.from((await readFile(new URL('./vm-native.py',import.meta.url),'utf8')).replace('__DSH_JOB_SOURCE__',jobSource)).toString('base64');
  const python='import base64;exec(compile(base64.b64decode('+JSON.stringify(source)+'),"vm-native.py","exec"))';
  this.child=spawn('ssh',[...this.sshArguments(this.guest),'python3 -c '+quote(python)+' --root '+quote(this.guest.root)+' --instance '+quote(this.guest.instanceId)],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  this.error='';this.child.stderr.on('data',b=>{this.error=(this.error+b).slice(-1200)});
  this.child.stdin.on('error',()=>{});
  this.lines=createInterface({input:this.child.stdout});
  this.lines.on('line',line=>{
   if(Buffer.byteLength(line)>8*1024*1024){this.fail('VM MCP response exceeds transport limit');return;}
   let response;try{response=JSON.parse(line)}catch{this.fail('VM MCP returned invalid JSON');return;}
   const pending=this.pending.get(response.id);
   if(pending){clearTimeout(pending.timer);this.pending.delete(response.id);response.error?pending.reject(Error(response.error.message)):pending.resolve(response.result);}
  });
  this.done=new Promise(resolve=>this.child.once('close',()=>{this.fail(this.error||'VM MCP executor disconnected');resolve()}));
  this.child.once('error',error=>this.fail(error.message));
  const init=await this.rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'dsh-vm-bridge',version:'0.4.0-vm.4'}});
  this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  if(init.serverInfo?.version!==VM_EXECUTOR_VERSION)throw Error('Unexpected VM Claude version: '+init.serverInfo?.version);
  this.info=init.serverInfo;
  this.catalog=await this.rpc('tools/list',{});
  for(const required of ['Read','Write','Edit','Bash'])if(!this.catalog.tools?.some(t=>t.name===required))throw Error('VM Claude tool missing: '+required);
  return this;
 }
 fail(message){this.closed=true;this.child?.stdin.end();for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(Error(message));}this.pending.clear();}
 rpc(method,params){
  if(this.closed)return Promise.reject(Error('VM MCP is offline'));
  const id=++this.sequence;
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('VM tool did not return a confirmed result; inspect state before retrying'));},165000);
   this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
 }
 async request(args){
  if(args.method==='notifications/cancelled'){
   if(!/^[a-f0-9]{32}$/.test(args.callId||''))throw Error('Invalid cancellation binding');
   return this.cancelForeground(args.callId);
  }
  if(args.method==='tools/list')return {tools:this.catalog.tools.filter(t=>VM_TOOL_NAMES.has(t.name)).map(t=>{
   const tool=structuredClone(t);tool.description='Executes inside the LOCAL LINUX VM. Shared project: '+this.guest.root+'. '+(tool.description||'');
   if(tool.name==='Bash')tool.description='Run a Linux command through the VM native Claude executor. Each call starts in '+this.guest.root+'; use cd within the command or absolute paths. Shell exports and directory changes do not persist between calls. Long commands can run_in_background; read backgroundOutputPath with VM Read and stop backgroundTaskId with VM TaskStop. No public network. Only the shared project reaches Windows files.';
   if(tool.name==='Bash'&&tool.inputSchema?.properties?.timeout){tool.inputSchema.properties.timeout.maximum=120000;tool.inputSchema.properties.timeout.description='Foreground timeout in milliseconds, at most 120000. Use run_in_background for long jobs, then read backgroundOutputPath using VM Read.';}
   if(tool.name==='TaskStop')tool.description='Stop a background command created by this VM MCP connection. Use the backgroundTaskId returned by VM Bash. Does not control cloud agents or another session.';
   return tool;
  })};
  if(args.method!=='tools/call'||!VM_TOOL_NAMES.has(args.params?.name))throw Error('This tool is not exposed by the VM executor');
  if(args.params.name==='Bash'&&args.params.arguments?.timeout>120000)throw Error('Use run_in_background for commands longer than 120 seconds');
  const script='/home/dshvm/.local/state/dsh-cc-native/'+this.guest.root.split('/').pop()+'/job.py';
  if(args.params.name==='TaskStop'){
   const id=args.params.arguments?.task_id||args.params.arguments?.shell_id,job=this.jobs.get(id);
   if(!job)return {isError:true,content:[{type:'text',text:'Task ID does not belong to this VM connection'}]};
   return this.rpc('tools/call',{name:'Bash',arguments:{command:'python3 '+quote(script)+' stop '+job,description:'Stop this VM connection’s background job'}});
  }
  if(args.params.name==='Bash'){
   const job=randomBytes(16).toString('hex'),original=args.params.arguments;
   if(typeof original?.command!=='string')throw Error('Bash command is required');
   const command='python3 '+quote(script)+' run '+job+' '+quote(Buffer.from(original.command).toString('base64'));
   const key=args.callId||randomBytes(16).toString('hex');
   if(!original.run_in_background)this.foreground.set(key,job);
   try{
    const result=await this.rpc('tools/call',{...args.params,arguments:{...original,command}});
    for(const block of result.content||[]){if(block.type==='text')try{const data=JSON.parse(block.text);if(data.backgroundTaskId)this.jobs.set(data.backgroundTaskId,job)}catch{}}
    return result;
   }finally{this.foreground.delete(key);}
  }
  return this.rpc('tools/call',args.params);
 }
 async cancelForeground(callId){
  const jobs=callId?[this.foreground.get(callId)].filter(Boolean):[...this.foreground.values()];
  const script='/home/dshvm/.local/state/dsh-cc-native/'+this.guest.root.split('/').pop()+'/job.py';
  await Promise.all(jobs.map(job=>this.rpc('tools/call',{name:'Bash',arguments:{command:'python3 '+quote(script)+' stop '+job,description:'Cancel this VM foreground command'}})));
  return {};
 }
 async stop(){
  if(!this.child)return;
  this.child.stdin.end();
  let timer;await Promise.race([this.done,new Promise(resolve=>{timer=setTimeout(()=>{this.child.kill();resolve()},5000)})]);clearTimeout(timer);
  this.lines.close();this.fail('VM MCP stopped');
 }
}
