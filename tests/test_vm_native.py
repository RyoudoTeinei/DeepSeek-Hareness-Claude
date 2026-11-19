import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('vm_native',Path(__file__).parents[1]/'vm-native.py')
native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)


class VMNativeTests(unittest.TestCase):
    def test_each_executor_mounts_only_its_own_project_and_state(self):
        root='/workspaces/'+'a'*32
        state=Path('/home/dshvm/.local/state/dsh-cc-native')/('a'*32)
        binary=Path('/home/dshvm/.local/share/dsh-cc-native/2.1.322/claude')
        with patch.object(Path,'is_file',return_value=True):args=native.sandbox_command(root,state,binary)
        for flag in ('--unshare-user','--unshare-pid','--unshare-net','--unshare-ipc','--disable-userns','--die-with-parent'):self.assertIn(flag,args)
        mounts=[args[i+1:i+3] for i,x in enumerate(args) if x=='--bind']
        self.assertEqual(mounts,[[str(state),str(state)],[root,root]])
        self.assertNotIn('--share-net',args)

    def test_environment_does_not_inherit_authentication_or_host_shell_configuration(self):
        with tempfile.TemporaryDirectory() as folder,patch.dict(os.environ,{
            'ANTHROPIC_API_KEY':'must-not-inherit','CLAUDE_CODE_OAUTH_TOKEN':'must-not-inherit',
            'ANTHROPIC_BASE_URL':'must-not-inherit','HTTPS_PROXY':'must-not-inherit','BASH_ENV':'must-not-inherit'}):
            env=native.environment(Path(folder))
            self.assertNotIn('must-not-inherit',str(env))
            self.assertNotIn('ANTHROPIC_API_KEY',env)
            self.assertNotEqual(env['HOME'],os.environ.get('HOME'))
            self.assertEqual(env['DISABLE_AUTOUPDATER'],'1')
            self.assertEqual(env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'],'1')
            self.assertEqual(env['TZ'],'UTC')

    @unittest.skipIf(os.name=='nt','Guest launcher only')
    def test_guest_marker_is_required(self):
        with patch.object(Path,'read_text',return_value='wrong-instance'):
            with self.assertRaisesRegex(ValueError,'identity'):native.run('/workspaces/'+'a'*32,'test-instance')
