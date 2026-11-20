import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import textwrap
import time
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('fork_peer', ROOT/'vm-fork.py')
peer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(peer)


class ForkTests(unittest.TestCase):
    def test_rewound_turn_is_not_part_of_the_resumed_branch(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'chat.jsonl'
            rows = [dict(type='user',uuid=uid,parentUuid=parent,message={'content':uid})
                    for uid,parent in [('first',None),('abandoned','first'),('current','first')]]
            path.write_text('\n'.join(map(json.dumps,rows)))
            source = peer.messages(path)
            path.write_text('\n'.join(map(json.dumps,[rows[0],rows[2]])))
            self.assertEqual(source, peer.messages(path))
            self.assertEqual(len(source),2)

    def test_verifies_order_and_multiplicity(self):
        self.assertTrue(peer.inherited([1, 1, 2], [1, 3, 1, 2, 4]))
        self.assertFalse(peer.inherited([1, 1, 2], [1, 2]))
        self.assertFalse(peer.inherited([1, 2], [2, 1]))
        self.assertFalse(peer.inherited([], []))

    def test_unscoped_project_needs_its_exact_live_window(self):
        with patch.object(peer, 'has_terminal', return_value=False):
            with self.assertRaisesRegex(ValueError, '会话 ID'):
                peer.source_session('a'*32, Path('demo'), 'dsh-'+'b'*16+'-claude')
            with self.assertRaisesRegex(ValueError, '未绑定'):
                peer.source_session('a'*32, Path('demo'), 'somebody-elses-window')

    def test_busy_old_cc_is_held(self):
        with patch.object(peer, 'has_terminal', return_value=True), \
             patch.object(peer, 'live_session', return_value=(str(uuid.uuid4()), 'running', '%1', 1)):
            with self.assertRaisesRegex(ValueError, '本轮结束'):
                peer.source_session('a'*32, Path('demo'), 'dsh-'+'b'*16+'-claude')

    @unittest.skipUnless(os.name == 'posix' and shutil.which('tmux'), 'requires POSIX tmux')
    def test_native_tmux_handover_with_lazy_transcript_and_retry(self):
        # Exercise the real start hook, file locks, terminal names, slash command,
        # transcript verification and retry, on a private tmux socket and home.
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            cloud = home/'.local/state/dsh-remote'
            vm = cloud/'vm-native-v2'
            scope = 'b'*32
            dst = vm/'sessions'/scope
            src = cloud/'structured-v1/sessions'/scope
            project = home/'projects'/'demo'
            for folder in [dst,src,project,home/'.local/bin',home/'.claude/sessions',home/'sockets']:
                folder.mkdir(parents=True)
            for file in ['vm-fork.py','native-peer.py','structured-peer.py','chat-peer.py']:
                shutil.copyfile(ROOT/file, vm/file)
            (vm/'vm-mcp.py').write_text(textwrap.dedent('''\
                def invoke(scope, method, params):
                    if method == 'tools/list':
                        return {'tools':[{'name':n} for n in ['Read','Write','Edit','Bash']]}
                    cmd=params['arguments']['command']
                    assert 'mountpoint -q /workspaces/'+scope in cmd
                    return {'content':[{'text':cmd.split()[-1]}]}
                '''))
            fake = home/'.local/bin/claude'
            fake.write_text(textwrap.dedent('''\
                #!/usr/bin/env python3
                import json,os,re,shlex,subprocess,sys
                from pathlib import Path
                args=sys.argv[1:]
                home=Path.home()
                sid=args[args.index('--session-id')+1] if '--session-id' in args else args[args.index('--resume')+1]
                def write(file,obj): file.write_text(json.dumps(obj))
                write(home/'.claude/sessions'/(str(os.getpid())+'.json'),dict(sessionId=sid,cwd=os.getcwd(),status='idle'))
                if '--settings' in args:
                    assert '--strict-mcp-config' in args and '--disallowedTools' in args
                    settings=json.loads(Path(args[args.index('--settings')+1]).read_text())
                    hook=settings['hooks']['SessionStart'][0]['hooks'][0]['command']
                    subprocess.run(shlex.split(hook),input=json.dumps(dict(session_id=sid,cwd=os.getcwd())),text=True,check=True)
                print('❯ ',end='',flush=True)
                for line in sys.stdin:
                    if line.startswith('/export '):
                        log=home/'.claude/projects'/re.sub('[^a-zA-Z0-9]','-',os.getcwd())
                        assert '--fork-session' in args
                        src=log/(args[args.index('--resume')+1]+'.jsonl')
                        (log/(sid+'.jsonl')).write_bytes(src.read_bytes())
                        Path(line.split(maxsplit=1)[1].strip()).write_text('private export')
                        print('❯ ',end='',flush=True)
                '''))
            fake.chmod(0o700)
            # Always pass a private socket to every tmux invocation, including
            # those made by the real native peer. Never select the user's server.
            tool=shutil.which('tmux')
            socket=str(home/'sockets'/'test.sock')
            wrapper=home/'.local/bin/tmux'
            wrapper.write_text('#!/bin/sh\nexec '+shlex.join([tool,'-S',socket])+' "$@"\n')
            wrapper.chmod(0o700)
            env={**os.environ,'HOME':str(home),'PATH':str(wrapper.parent)+os.pathsep+os.environ['PATH'],'PYTHONUTF8':'1'}
            env.pop('TMUX',None)
            original=str(uuid.uuid4())
            old='dsh-native-'+scope
            new='dsh-vm-native-'+scope
            def tmux(*args):
                return subprocess.check_output(['tmux',*args],env=env,text=True,stderr=subprocess.DEVNULL).strip()
            def run():
                output=subprocess.check_output(['python3',str(vm/'vm-fork.py'),scope,old],env=env,text=True,timeout=65)
                return json.loads(output)
            peer.native.agent.save(src/'binding.json',{'project':'demo'})
            peer.native.agent.save(src/'session.json',{'started':True,'id':original})
            peer.native.agent.save(dst/'binding.json',{'project':'demo','terminal':new,'vmTools':True,'vmEngine':'claude-mcp-v2'})
            with patch.dict(os.environ,{'HOME':str(home)}):
                log=peer.transcript(project,original)
            log.parent.mkdir(parents=True)
            log.write_text('\n'.join(json.dumps({'type':role,'message':{'content':text}}) for role,text in [('user','first'),('assistant','reply'),('user','next')])+'\n')
            before=hashlib.sha256(log.read_bytes()).digest()
            tmux('new-session','-d','-s',old,'-c',str(project),'exec '+str(fake)+' --session-id '+original)
            try:
                pane=tmux('display-message','-p','-t',old+':','#{pane_id} #{pane_pid}')
                for _ in range(60):
                    if (home/'.claude/sessions'/(pane.split()[1]+'.json')).exists():break
                    time.sleep(.05)
                proof=run()
                self.assertEqual(proof['source'],original)
                self.assertEqual(proof['messages'],3)
                self.assertNotEqual(proof['id'],original)
                self.assertEqual(run(),proof)
                self.assertEqual(tmux('display-message','-p','-t',old+':','#{pane_id} #{pane_pid}'),pane)
                self.assertEqual(hashlib.sha256(log.read_bytes()).digest(),before)
                self.assertEqual(peer.messages(log.with_name(proof['id']+'.jsonl')),peer.messages(log))
                # Simulate a crashed client before route publication. The source
                # has a later turn now; a retry must include it in a fresh fork.
                with log.open('a') as f:f.write(json.dumps({'type':'user','message':{'content':'later'}})+'\n')
                newer=run()
                self.assertNotEqual(proof['id'],newer['id'])
                self.assertEqual(newer['messages'],4)
                self.assertEqual(tmux('display-message','-p','-t',old+':','#{pane_id} #{pane_pid}'),pane)
            finally:
                for name in [old,new]:
                    subprocess.run([tool,'-S',socket,'kill-session','-t','='+name],env=env,capture_output=True)
