"""Bridge DSH to a real interactive Claude TUI in a session-owned tmux pane.

No Windows Claude, screen scraping of answers, global settings or shared tmux edits.
The terminal owns input/permissions; replies come from its actual transcript.
"""
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import threading
import time
import uuid


def sibling(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


agent = sibling('structured-peer')
TurnReader = sibling('chat-peer').TurnReader

CLOUD_VM_TOOLS = ['Agent','Skill','AskUserQuestion','EnterPlanMode','ExitPlanMode',
                  'TaskCreate','TaskGet','TaskList','TaskUpdate','TaskOutput','TaskStop',
                  'ToolSearch','WebSearch','WebFetch']


def tmux(*args, data=None):
    return subprocess.check_output(['tmux', *args], input=data).decode().strip()


def read_json(file, fallback=None):
    try:
        return json.loads(file.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


@contextlib.contextmanager
def session_lock(directory):
    import fcntl
    with (directory / 'session.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('本会话仍有任务运行，请等它结束后接入原生终端。')
        yield


def session_name(scope, directory=None):
    if not agent.ID.fullmatch(scope):
        raise ValueError('Invalid scope')
    directory=directory or agent.scope_root(scope)
    binding=read_json(directory/'binding.json',{})
    if binding.get('vmEngine')=='claude-mcp-v2':
        caps=read_json(directory/'native-capabilities.json',{})
        name=binding.get('terminal') or caps.get('terminal') or ('dsh-native-'+scope if caps.get('vmEngine')=='claude-mcp-v2' else 'dsh-vm-native-'+scope)
        if name not in ('dsh-native-'+scope,'dsh-vm-native-'+scope):raise ValueError('VM terminal binding mismatch')
        return name
    return 'dsh-native-' + scope


def existing_session(scope):
    name = session_name(scope)
    return subprocess.run(['tmux', 'has-session', '-t', '=' + name], capture_output=True).returncode == 0


def verify_running_mode(directory):
    wanted=bool(read_json(directory/'binding.json',{}).get('vmTools'))
    active=bool(read_json(directory/'native-capabilities.json',{}).get('vmTools'))
    if wanted!=active:
        raise ValueError('此终端的执行模式已固定。请在新聊天中启用本地虚拟机，现有 CC 会话不会被重启。')
    expected=read_json(directory/'binding.json',{}).get('vmEngine')
    actual=read_json(directory/'native-capabilities.json',{}).get('vmEngine')
    if wanted and expected!=actual:
        raise ValueError('虚拟机执行器版本已变化，请新建聊天；已有会话保持原执行方式。')


def ensure(directory, scope, model='', fork=None):
    """Caller holds session.lock. Existing panes are never restarted."""
    name = session_name(scope,directory)
    if existing_session(scope):
        verify_running_mode(directory)
        return name
    root = agent.workspace(directory)
    previous = read_json(directory / 'session.json', {})
    namespace='vm-native-v2:' if name.startswith('dsh-vm-native-') else 'structured-v1:'
    sid = str(uuid.UUID(previous.get('id') or hashlib.sha256((namespace + scope).encode()).hexdigest()[:32]))
    native = Path(__file__).resolve()
    settings = directory / 'native-settings.json'
    command = shlex.join(['python3', str(native), 'session-start', scope])
    agent.save(settings, {'hooks': {'SessionStart': [{'hooks': [{'type': 'command', 'command': command}]}]}})
    mcp = directory / 'native-mcp.json'
    use_vm=bool(read_json(directory/'binding.json',{}).get('vmTools'))
    vm_engine=read_json(directory/'binding.json',{}).get('vmEngine')
    servers={'dsh_artifacts': {'command': 'python3', 'args': [str(native), 'mcp', scope]}}
    prompt='This is a DSH remote workspace. Attached files are project-relative paths. Use publish_artifact to return each generated deliverable. Permissions are handled in this interactive terminal.'
    if use_vm:
        vm_root=Path.home()/('.local/state/dsh-remote/vm-native-v2' if vm_engine=='claude-mcp-v2' else '.local/state/dsh-remote/vm-bridge-v1')
        if not (vm_root/'sessions'/scope/'binding.json').is_file():
            raise ValueError('本地虚拟机工具桥尚未连接')
        servers={'dsh_local_vm':{'command':'python3' if vm_engine=='claude-mcp-v2' else str(vm_root/'runtime/bin/python'),'args':[str(vm_root/'vm-mcp.py'),scope]}}
        prompt='This DSH session uses a LOCAL execution VM. All user project files and attachments are in that VM workspace. Use only vm_read_file, vm_write_file, vm_list_files and vm_execute for project work. Paths are project-relative. Writes directly update the authorized host project. Never substitute cloud execution when the VM is offline. Permissions are handled in this interactive terminal.'
        if vm_engine=='claude-mcp-v2':
            prompt='This DSH session uses an unauthenticated Claude MCP executor inside a LOCAL LINUX VM. All user project files and attachments are mounted at /workspaces/'+scope+'. Use mcp__dsh_local_vm__Read/Write/Edit/Bash and its other native tools for ALL project file and command operations, including running skill scripts. File arguments should use that absolute VM path. Cloud Agent, Skill, planning, task and web tools remain available. For project delegation prefer the vm-project subagent, which has the VM MCP tools; never substitute cloud execution when the VM is offline. Skills load on the server: their bundled script paths are NOT automatically present in the VM. Put needed scripts/dependencies in the VM before running them. VM Bash background jobs belong to the VM: read their backgroundOutputPath with VM Read and stop with VM TaskStop, not cloud task tools. The VM has no public network. Permissions are handled by the cloud Claude session.'
    agent.save(mcp, {'mcpServers': servers})
    executable = Path.home() / '.local/bin/claude'
    history = ['--resume' if previous.get('started') else '--session-id', sid]
    if fork:
        if not use_vm or name != 'dsh-vm-native-'+scope:
            raise ValueError('历史分叉必须使用此聊天独立的虚拟机终端。')
        history = ['--resume',str(uuid.UUID(fork['source'])),'--fork-session','--session-id',str(uuid.UUID(fork['id']))]
    args = [str(executable) if executable.exists() else 'claude', *history,
            '--settings', str(settings), '--strict-mcp-config', '--mcp-config', str(mcp),
            '--append-system-prompt', prompt]
    if use_vm:
        args+=['--tools',','.join(CLOUD_VM_TOOLS) if vm_engine=='claude-mcp-v2' else '']
        if vm_engine=='claude-mcp-v2':
            args+=['--disallowedTools','Bash,Read,Write,Edit,MultiEdit,Glob,Grep,NotebookEdit,EnterWorktree,ExitWorktree']
            definition={'vm-project':{'description':'Work on the shared local project through the VM tools; use this for file investigation, edits and tests.',
              'prompt':prompt,'tools':['mcp__dsh_local_vm__*','Skill'],'model':'inherit'}}
            args+=['--agents',json.dumps(definition)]
    if model:
        if model not in ('sonnet', 'opus', 'haiku'):
            raise ValueError('Invalid model')
        args += ['--model', model]
    start='exec '+shlex.join((['env','DISABLE_AUTOUPDATER=1'] if use_vm else [])+args)
    capabilities={'vmTools':use_vm,'vmEngine':vm_engine,'terminal':name}
    if fork:
        # A lost SSH response after tmux creates the pane must be recoverable.
        agent.save(directory/'native-capabilities.json',capabilities)
    tmux('new-session', '-d', '-s', name, '-x', '120', '-y', '40', '-c', str(root), start)
    tmux('set-option', '-t', name, 'mouse', 'on')
    tmux('set-option', '-t', name + ':', 'history-limit', '50000')
    if not fork:
        agent.save(directory/'native-capabilities.json',capabilities)
    return name


def remember_session(directory):
    event = json.load(sys.stdin)
    if Path(event['cwd']).resolve() != agent.workspace(directory).resolve():
        raise ValueError('Session project changed')
    sid = str(uuid.UUID(event['session_id']))
    agent.save(directory / 'session.json', {'id': sid, 'started': True})


def screen(pane):
    raw = tmux('capture-pane', '-e', '-p', '-t', pane)
    clean = re.sub(r'(❯\s*)\x1b\[2m[^\n]*', r'\1', raw)
    return re.sub(r'\x1b\[[0-9;]*m', '', clean)


def editor_empty(value):
    text = next((line.strip()[1:].strip() for line in reversed(value.splitlines()) if line.strip().startswith('❯')), None)
    return text is not None and (not text or text.startswith('Try "'))


def read_line():
    # Avoid buffering a cancellation after the first line outside the control reader.
    value = bytearray()
    while len(value) < 4 * 1024 * 1024:
        byte = os.read(sys.stdin.fileno(), 1)
        if not byte:
            raise ValueError('Connection closed before request')
        value.extend(byte)
        if byte == b'\n':
            return bytes(value)
    raise ValueError('Request too large')


def normalize(item):
    """A native JSONL record is one block; several records share a message ID."""
    message = item.get('message') or {}
    if not isinstance(message.get('content'), list):
        return None
    content = [block for block in message['content'] if block.get('type') in ('text', 'tool_use', 'tool_result')]
    if not content:
        return None
    return {'type': item['type'], 'message': {**message, 'id': item.get('uuid') or message.get('id'), 'content': content}}


def turn(directory, scope):
    first = read_line()
    request = json.loads(first)
    prompt = request.get('text', '')
    turn_id = request.get('turn', '')
    if not agent.ID.fullmatch(turn_id) or not isinstance(prompt, str) or not prompt.strip():
        raise ValueError('Invalid turn')
    if any(ord(char) < 32 and char not in '\n\t' for char in prompt):
        raise ValueError('Invalid control characters')
    if prompt.lstrip().startswith(('/', '!')):
        raise ValueError('斜杠命令和 Shell 命令请在右侧原生 Claude 终端执行。')
    with session_lock(directory):
        folder = directory / 'turns' / turn_id
        fingerprint = hashlib.sha256(first).hexdigest()
        log = folder / 'events.jsonl'
        if folder.exists():
            if read_json(folder / 'request.json', {}).get('fingerprint') != fingerprint:
                raise ValueError('Turn ID reused with different content')
            agent.emit({'type':'native_status','message':'正在恢复本轮已保存结果，不会重新执行工具。'})
            for line in log.read_text().splitlines() if log.exists() else []:
                frame = json.loads(line)
                if frame.get('type')=='native_status':continue
                if frame.get('type') == 'claude_event' and frame['event'].get('type') in ('control_request', 'control_response'):
                    continue
                agent.emit(frame)
            if not read_json(folder / 'complete.json', {}).get('finished'):
                raise ValueError('上次连接未完成，请先在右侧查看，不要重复发送。')
            agent.emit({'type': 'broker_done'})
            return
        name = ensure(directory, scope, request.get('model', ''))
        pane, pid = tmux('display-message', '-p', '-t', name + ':', '#{pane_id} #{pane_pid}').split()
        statefile = Path.home() / '.claude/sessions' / (pid + '.json')
        deadline = time.monotonic() + 30
        while True:
            state = read_json(statefile, {})
            if state.get('status') == 'idle' and editor_empty(screen(pane)):
                break
            if time.monotonic() >= deadline:
                raise ValueError('请在右侧接入 Claude，处理确认提示或草稿，待空闲后再发送。')
            time.sleep(.2)
        root = agent.workspace(directory)
        if Path(state['cwd']).resolve() != root.resolve():
            raise ValueError('右侧所在项目已切换，请重新接入。')
        sid = str(uuid.UUID(state['sessionId']))
        transcript = Path.home() / '.claude/projects' / re.sub(r'[^a-zA-Z0-9]', '-', str(root)) / (sid + '.jsonl')
        if not transcript.exists():
            transcript = next((Path.home() / '.claude/projects').glob('*/' + sid + '.jsonl'), transcript)
        offset = transcript.stat().st_size if transcript.exists() else 0
        folder.mkdir(parents=True, mode=0o700)
        agent.save(folder / 'request.json', {'fingerprint': fingerprint})
        running = {'turn': turn_id, 'pid': int(pid), 'status': '运行中', 'sessionId': sid, 'terminal': name}
        agent.save(directory / 'current-turn.json', running)
        agent.save(directory / 'native-active-turn.json', {'turn': turn_id})
        agent.save(directory / 'session.json', {'id': sid, 'started': True})
        cancelled = threading.Event()
        def controls():
            data = b''
            while True:
                chunk = os.read(sys.stdin.fileno(), 65536)
                if not chunk:
                    cancelled.set(); return
                data += chunk
                if len(data) > 1024 * 1024:
                    cancelled.set(); return
                while b'\n' in data:
                    line, data = data.split(b'\n', 1)
                    if json.loads(line).get('type') == 'cancel':
                        cancelled.set()
        threading.Thread(target=controls, daemon=True).start()
        signal.signal(signal.SIGHUP, lambda *_: cancelled.set())
        signal.signal(signal.SIGTERM, lambda *_: cancelled.set())
        reader = TurnReader(prompt)
        started = last_data = time.monotonic()
        seen = set()
        sequence = 0
        finished = False
        with log.open('a', encoding='utf-8') as events:
            def record(frame):
                nonlocal sequence
                sequence += 1
                frame = {**frame, 'sequence': sequence}
                events.write(json.dumps(frame) + '\n'); events.flush()
                agent.emit(frame)
            try:
                if cancelled.is_set():
                    raise ValueError('任务已取消，消息未发送。')
                buffer = 'dsh-native-' + turn_id
                tmux('load-buffer', '-b', buffer, '-', data=prompt.encode())
                tmux('paste-buffer', '-d', '-p', '-b', buffer, '-t', pane)
                time.sleep(.3)
                tmux('send-keys', '-t', pane, 'Enter')
                record({'type': 'native_status', 'message': '已发送到右侧原生 Claude；需要确认时请在终端操作。'})
                while time.monotonic() - started < 1800:
                    current = read_json(statefile, {})
                    if current.get('sessionId') != sid or not Path('/proc', pid).exists():
                        raise ValueError('右侧会话已切换或退出，请在终端查看。')
                    if cancelled.is_set():
                        if reader.accepted and current.get('status') != 'idle':
                            tmux('send-keys', '-t', pane, 'Escape')
                        raise ValueError('任务已停止；原生 Claude 终端仍然保留。')
                    if transcript.exists():
                        with transcript.open('rb') as source:
                            source.seek(offset)
                            for raw in source:
                                if not raw.endswith(b'\n'):
                                    break
                                offset += len(raw)
                                item = json.loads(raw)
                                if item.get('isSidechain'):
                                    continue
                                last_data = time.monotonic()
                                reader.consume(item)
                                uid = item.get('uuid')
                                if reader.accepted and item.get('type') in ('assistant', 'user') and uid not in seen:
                                    event = normalize(item)
                                    if event:
                                        record({'type': 'claude_event', 'event': event})
                                    if uid: seen.add(uid)
                                if reader.finished:
                                    break
                    if reader.finished or (reader.final_text_seen and time.monotonic() - last_data >= 1 and current.get('status') == 'idle'):
                        finished = True
                        record({'type': 'claude_event', 'event': {'type': 'result', 'is_error': False}})
                        for file in sorted((folder / 'artifacts').glob('*.json')):
                            record({'type': 'artifact_ready', 'artifact': read_json(file)})
                        break
                    if not reader.accepted and time.monotonic() - started > 25:
                        raise ValueError('未能确认消息已被接收，请看右侧终端，避免重复发送。')
                    time.sleep(.18)
                if not finished:
                    raise ValueError('等待回复超时，请查看右侧原生终端。')
                record({'type': 'broker_done'})
            finally:
                agent.save(folder / 'complete.json', {'finished': finished, 'cancelled': cancelled.is_set()})
                running['status'] = '已完成' if finished else '已中断'
                agent.save(directory / 'current-turn.json', running)
                (directory / 'native-active-turn.json').unlink(missing_ok=True)


def artifact_turn(directory):
    active = read_json(directory / 'native-active-turn.json', {})
    value = active.get('turn') or uuid.uuid4().hex
    if not agent.ID.fullmatch(value):
        raise ValueError('Invalid artifact turn')
    return value


if __name__ == '__main__':
    os.umask(0o077)
    try:
        action, scope = sys.argv[1:3]
        directory = agent.scope_root(scope)
        if action == 'ensure':
            # Reopening a terminal during a turn must remain possible for approvals.
            name = session_name(scope)
            if existing_session(scope):
                verify_running_mode(directory)
            else:
                with session_lock(directory):
                    name = ensure(directory, scope, sys.argv[3] if len(sys.argv) > 3 else '')
            agent.emit({'type': 'native_ready', 'session': name})
        elif action == 'turn':
            turn(directory, scope)
        elif action == 'session-start':
            remember_session(directory)
        elif action == 'mcp':
            agent.mcp(directory, lambda: artifact_turn(directory))
        else:
            raise ValueError('Invalid action')
    except Exception as error:
        agent.emit({'type': 'broker_error', 'message': str(error)})
        sys.exit(1)
