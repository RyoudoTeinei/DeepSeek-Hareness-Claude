import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
// One RPC per PTY. Both request and response use acknowledgements, so a
// rendered terminal frame cannot silently drop a burst of result chunks.
const key=randomUUID().replaceAll('-','');
process.stdin.setRawMode(true);
process.stdin.setEncoding('ascii');
let payload='',encoded='',sequence=0,lastSequence=0,offset=0,output=false,timer;
const chunkSize=Math.max(16,Math.min(512,(process.stdout.columns||80)-24));
function send(){
 clearTimeout(timer);
 if(offset>=encoded.length){
  process.stdout.write('!END:'+key+'!\r\n',()=>process.exit(0));return;
 }
 lastSequence=Math.min(sequence+7,Math.ceil(encoded.length/chunkSize)-1);
 for(let index=sequence;index<=lastSequence;index++){
  const start=index*chunkSize;
  process.stdout.write('!D:'+index+'.'+encoded.slice(start,start+chunkSize)+'!\r\n');
 }
 timer=setTimeout(()=>process.exit(1),60000);
}
process.stdout.write('!READY:'+key+'!\r\n');
process.stdout.on('error',()=>process.exit(1));
process.stdin.on('end',()=>process.exit(0));
process.stdin.on('data',part=>{
 payload+=part;
 if(output){
  let match;
  while((match=/@(\d+)!/.exec(payload))){
   payload=payload.slice(match.index+match[0].length);
   if(Number(match[1])!==lastSequence)continue;
   sequence=lastSequence+1;offset=sequence*chunkSize;send();
  }
  return;
 }
 if(payload.length>4*1024*1024)process.exit(1);
 if(payload.endsWith('.')){
  payload=payload.slice(0,-1);process.stdout.write('!ACK:'+key+'!\r\n');return;
 }
 if(!payload.includes('!'))return;
 process.stdin.pause();
 const input=Buffer.from(payload.split('!')[0],'base64');
 const r=spawnSync(process.execPath,[fileURLToPath(new URL('./sync.mjs',import.meta.url))],{input,maxBuffer:32*1024*1024,timeout:1800000,stdio:['pipe','pipe',2],env:{...process.env,DSH_PROGRESS:'1'}});
 const result=r.stdout?.length?r.stdout:Buffer.from(JSON.stringify({ok:false,error:r.error?.message||'同步进程未返回结果'}));
 encoded=result.toString('base64');
 payload='';output=true;send();process.stdin.resume();
});
