"""Run the pinned, unauthenticated Claude MCP executor inside our Linux VM only."""
import argparse
import base64
import ctypes
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import threading
import time

VERSION = '2.1.322'
JOB_SOURCE = '__DSH_JOB_SOURCE__'


def sandbox_command(root,state,binary):
    bwrap=Path.home()/'.local/share/dsh-sandbox/bubblewrap-0.12.0/usr/bin/bwrap'
    if not bwrap.is_file():raise ValueError('VM multi-session sandbox is not installed')
    args=[str(bwrap),'--unshare-user','--unshare-pid','--unshare-net','--unshare-ipc','--unshare-uts',
          '--disable-userns','--new-session','--die-with-parent',
          '--ro-bind','/usr','/usr','--ro-bind','/etc','/etc']
    for name in ('bin','sbin','lib','lib64'):
        source=Path('/')/name
        if source.is_symlink():args+=['--symlink',os.readlink(source),str(source)]
        elif source.exists():args+=['--ro-bind',str(source),str(source)]
    args+=['--proc','/proc','--dev','/dev','--tmpfs','/tmp','--tmpfs','/run',
           '--bind',str(state),str(state),'--ro-bind',str(binary),str(binary),
           '--bind',root,root,'--chdir',root,'--',str(binary),'--setting-sources','','mcp','serve']
    return args


def environment(state):
    paths = {name: state / name for name in ('home', 'config', 'anthropic', 'tmp')}
    for folder in paths.values():
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    return {
        'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(paths['home']),
        'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'TZ': 'UTC',
        'TMPDIR': str(paths['tmp']), 'CLAUDE_CODE_TMPDIR': str(paths['tmp']),
        'CLAUDE_CONFIG_DIR': str(paths['config']), 'ANTHROPIC_CONFIG_DIR': str(paths['anthropic']),
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'DISABLE_TELEMETRY': '1',
        'DISABLE_ERROR_REPORTING': '1', 'DISABLE_AUTOUPDATER': '1',
        'CLAUDE_CODE_SKIP_PROMPT_HISTORY': '1',
    }


def descendants():
    """Only descendants of this dedicated launcher, including adopted orphans."""
    parents = {}
    for folder in Path('/proc').iterdir():
        if not folder.name.isdigit():
            continue
        try:
            tail = (folder / 'stat').read_text().rsplit(')', 1)[1].split()
            parents[int(folder.name)] = int(tail[1])
        except (OSError, ValueError, IndexError):
            pass
    owned = {os.getpid()}
    while True:
        extra = {pid for pid, parent in parents.items() if parent in owned} - owned
        if not extra:
            return owned - {os.getpid()}
        owned.update(extra)


def run(root, instance):
    if sys.platform != 'linux' or Path('/etc/dsh-vm-executor').read_text().strip() != instance:
        raise ValueError('Dedicated VM identity mismatch')
    if os.getuid() == 0 or not re.fullmatch('/workspaces/[a-f0-9]{32}', root):
        raise ValueError('Invalid unprivileged workspace')
    if subprocess.run(['mountpoint', '-q', root]).returncode:
        raise ValueError('Authorized project is not mounted')
    # Adopt detached children so bridge shutdown also stops this executor's jobs.
    if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
        raise OSError('Cannot establish executor process ownership')
    state = Path.home() / '.local/state/dsh-cc-native' / Path(root).name
    binary = Path.home() / '.local/share/dsh-cc-native' / VERSION / 'claude'
    env = environment(state)
    (state/'job.py').write_bytes(base64.b64decode(JOB_SOURCE))
    credentials=Path(env['CLAUDE_CONFIG_DIR'])/'.credentials.json'
    if credentials.exists() and credentials.stat().st_size:
        raise ValueError('VM executor must remain unauthenticated; a credential file was found')
    for config in (Path(env['CLAUDE_CONFIG_DIR'])/'.claude.json',Path(env['HOME'])/'.claude.json'):
        if config.exists():
            value=json.loads(config.read_text())
            if value.get('oauthAccount') or value.get('primaryApiKey'):
                raise ValueError('VM executor contains account metadata; use a clean executor profile')
    child = subprocess.Popen(sandbox_command(root,state,binary),
                             cwd=root, env=env, stdin=subprocess.PIPE, start_new_session=True)
    disconnected=threading.Event()
    def forward():
        try:
            for line in sys.stdin.buffer:
                child.stdin.write(line);child.stdin.flush()
        except (OSError,ValueError):
            pass
        finally:
            disconnected.set()
            try:child.stdin.close()
            except OSError:pass
    threading.Thread(target=forward,daemon=True).start()
    def stop(*_):
        raise InterruptedError('Executor disconnected')
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, stop)
    try:
        while child.poll() is None:
            if disconnected.wait(.1):break
        return child.returncode or 0
    finally:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            for pid in descendants():
                try: os.kill(pid, sig)
                except ProcessLookupError: pass
            if sig == signal.SIGTERM:
                time.sleep(.3)
        child.wait()
        deadline=time.monotonic()+2
        while time.monotonic()<deadline:
            try:
                pid,_=os.waitpid(-1,os.WNOHANG)
                if pid==0:time.sleep(.05)
            except ChildProcessError:break


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--instance', required=True)
    args = parser.parse_args()
    try:
        sys.exit(run(args.root, args.instance))
    except (OSError, ValueError, InterruptedError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
