import {spawn} from 'node:child_process';
import {openSync,closeSync,writeFileSync,readFileSync,existsSync,unlinkSync,renameSync} from 'node:fs';
import path from 'node:path';
const [state,exe,...args]=process.argv.slice(2);
const stop=path.join(state,'stop.request'),lock=path.join(state,'supervisor.lock');
function alive(pid){try{process.kill(pid,0);return true}catch{return false}}
if(existsSync(lock)){
 let owner;
 try{owner=JSON.parse(readFileSync(lock,'utf8'))}catch{process.exit(1)}
 if(alive(owner.pid))process.exit(0);
 unlinkSync(lock);
}
let fd;
try{fd=openSync(lock,'wx')}catch{process.exit(0)}
writeFileSync(fd,JSON.stringify({pid:process.pid}));closeSync(fd);
function report(message){
 const file=path.join(state,'supervisor.json'),temp=file+'.next';
 writeFileSync(temp,JSON.stringify({pid:process.pid,time:Date.now()/1000,message}));
 renameSync(temp,file);
}
function finish(){try{if(JSON.parse(readFileSync(lock,'utf8')).pid===process.pid)unlinkSync(lock)}catch{};process.exit(0)}
let failures=0,worker=null;
setInterval(()=>{if(!worker&&existsSync(stop))finish()},250).unref();
async function run(){
 if(existsSync(stop))return finish();
 try{
  const worker=JSON.parse(readFileSync(path.join(state,'running.json'),'utf8'));
  if(alive(worker.pid)){report('现有同步进程运行中');setTimeout(run,3000);return}
 }catch{}
 report('启动同步进程');
 const started=Date.now();
 const child=spawn(exe,args,{windowsHide:true,stdio:'ignore'});
 worker=child;
 let ended=false;
 function restart(error){
  if(ended)return;ended=true;worker=null;
  if(existsSync(stop))return finish();
  failures=Date.now()-started>60000?0:failures+1;
  const delay=Math.min(60000,1000*2**Math.min(failures,6));
  report('进程退出，'+delay/1000+' 秒后重试'+(error?' · '+error:''));
  setTimeout(run,delay);
 }
 child.once('error',e=>restart(e.message));
 child.once('exit',code=>restart('exit '+code));
}
process.once('exit',()=>{try{if(JSON.parse(readFileSync(lock,'utf8')).pid===process.pid)unlinkSync(lock)}catch{}});
run();
