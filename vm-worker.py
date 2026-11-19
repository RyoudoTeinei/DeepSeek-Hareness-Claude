"""Unprivileged guest-only workspace worker. Never run this on the Windows host."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import tempfile
import time

MAX_FILE = 1024 * 1024
MAX_OUTPUT = 64 * 1024


class Workspace:
    def __init__(self, root):
        self.root = Path(root).resolve(strict=True)
        if not self.root.is_dir() or str(self.root) == '/':
            raise ValueError('Invalid workspace')

    def path(self, relative, directory=False):
        if not isinstance(relative, str) or len(relative) > 512 or '\\' in relative or '\x00' in relative:
            raise ValueError('Use a workspace-relative POSIX path')
        if relative == '.' and directory:
            return self.root
        parts = relative.split('/')
        if any(part in ('', '.', '..') for part in parts) or ':' in relative:
            raise ValueError('Invalid workspace path')
        path = self.root
        for part in parts:
            path = path / part
            if path.is_symlink():
                raise ValueError('Symbolic links are not accepted')
        if not path.resolve().is_relative_to(self.root):
            raise ValueError('Path outside workspace')
        if directory and not path.is_dir():
            raise ValueError('Working directory does not exist')
        return path

    def read(self, path, encoding='utf-8'):
        target = self.path(path)
        descriptor=os.open(target,os.O_RDONLY|getattr(os,'O_NONBLOCK',0)|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_BINARY',0))
        with os.fdopen(descriptor,'rb') as file:
            if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
                raise ValueError('Only regular files can be read')
            data = file.read(MAX_FILE + 1)
        if len(data) > MAX_FILE:
            raise ValueError('File exceeds 1 MiB; use a bounded command to inspect it')
        if encoding not in ('utf-8', 'base64'):
            raise ValueError('Unsupported encoding')
        return {'path': path, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                'encoding': encoding, 'content': data.decode('utf-8') if encoding == 'utf-8' else base64.b64encode(data).decode()}

    def write(self, path, content, expected_sha256=None):
        if not isinstance(content, str):
            raise ValueError('content must be UTF-8 text')
        data = content.encode('utf-8')
        if len(data) > MAX_FILE:
            raise ValueError('Content exceeds 1 MiB')
        target = self.path(path)
        if target.exists():
            current = self.read(path, 'base64')
            if expected_sha256 != current['sha256']:
                raise ValueError('File exists or changed: read it and provide expected_sha256 before replacing it')
        elif expected_sha256 is not None:
            raise ValueError('Expected file no longer exists')
        target.parent.mkdir(parents=True, exist_ok=True)
        # Recheck parents after mkdir; workspace is the only writable host mount.
        self.path(path)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as file:
                temporary = Path(file.name)
                file.write(data); file.flush(); os.fsync(file.fileno())
            if target.exists():
                if self.read(path, 'base64')['sha256'] != expected_sha256:
                    raise ValueError('File changed before write; read it again')
                os.replace(temporary, target)
            else:
                # SSHFS/SFTP may not implement hard links. Exclusive create keeps
                # an unexpected existing file intact, with a bounded write.
                with target.open('xb') as file:
                    file.write(data); file.flush(); os.fsync(file.fileno())
            return {'path': path, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def list(self, path='.', limit=100):
        if type(limit) is not int or not 1 <= limit <= 500:
            raise ValueError('limit must be 1..500')
        folder = self.path(path, directory=True)
        entries=[]
        with os.scandir(folder) as iterator:
            for item in iterator:
                if len(entries) > limit:
                    break
                entries.append({'name': item.name, 'type': 'symlink' if item.is_symlink() else 'directory' if item.is_dir(follow_symlinks=False) else 'file'})
        return {'path': path, 'entries': entries[:limit], 'truncated': len(entries) > limit}

    def execute(self, argv, cwd='.', timeout=30):
        if not isinstance(argv, list) or not 1 <= len(argv) <= 64 or any(not isinstance(a,str) or '\x00' in a for a in argv) or sum(map(len,argv)) > 16384:
            raise ValueError('argv must be a bounded list of command arguments')
        if type(timeout) is not int or not 1 <= timeout <= 120:
            raise ValueError('timeout must be 1..120 seconds')
        directory = self.path(cwd, directory=True)
        env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/tmp/dsh-vm-home','LANG':'C.UTF-8','TZ':'UTC','TMPDIR':'/tmp'}
        Path(env['HOME']).mkdir(exist_ok=True)
        started=time.monotonic()
        def limits():
            import resource
            resource.setrlimit(resource.RLIMIT_FSIZE,(8*1024*1024,8*1024*1024))
            resource.setrlimit(resource.RLIMIT_NOFILE,(256,256))
            resource.setrlimit(resource.RLIMIT_NPROC,(128,128))
        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            try:
                child=subprocess.Popen(argv,cwd=directory,env=env,stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr,start_new_session=True,preexec_fn=limits)
            except FileNotFoundError:
                raise ValueError('Command is not installed in the local VM; this executor currently provides Python and basic Linux tools') from None
            timed_out=False
            try:
                child.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out=True
            finally:
                # Clean up this request's process group, including normal
                # background children. Persistent services are not supported.
                try:os.killpg(child.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                child.wait()
            stdout.seek(0);stderr.seek(0)
            out=stdout.read(MAX_OUTPUT+1);err=stderr.read(MAX_OUTPUT+1)
        return {'execution':'local_vm','cwd':cwd,'exit_code':child.returncode,'timed_out':timed_out,
                'stdout':out[:MAX_OUTPUT].decode('utf-8',errors='replace'),'stderr':err[:MAX_OUTPUT].decode('utf-8',errors='replace'),
                'truncated':len(out)>MAX_OUTPUT or len(err)>MAX_OUTPUT,'duration_ms':round((time.monotonic()-started)*1000)}

    def dispatch(self, request):
        if not isinstance(request,dict) or set(request) != {'operation','arguments'}:
            raise ValueError('Invalid request')
        operations={'read_file':self.read,'write_file':self.write,'list_files':self.list,'execute':self.execute}
        if request['operation'] not in operations or not isinstance(request['arguments'],dict):
            raise ValueError('Unknown operation')
        return operations[request['operation']](**request['arguments'])


if __name__=='__main__':
    import sys
    def interrupted(*_):raise InterruptedError('VM request interrupted')
    signal.signal(signal.SIGTERM,interrupted)
    if hasattr(signal,'SIGHUP'):signal.signal(signal.SIGHUP,interrupted)
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);args=parser.parse_args()
    try:
        if sys.platform!='linux' or not Path('/etc/dsh-vm-executor').is_file():
            raise ValueError('Guest identity missing; refusing host execution')
        raw=sys.stdin.buffer.read(2*MAX_FILE+1)
        if len(raw)>2*MAX_FILE:raise ValueError('Request too large')
        result={'ok':True,'result':Workspace(args.root).dispatch(json.loads(raw))}
    except (ValueError,TypeError,OSError,UnicodeError) as error:
        # Return only controlled errors; host paths and transport errors belong
        # in the local diagnostic channel, not in Claude's tool response.
        message=str(error) if isinstance(error,(ValueError,TypeError,UnicodeError)) else 'Guest filesystem or command operation failed'
        result={'ok':False,'error':message}
    print(json.dumps(result,ensure_ascii=True),flush=True)
