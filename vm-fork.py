"""Fork exactly one server conversation into its own native VM terminal."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import time
import uuid


def sibling(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


native = sibling('native-peer')


def has_terminal(name):
    return subprocess.run(['tmux', 'has-session', '-t', '=' + name], capture_output=True).returncode == 0


def live_session(name, project):
    actual, pane, pid, attached = native.tmux(
        'display-message', '-p', '-t', name + ':', '#{session_name} #{pane_id} #{pane_pid} #{session_attached}'
    ).split()
    state = native.read_json(Path.home()/'.claude/sessions'/(pid+'.json'), {})
    if actual != name or Path(state.get('cwd', '/')).resolve() != project or not state.get('sessionId'):
        raise ValueError('无法确认 Claude 终端与当前项目的绑定。')
    return str(uuid.UUID(state['sessionId'])), state.get('status'), pane, int(attached)


def source_session(scope, project, name):
    sid = None
    if name == 'dsh-native-' + scope:
        old = Path.home()/'.local/state/dsh-remote/structured-v1/sessions'/scope
        if native.read_json(old/'binding.json', {}).get('project') != project.name:
            raise ValueError('找不到这个聊天原有的服务器项目绑定。')
        record = native.read_json(old/'session.json', {})
        if record.get('started'):
            sid = str(uuid.UUID(record['id']))
    elif name == 'dsh-' + scope + '-claude':
        sid = str(uuid.UUID(scope))
    elif not re.fullmatch(r'dsh-[a-f0-9]{16}-claude', name):
        raise ValueError('旧终端未绑定到此聊天。')
    if has_terminal(name):
        live, status, _, _ = live_session(name, project)
        if status != 'idle':
            raise ValueError('旧 Claude 正在执行任务，请等本轮结束后再切换。')
        if sid and sid != live:
            raise ValueError('旧窗口已切换到其他 Claude 会话，请先回到原会话。')
        return live
    if not sid:
        raise ValueError('缺少原 Claude 会话 ID，请先打开原服务器终端再试。')
    return sid


def transcript(project, sid):
    folder = re.sub(r'[^a-zA-Z0-9]', '-', str(project))
    return Path.home()/'.claude/projects'/folder/(str(uuid.UUID(sid))+'.jsonl')


def messages(file):
    """Fingerprint the resumable branch; a rewind can leave abandoned turns in JSONL."""
    if not file.is_file():
        return []
    result, parents = [], {}
    leaf, linked = None, True
    with file.open(encoding='utf-8') as source:
        for line in source:
            row = json.loads(line)
            if row.get('isSidechain'):
                continue
            uid, role, digest = row.get('uuid'), row.get('type'), None
            if role in ('user','assistant') and row.get('message'):
                payload = [role, row['message'].get('content')]
                digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).digest()
                result.append(digest)
                leaf = uid
                linked = linked and bool(uid) and 'parentUuid' in row
            if uid and 'parentUuid' in row:
                parents[uid] = (row['parentUuid'], digest)
    if not linked:
        return result
    branch, seen = [], set()
    while leaf:
        if leaf in seen or leaf not in parents:
            return result  # Older/incomplete linkage: require the full ordered sequence.
        seen.add(leaf)
        leaf, digest = parents[leaf]
        if digest:
            branch.append(digest)
    return branch[::-1]


def inherited(original, copied):
    remaining = iter(copied)
    return bool(original) and all(any(candidate == message for candidate in remaining) for message in original)


def check_mount(scope):
    mcp = sibling('vm-mcp')
    tools = mcp.invoke(scope, 'tools/list', {}).get('tools', [])
    if not {'Read','Edit','Write','Bash'} <= {tool['name'] for tool in tools}:
        raise ValueError('虚拟机的项目工具尚未就绪。')
    root = shlex.quote('/workspaces/' + scope)
    marker = uuid.uuid4().hex
    result = mcp.invoke(scope, 'tools/call', {'name':'Bash','arguments':{
        'command':f'mountpoint -q {root} && test -r {root} && test -w {root} && printf %s {marker}',
        'description':'验证本聊天的虚拟机项目挂载'}})
    if result.get('isError') or not any(marker in block.get('text','') for block in result.get('content', [])):
        raise ValueError('无法确认本机项目的可读写挂载。')


def verify_fork(dst, name, project, fork, original):
    deadline = time.monotonic() + 45
    exported = False
    log = transcript(project, fork)
    revision = None
    # Some CC versions write the fork transcript lazily. /export is a local
    # slash command; send it only to our identified, idle, unattached fork.
    with tempfile.TemporaryDirectory(prefix='dsh-fork-') as private:
        while time.monotonic() < deadline:
            if not has_terminal(name):
                raise ValueError('分叉终端未能启动，请检查云端 Claude 是否支持 --fork-session。')
            if native.read_json(dst/'session.json', {}).get('id') == fork:
                try:
                    sid, status, pane, clients = live_session(name, project)
                except ValueError:
                    time.sleep(.25)
                    continue
                if sid != fork:
                    raise ValueError('分叉终端的 Claude ID 不匹配。')
                if status == 'idle':
                    try:
                        stat = log.stat()
                        observed = (stat.st_mtime_ns, stat.st_size)
                        if observed != revision:
                            if inherited(original, messages(log)):
                                return
                            revision = observed
                    except (FileNotFoundError, json.JSONDecodeError):
                        pass  # The CLI can still be publishing the JSONL.
                    if not exported and not clients and native.editor_empty(native.screen(pane)):
                        native.tmux('send-keys','-t',pane,'-l','/export '+str(Path(private)/'history.txt'))
                        time.sleep(.2)
                        native.tmux('send-keys','-t',pane,'Enter')
                        exported = True
            time.sleep(.25)
    raise ValueError('尚未验证分叉历史，聊天仍使用服务器。请稍后重试。')


def migrate(scope, source_name, model=''):
    dst = native.agent.scope_root(scope)
    target = 'dsh-vm-native-' + scope
    if native.session_name(scope, dst) != target or source_name == target:
        raise ValueError('已有虚拟机终端的归属不符。')
    project = native.agent.workspace(dst).resolve()
    with native.session_lock(dst):
        if has_terminal(target):
            native.verify_running_mode(dst)
        sid = source_session(scope, project, source_name)
        original = messages(transcript(project, sid))
        if not original:
            raise ValueError('没有找到可恢复的原聊天历史。')
        check_mount(scope)
        checkpoint = dst/'fork.json'
        prior = native.read_json(checkpoint, {})
        record = native.read_json(dst/'session.json', {})
        active = has_terminal(target)
        if not prior and (active or record):
            raise ValueError('该工作区已有独立的虚拟机会话，无法确认其历史来源。')
        signature = hashlib.sha256(b''.join(original)).hexdigest()
        if prior and (prior.get('id') == prior.get('source') or not prior.get('source')):
            raise ValueError('分叉记录无效，保留已有终端。')
        if prior and record and record.get('id') not in (prior.get('id'), prior.get('supersedes')):
            raise ValueError('已有其他虚拟机会话，迁移已停止。')
        stale = prior and (prior.get('source') != sid or prior.get('signature') != signature)
        if prior and not active:
            log = transcript(project, prior['id'])
            stale = stale or (log.exists() and not inherited(original, messages(log)))
        if stale:
            # The server route was never published and the old chat advanced.
            # Discard only a demonstrably unused staging process; retain its log.
            if active:
                current, status, _, clients = live_session(target, project)
                if clients or status != 'idle' or current != prior['id'] or current == sid:
                    raise ValueError('上次分叉仍在使用，无法替换。请先结束该分叉的操作。')
                native.tmux('kill-session','-t','='+target)
                active = False
            prior = {}
        if not prior:
            prior = {'source':sid, 'id':str(uuid.uuid4()), 'signature':signature, 'supersedes':record.get('id')}
            native.agent.save(checkpoint, prior)
        fork = str(uuid.UUID(prior['id']))
        if fork == sid:
            raise ValueError('新旧会话 ID 冲突。')
        if not active:
            if inherited(original, messages(transcript(project, fork))):
                native.agent.save(dst/'session.json', {'id':fork, 'started':True})
                native.ensure(dst, scope, model)
            else:
                native.ensure(dst, scope, model, prior)
        verify_fork(dst, target, project, fork, original)
        return {'source':sid, 'id':fork, 'messages':len(original)}


if __name__ == '__main__':
    try:
        print(json.dumps(migrate(*sys.argv[1:])))
    except Exception as error:
        sys.exit(str(error))
