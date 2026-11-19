"""Session-scoped remote Claude runner, attachment transport and artifact MCP.

Only this namespace is written. No tmux sessions or global Claude settings are changed.
"""
import base64
import contextlib
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid

MAX_BYTES = 100 * 1024 * 1024
ID = re.compile(r'^[a-f0-9]{32}$')
SHA = re.compile(r'^[a-f0-9]{64}$')
PREFIX = 'DSH_AGENT:'


def emit(value):
    print(PREFIX + json.dumps(value, ensure_ascii=True), flush=True)


def save(file, value):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(dir=file.parent, mode='w', encoding='utf-8', delete=False) as temporary:
        json.dump(value, temporary, ensure_ascii=True)
        temporary.flush()
        os.fsync(temporary.fileno())
    os.replace(temporary.name, file)


def project_path(root, relative):
    if not isinstance(relative, str) or not relative or len(relative) > 500 or re.search(r'[\\:\x00-\x1f]', relative):
        raise ValueError('Use a project-relative path')
    parts = relative.split('/')
    if any(part in ('', '.', '..') for part in parts):
        raise ValueError('Invalid project path')
    return root.joinpath(*parts)


@contextlib.contextmanager
def read_project_file(root, relative):
    project_path(root, relative)
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        parts = relative.split('/')
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=directory)
        with os.fdopen(descriptor, 'rb') as file:
            metadata = os.fstat(file.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_BYTES:
                raise ValueError('Only regular files up to 100 MiB are supported')
            yield file
    finally:
        os.close(directory)


def scope_root(scope):
    if not ID.fullmatch(scope):
        raise ValueError('Invalid scope')
    return Path(__file__).resolve().parent / 'sessions' / scope


def workspace(directory):
    config = json.loads((directory / 'binding.json').read_text())
    project = config['project']
    if not re.fullmatch(r'\w[\w-]{0,47}', project):
        raise ValueError('Invalid project')
    root = Path.home() / 'projects' / project
    if root.is_symlink():
        raise ValueError('Project root cannot be a symlink')
    root.mkdir(parents=True, exist_ok=True)
    return root


def upload(directory):
    header = json.loads(sys.stdin.buffer.readline(16384))
    name, size, digest = header['name'], header['size'], header['sha256']
    if not isinstance(name, str) or not name or len(name) > 150 or re.search(r'[/\\:\x00-\x1f]', name) or name in ('.','..'):
        raise ValueError('Invalid attachment name')
    if type(size) is not int or not 0 <= size <= MAX_BYTES or not SHA.fullmatch(digest):
        raise ValueError('Invalid attachment metadata')
    root = workspace(directory)
    folder = root / '.dsh-attachments'
    folder.mkdir(exist_ok=True, mode=0o700)
    if folder.is_symlink():
        raise ValueError('Attachment directory cannot be a symlink')
    folder = folder / digest
    folder.mkdir(exist_ok=True, mode=0o700)
    if folder.is_symlink():
        raise ValueError('Attachment directory cannot be a symlink')
    destination = folder / name
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=folder, delete=False) as file:
            temporary = Path(file.name)
            total = 0
            actual = hashlib.sha256()
            while True:
                chunk = sys.stdin.buffer.read(65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > size:
                    raise ValueError('Attachment size changed')
                actual.update(chunk)
                file.write(chunk)
            file.flush()
            os.fsync(file.fileno())
        if total != size or actual.hexdigest() != digest:
            raise ValueError('Attachment verification failed')
        if destination.exists():
            with read_project_file(root, str(destination.relative_to(root))) as file:
                existing=hashlib.sha256()
                for chunk in iter(lambda:file.read(65536),b''):existing.update(chunk)
                if existing.hexdigest() != digest:
                    raise ValueError('Existing attachment differs')
        else:
            os.link(temporary, destination)
            destination.chmod(0o400)
        emit({'type':'uploaded','path':str(destination.relative_to(root)),'sha256':digest,'size':size})
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def publish(directory, turn, relative):
    root = workspace(directory)
    identifier = uuid.uuid4().hex
    folder = directory / 'turns' / turn / 'artifacts'
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    output = folder / (identifier + '.blob')
    try:
        with read_project_file(root, relative) as source, output.open('xb') as target:
            before = os.fstat(source.fileno())
            digest = hashlib.sha256()
            total = 0
            while True:
                chunk = source.read(65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_BYTES:
                    raise ValueError('Artifact exceeds 100 MiB')
                digest.update(chunk)
                target.write(chunk)
            after = os.fstat(source.fileno())
            if (before.st_size,before.st_mtime_ns) != (after.st_size,after.st_mtime_ns):
                raise ValueError('Artifact changed while publishing')
        record = {'id':identifier,'name':Path(relative).name,'size':total,'sha256':digest.hexdigest()}
        save(folder / (identifier+'.json'), record)
        return record
    except Exception:
        output.unlink(missing_ok=True)
        raise


def mcp(directory, turn):
    tool = {'name':'publish_artifact','description':'Return a generated project file to the user in DSH. Call after writing each final deliverable. Supply a project-relative path. The host downloads a verified snapshot and presents an Open button.',
            'inputSchema':{'type':'object','properties':{'path':{'type':'string','maxLength':500}},'required':['path'],'additionalProperties':False},
            'annotations':{'readOnlyHint':False,'destructiveHint':False,'openWorldHint':False}}
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if 'id' not in request:
                continue
            response = {'jsonrpc':'2.0','id':request['id']}
            method, params = request.get('method'), request.get('params') or {}
            if method == 'initialize':
                response['result']={'protocolVersion':'2025-11-25','capabilities':{'tools':{}},'serverInfo':{'name':'dsh_artifacts','version':'1.0'}}
            elif method == 'tools/list':
                response['result']={'tools':[tool]}
            elif method == 'ping':
                response['result']={}
            elif method == 'tools/call':
                try:
                    args = params.get('arguments')
                    if params.get('name') != 'publish_artifact' or not isinstance(args,dict) or set(args) != {'path'}:
                        raise ValueError('Invalid tool request')
                    result = publish(directory,turn() if callable(turn) else turn,args['path'])
                    response['result']={'content':[{'type':'text','text':json.dumps(result)}],'structuredContent':result}
                except (OSError,ValueError):
                    response['result']={'isError':True,'content':[{'type':'text','text':'Cannot publish this file. Use an existing regular file inside the project, up to 100 MiB.'}]}
            else:
                response['error']={'code':-32601,'message':'Method not found'}
            print(json.dumps(response),flush=True)
        except (ValueError,TypeError,KeyError):
            print(json.dumps({'jsonrpc':'2.0','id':None,'error':{'code':-32600,'message':'Invalid request'}}),flush=True)


def download(directory, turn, identifier):
    if not ID.fullmatch(turn) or not ID.fullmatch(identifier):
        raise ValueError('Invalid artifact ID')
    folder = directory / 'turns' / turn / 'artifacts'
    record = json.loads((folder/(identifier+'.json')).read_text())
    with read_project_file(folder,identifier+'.blob') as file:
        emit({'type':'file','size':record['size']})
        digest = hashlib.sha256()
        total = 0
        while True:
            chunk = file.read(49152)
            if not chunk:
                break
            digest.update(chunk)
            total += len(chunk)
            emit({'type':'data','base64':base64.b64encode(chunk).decode('ascii')})
        if digest.hexdigest()!=record['sha256'] or total!=record['size']:
            raise ValueError('Artifact snapshot changed')
        emit({'type':'end','sha256':record['sha256'],'size':total})


def run_turn(directory, scope):
    import fcntl
    first = sys.stdin.buffer.readline(4 * 1024 * 1024)
    request = json.loads(first)
    if set(request)-{'turn','text','model','budget'} or not ID.fullmatch(request.get('turn','')) or not isinstance(request.get('text'),str):
        raise ValueError('Invalid turn')
    turn = request['turn']
    folder = directory/'turns'/turn
    fingerprint=hashlib.sha256(first).hexdigest()
    directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    lock=(directory/'session.lock').open('a')
    try:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        raise ValueError('This conversation is busy; wait for the current turn')
    log=folder/'events.jsonl'
    if folder.exists():
        prior=json.loads((folder/'request.json').read_text())
        if prior['fingerprint']!=fingerprint:
            raise ValueError('Turn ID reused with different content')
        for line in log.read_text().splitlines() if log.exists() else []:
            event=json.loads(line)
            if event.get('type')=='claude_event' and event.get('event',{}).get('type') in ('control_request','control_response'):
                continue
            emit(event)
        if not (folder/'complete.json').exists():
            emit({'type':'broker_error','message':'Previous connection ended before completion. Send a new message to continue the saved conversation.'})
        emit({'type':'broker_done'})
        return
    folder.mkdir(parents=True,mode=0o700)
    save(folder/'request.json',{'fingerprint':fingerprint})
    root=workspace(directory)
    session_id=str(uuid.UUID(hashlib.sha256(('structured-v1:'+scope).encode()).hexdigest()[:32]))
    session_file=directory/'session.json'
    prior=json.loads(session_file.read_text()) if session_file.exists() else None
    resume=bool(prior and prior.get('started'))
    if resume:
        session_id=str(uuid.UUID(prior['id']))
    mcp_file=folder/'mcp.json'
    save(mcp_file,{'mcpServers':{'dsh_artifacts':{'command':'python3','args':[str(Path(__file__).resolve()),'mcp',scope,turn]}}})
    executable=str(Path.home()/'.local/bin/claude')
    if not Path(executable).exists():
        executable='claude'
    args=[executable,'-p','--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages',
          '--permission-prompt-tool','stdio','--permission-mode','default','--strict-mcp-config','--mcp-config',str(mcp_file),
          '--resume' if resume else '--session-id',session_id,
          '--append-system-prompt','This is a DSH remote workspace. Attached files are provided as project-relative paths. Use publish_artifact to return each generated deliverable. The desktop host handles permission requests.']
    if request.get('model'):
        args+=['--model',request['model']]
    if request.get('budget') is not None:
        budget=float(request['budget'])
        if not 0<budget<=5:
            raise ValueError('Invalid test budget')
        args+=['--max-budget-usd',str(budget)]
    events=queue.Queue()
    child=subprocess.Popen(args,cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
    running={'turn':turn,'pid':child.pid,'status':'运行中','sessionId':session_id}
    save(directory/'current-turn.json',running)
    def pump(stream,kind):
        for line in iter(stream.readline,b''):
            events.put((kind,line))
        events.put((kind,None))
    readers=[threading.Thread(target=pump,args=(child.stdout,'claude'),daemon=True),
             threading.Thread(target=pump,args=(child.stderr,'stderr'),daemon=True)]
    for reader in readers:reader.start()
    # Do not hold Python's buffered stdin lock in a daemon thread at shutdown.
    def read_controls():
        buffered=b''
        while True:
            data=os.read(sys.stdin.fileno(),65536)
            if not data:
                events.put(('control',None));return
            buffered+=data
            if len(buffered)>1024*1024:
                events.put(('control',None));return
            while b'\n' in buffered:
                line,buffered=buffered.split(b'\n',1)
                events.put(('control',line))
    threading.Thread(target=read_controls,daemon=True).start()
    pending=set()
    cancelled=False
    terminal=False
    stdout_ended=False
    cancel_at=None
    started=time.monotonic()
    sequence=0
    exports=set()
    detached=False
    log_file=log.open('a',encoding='utf-8')
    def record(event):
        nonlocal sequence,detached
        sequence+=1
        event={**event,'sequence':sequence}
        log_file.write(json.dumps(event,ensure_ascii=True)+'\n');log_file.flush()
        if not detached:
            try:emit(event)
            except BrokenPipeError:detached=True
    def send(value):
        try:child.stdin.write((json.dumps(value)+'\n').encode());child.stdin.flush()
        except (BrokenPipeError,OSError):pass
    def cancel():
        nonlocal cancelled,cancel_at
        if not cancelled:
            cancelled=True;cancel_at=time.monotonic()
            send({'type':'control_request','request_id':uuid.uuid4().hex,'request':{'subtype':'interrupt'}})
    # A dropped SSH connection requests cancellation through the same path.
    # These handlers never target processes belonging to another session.
    signal.signal(signal.SIGHUP,lambda *_:events.put(('control',None)))
    signal.signal(signal.SIGTERM,lambda *_:events.put(('control',None)))
    send({'type':'user','session_id':'','parent_tool_use_id':None,'message':{'role':'user','content':[{'type':'text','text':request['text']}]}})
    try:
        while True:
            if time.monotonic()-started>1800:
                cancel()
            if cancel_at and time.monotonic()-cancel_at>10:
                break
            try:kind,line=events.get(timeout=.2)
            except queue.Empty:kind,line=None,None
            if kind=='control':
                if line is None:
                    if not terminal:cancel()
                else:
                    value=json.loads(line)
                    if value.get('type')=='cancel':cancel()
                    elif value.get('type')=='control_response' and value.get('response',{}).get('request_id') in pending:
                        pending.remove(value['response']['request_id']);send(value)
                        record({'type':'approval_result','request_id':value['response']['request_id'],'behavior':value['response'].get('response',{}).get('behavior')})
                        running['status']='等待审批' if pending else '运行中';save(directory/'current-turn.json',running)
            elif kind=='stderr' and line:
                record({'type':'stderr','text':line.decode('utf-8',errors='replace')[:4096]})
            elif kind=='claude':
                if line is None:
                    stdout_ended=True
                else:
                    event=json.loads(line)
                    if event.get('type')=='control_request':
                        pending.add(event['request_id']);running['status']='等待审批';save(directory/'current-turn.json',running)
                    if event.get('type')=='system' and event.get('subtype')=='init':
                        save(session_file,{'id':event.get('session_id',session_id),'started':True})
                    record({'type':'claude_event','event':event})
                    if event.get('type')=='result':
                        terminal=True
                        break
            if stdout_ended and child.poll() is not None:
                break
        if not terminal:
            record({'type':'broker_error','message':'Turn interrupted.' if cancelled else 'Claude exited before returning a final result.'})
        for file in sorted((folder/'artifacts').glob('*.json')):
            artifact=json.loads(file.read_text())
            if artifact['id'] not in exports:
                record({'type':'artifact_ready','artifact':artifact});exports.add(artifact['id'])
        save(folder/'complete.json',{'finished':terminal,'cancelled':cancelled})
        record({'type':'broker_done','cancelled':cancelled})
    finally:
        running['status']='已停止' if cancelled else ('已完成' if terminal else '已中断')
        save(directory/'current-turn.json',running)
        log_file.close()
        if child.poll() is None:
            child.stdin.close()
            try:child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid,signal.SIGTERM)
                try:child.wait(timeout=3)
                except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
        for reader in readers:reader.join(timeout=2)


if __name__=='__main__':
    os.umask(0o077)
    try:
        action,scope=sys.argv[1:3]
        directory=scope_root(scope)
        if action=='upload':upload(directory)
        elif action=='turn':run_turn(directory,scope)
        elif action=='download':download(directory,*sys.argv[3:5])
        elif action=='mcp':
            if not ID.fullmatch(sys.argv[3]):raise ValueError('Invalid turn')
            mcp(directory,sys.argv[3])
        else:raise ValueError('Unknown operation')
    except Exception as error:
        emit({'type':'broker_error','message':str(error)})
        sys.exit(1)
