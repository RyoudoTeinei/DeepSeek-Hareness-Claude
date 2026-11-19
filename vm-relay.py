"""Cloud-side Unix socket to an outbound SSH stdio connection from the desktop."""
import asyncio
import hmac
import json
import os
from pathlib import Path
import re
import sys
import uuid

MAX_MESSAGE=8*1024*1024
OPERATIONS={'mcp'}


def configuration(scope):
    if not re.fullmatch('[0-9a-f]{32}',scope):raise ValueError('Invalid scope')
    root=Path(__file__).resolve().parent/'sessions'/scope
    cfg=json.loads((root/'binding.json').read_text())
    if not re.fullmatch('[0-9a-f]{64}',cfg['token']):raise ValueError('Invalid binding')
    return root,cfg


def socket_path(scope):
    folder=Path('/tmp')/('dsh-vm-'+str(os.getuid()))
    folder.mkdir(mode=0o700,exist_ok=True)
    if folder.is_symlink() or folder.stat().st_uid!=os.getuid():raise ValueError('Unsafe socket directory')
    os.chmod(folder,0o700)
    return folder/(scope+'.sock')


async def run(scope):
    import fcntl
    root,cfg=configuration(scope)
    lock=(root/'relay.lock').open('a')
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:raise ValueError('This workspace already has a connected local executor')
    endpoint=socket_path(scope);endpoint.unlink(missing_ok=True)
    pending={}
    chats={}
    closing=asyncio.Event()
    sequence=asyncio.Lock()
    reader=asyncio.StreamReader(limit=MAX_MESSAGE)
    await asyncio.get_running_loop().connect_read_pipe(lambda:asyncio.StreamReaderProtocol(reader),sys.stdin.buffer)
    async def emit(value):
        async with sequence:
            sys.stdout.write(json.dumps(value,ensure_ascii=True)+'\n');sys.stdout.flush()
    async def response_pump():
        try:
            while line:=await reader.readline():
                if len(line)>MAX_MESSAGE:break
                response=json.loads(line)
                identifier=response.get('id')
                if response.get('type')=='chat_start':
                    if not isinstance(identifier,str) or not re.fullmatch('[a-f0-9]{32}',identifier):continue
                    if chats:
                        await emit({'type':'chat_end','id':identifier,'code':1,'error':'This conversation already has a running turn'});continue
                    wire=response.get('wire')
                    if not isinstance(wire,dict) or set(wire)-{'turn','text','model'} or not isinstance(wire.get('text'),str) or not re.fullmatch('[a-f0-9]{32}',wire.get('turn','')):continue
                    chats[identifier]={'task':asyncio.create_task(chat(identifier,wire)),'process':None}
                    continue
                if response.get('type')=='chat_cancel':
                    process=chats.get(identifier,{}).get('process')
                    if process and process.returncode is None:
                        process.stdin.write(b'{"type":"cancel"}\n');await process.stdin.drain()
                    continue
                future=pending.get(identifier)
                if future is not None and not future.done():future.set_result(response)
        finally:
            closing.set()
            for future in pending.values():
                if not future.done():future.set_result({'ok':False,'error':'Local VM disconnected; execution outcome may be unknown. Do not retry writes blindly.'})
    async def chat(identifier,wire):
        process=None
        try:
            native=Path(__file__).resolve().with_name('native-peer.py')
            process=await asyncio.create_subprocess_exec('python3',str(native),'turn',scope,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL,limit=MAX_MESSAGE)
            chats[identifier]['process']=process
            process.stdin.write((json.dumps(wire,ensure_ascii=False,separators=(',',':'))+'\n').encode());await process.stdin.drain()
            async for line in process.stdout:
                if line.startswith(b'DSH_AGENT:'):
                    await emit({'type':'chat_frame','id':identifier,'frame':json.loads(line[10:])})
            code=await process.wait()
            await emit({'type':'chat_end','id':identifier,'code':code})
        except asyncio.CancelledError:
            if process and process.returncode is None:
                process.stdin.write(b'{"type":"cancel"}\n')
                try:await process.stdin.drain();await asyncio.wait_for(process.wait(),4)
                except (TimeoutError,BrokenPipeError,ConnectionError):process.terminate()
            raise
        except Exception:
            await emit({'type':'chat_end','id':identifier,'code':1,'error':'Native conversation stream failed; inspect saved state before retrying'})
        finally:
            if process and process.stdin:process.stdin.close()
            chats.pop(identifier,None)
    async def handle(client,writer):
        identifier=None
        try:
            line=await asyncio.wait_for(client.readline(),10)
            request=json.loads(line)
            if set(request)!={'token','operation','arguments'} or not hmac.compare_digest(str(request['token']),cfg['token']):
                raise ValueError('VM bridge authorization failed')
            if request['operation'] not in OPERATIONS or not isinstance(request['arguments'],dict):raise ValueError('Unsupported VM operation')
            if closing.is_set():raise ValueError('Local VM is offline')
            limit=16 if request['arguments'].get('method')=='notifications/cancelled' else 8
            if len(pending)>=limit:raise ValueError('Local VM request queue is full; wait for its current tools')
            identifier=uuid.uuid4().hex
            future=asyncio.get_running_loop().create_future();pending[identifier]=future
            await emit({'type':'request','id':identifier,'operation':request['operation'],'arguments':request['arguments']})
            response=await asyncio.wait_for(future,180)
            writer.write((json.dumps(response)+'\n').encode());await writer.drain()
        except Exception as error:
            message=str(error) if isinstance(error,ValueError) else 'VM execution did not return a confirmed result; inspect the workspace before retrying'
            writer.write((json.dumps({'ok':False,'error':message})+'\n').encode())
            try:await writer.drain()
            except (BrokenPipeError,ConnectionError):pass
        finally:
            if identifier:pending.pop(identifier,None)
            writer.close()
            try:await writer.wait_closed()
            except (BrokenPipeError,ConnectionError):pass
    server=await asyncio.start_unix_server(handle,str(endpoint),limit=MAX_MESSAGE)
    os.chmod(endpoint,0o600)
    task=asyncio.create_task(response_pump())
    try:
        await emit({'type':'ready','scope':scope})
        await closing.wait()
    finally:
        tasks=[entry['task'] for entry in list(chats.values())]
        for entry in tasks:entry.cancel()
        await asyncio.gather(*tasks,return_exceptions=True)
        server.close();await server.wait_closed();endpoint.unlink(missing_ok=True)
        task.cancel()
        lock.close()


if __name__=='__main__':
    try:asyncio.run(run(sys.argv[1]))
    except Exception as error:
        print(json.dumps({'type':'error','message':str(error)}),flush=True)
        sys.exit(1)
