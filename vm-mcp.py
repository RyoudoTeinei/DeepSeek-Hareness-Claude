"""Cloud stdio MCP proxy. Native tools execute exclusively in the dedicated VM."""
import importlib.util
import json
from pathlib import Path
import socket
import sys
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

spec=importlib.util.spec_from_file_location('vm_relay',Path(__file__).with_name('vm-relay.py'))
relay=importlib.util.module_from_spec(spec);spec.loader.exec_module(relay)


def invoke(scope, method, params, call_id=None):
    _, binding=relay.configuration(scope)
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:
        client.settimeout(180)
        client.connect(str(relay.socket_path(scope)))
        request={'token':binding['token'],'operation':'mcp','arguments':{'method':method,'params':params,'callId':call_id}}
        client.sendall((json.dumps(request)+'\n').encode())
        with client.makefile('rb') as stream:
            line=stream.readline(relay.MAX_MESSAGE+1)
        if not line or len(line)>relay.MAX_MESSAGE:raise ValueError('VM MCP response missing or too large')
        response=json.loads(line)
        if not response.get('ok'):raise ValueError(response.get('error','VM tool failed'))
        return response['result']


def serve(scope):
    active={};lock=threading.Lock();writing=threading.Lock()
    def emit(response):
        with writing:print(json.dumps(response,ensure_ascii=True),flush=True)
    def respond(request,call_id):
        response={'jsonrpc':'2.0','id':request['id']}
        try:
            method=request.get('method')
            if method=='initialize':
                response['result']={'protocolVersion':'2025-11-25','serverInfo':{'name':'dsh_local_vm','version':'0.4.0-vm.4'},'capabilities':{'tools':{}},'instructions':'Native Claude tools run inside this conversation’s isolated Linux VM namespace, with no model login. Use only these tools for project files and commands. Cloud Agent and Skill orchestration remain available. The VM cannot access the public network.'}
            elif method=='ping':response['result']={}
            elif method in ('tools/list','tools/call'):
                response['result']=invoke(scope,method,request.get('params',{}),call_id)
            else:response['error']={'code':-32601,'message':'Unsupported MCP method'}
        except (OSError,ValueError,KeyError) as error:
            if request.get('method')=='tools/call':
                response['result']={'isError':True,'content':[{'type':'text','text':'Local VM tool unavailable: '+str(error)+'. Do not substitute cloud execution or blindly retry writes.'}]}
            else:response['error']={'code':-32603,'message':str(error)}
        finally:
            with lock:active.pop(request['id'],None)
        emit(response)
    def cancel(call_id):
        try:invoke(scope,'notifications/cancelled',{},call_id)
        except (OSError,ValueError):pass
    with ThreadPoolExecutor(max_workers=16) as pool:
        for line in sys.stdin.buffer:
            request=json.loads(line)
            if request.get('method')=='notifications/cancelled':
                with lock:
                    entry=active.get(request.get('params',{}).get('requestId'))
                    if entry and not entry['cancelled']:
                        entry['cancelled']=True;pool.submit(cancel,entry['call_id'])
                continue
            if 'id' not in request:continue
            with lock:
                if request['id'] in active or len(active)>=8:
                    emit({'jsonrpc':'2.0','id':request['id'],'error':{'code':-32600,'message':'Duplicate request or too many pending tools'}});continue
                call_id=uuid.uuid4().hex;active[request['id']]={'call_id':call_id,'cancelled':False}
            pool.submit(respond,request,call_id)
        with lock:
            for entry in active.values():pool.submit(cancel,entry['call_id'])


if __name__=='__main__':serve(sys.argv[1])
