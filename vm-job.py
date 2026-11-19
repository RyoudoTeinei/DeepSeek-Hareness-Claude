"""Small process ownership adapter, invoked only by the VM's native Bash tool."""
import base64
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time


def start_time(pid):
    try:return Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]
    except (OSError,IndexError):return None


def save(record,state):
    temporary=record.with_suffix('.tmp-'+str(os.getpid()))
    temporary.write_text(json.dumps(state));os.replace(temporary,record)


def main(action,identifier,command=None):
    if not re.fullmatch('[a-f0-9]{32}',identifier):raise ValueError('Invalid job ID')
    folder=Path(__file__).resolve().parent/'jobs';folder.mkdir(mode=0o700,exist_ok=True)
    record=folder/(identifier+'.json')
    if action=='run':
        child=subprocess.Popen(['bash','-c',base64.b64decode(command).decode()],start_new_session=True)
        state={'pid':child.pid,'start':start_time(child.pid)}
        save(record,state)
        try:return child.wait()
        finally:
            state['exitCode']=child.poll();save(record,state)
    if action=='stop':
        # Native Bash acknowledges backgrounding before the child necessarily starts.
        deadline=time.monotonic()+5
        while not record.exists() and time.monotonic()<deadline:time.sleep(.05)
        state=json.loads(record.read_text());pid=state['pid']
        if state.get('start') is None or start_time(pid)!=state['start']:
            print(json.dumps({'stopped':False,'alreadyExited':True}));return 0
        if os.getsid(pid)!=pid:raise ValueError('Job session identity mismatch')
        os.killpg(pid,signal.SIGTERM)
        time.sleep(.2)
        if start_time(pid)==state['start']:
            try:os.killpg(pid,signal.SIGKILL)
            except ProcessLookupError:pass
        print(json.dumps({'stopped':True}));return 0
    raise ValueError('Invalid job operation')


if __name__=='__main__':
    os.umask(0o077)
    try:sys.exit(main(*sys.argv[1:]))
    except (ValueError,OSError,KeyError) as error:
        print(str(error),file=sys.stderr);sys.exit(1)
