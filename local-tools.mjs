import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync} from 'node:fs';
import {realpath} from 'node:fs/promises';
import {createServer} from 'node:net';
import {homedir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {redactText,redactValue,filterToolResult} from './output-filter.mjs';
export {redactText,filterToolResult} from './output-filter.mjs';
import {workstationTools} from './tool-routing.mjs';
export async function openLocalTools(workspace){
 const root=await realpath(workspace);
 const native=path.join(homedir(),'.local','bin',process.platform==='win32'?'claude.exe':'claude');
 const executable=existsSync(native)?native:'claude';
 const token=randomBytes(32).toString('hex');
 const connections=new Set();
 const exits=new Set();
 let closing;
 function shutdown(){
  return closing??=(async()=>{
   for(const socket of connections)socket.destroy();
   server.close();
   await Promise.all([...exits]);
  })();
 }
 const server=createServer(socket=>{
  const input=createInterface({input:socket,crlfDelay:Infinity});
  let child,output,shutdownTimer;
  const methods=new Map();
  connections.add(socket);
  function close(){
   connections.delete(socket);
   input.close();
   output?.close();
   child?.stdin.end();
   if(child&&child.exitCode===null){
    shutdownTimer=setTimeout(()=>child.kill(),2000);
    shutdownTimer.unref();
   }
  }
  socket.on('error',()=>socket.destroy());
  socket.once('close',close);
  input.on('line',line=>{
   if(!child){
    let auth;
    try{auth=JSON.parse(line)}catch{socket.destroy();return}
    if(auth.token!==token){socket.destroy();return}
    if(auth.close===true){void shutdown();return}
    child=spawn(executable,['mcp','serve'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','ignore']});
    const exited=new Promise(resolve=>child.once('close',resolve));
    exits.add(exited);
    exited.then(()=>exits.delete(exited));
    child.stdin.on('error',()=>socket.destroy());
    child.once('error',()=>socket.destroy());
    child.once('close',()=>{clearTimeout(shutdownTimer);socket.end()});
    output=createInterface({input:child.stdout,crlfDelay:Infinity});
    output.on('line',nativeLine=>{
     const message=JSON.parse(nativeLine);
     const method=methods.get(message.id);
     methods.delete(message.id);
     if(method==='initialize'&&message.result){
      const context='Project working directory: '+root+'. Project file and shell tools execute on '+process.platform+'.';
      message.result.instructions=redactText([message.result.instructions,context].filter(Boolean).join('\n'));
     }
     if(method==='tools/list'&&message.result)
      message.result.tools=workstationTools(message.result.tools);
     if(method==='tools/call'&&message.result)message.result=filterToolResult(message.result);
     if(message.error)message.error=redactValue(message.error);
     if(message.method==='notifications/message'&&message.params)message.params=redactValue(message.params);
     socket.write(JSON.stringify(message)+'\n');
    });
    return;
   }
   const request=JSON.parse(line);
   if(request.method&&Object.hasOwn(request,'id'))methods.set(request.id,request.method);
   child.stdin.write(line+'\n');
  });
 });
 await new Promise((resolve,reject)=>{
  server.once('error',reject);
  server.listen(0,'127.0.0.1',resolve);
 });
 return {token,port:server.address().port,close:shutdown};
}
