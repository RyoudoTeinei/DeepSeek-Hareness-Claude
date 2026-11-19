import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('vm_session',Path(__file__).parents[1]/'vm-session.py')
policy=importlib.util.module_from_spec(spec);spec.loader.exec_module(policy)

class VMSessionTests(unittest.TestCase):
    scope='a'*32
    def test_old_server_session_does_not_block_new_vm_session(self):
        old='dsh-native-'+self.scope
        self.assertEqual(policy.choose_terminal(self.scope,{}, {},lambda name:name==old),'dsh-vm-native-'+self.scope)
    def test_proven_running_vm_keeps_its_original_name_and_history(self):
        caps={'vmTools':True,'vmEngine':'claude-mcp-v2'}
        binding={'vmEngine':'claude-mcp-v2'}
        self.assertEqual(policy.choose_terminal(self.scope,caps,binding,lambda _:True),'dsh-native-'+self.scope)
        binding['terminal']='dsh-vm-native-'+self.scope
        self.assertEqual(policy.choose_terminal(self.scope,caps,binding,lambda _:True),binding['terminal'])
    def test_unknown_session_in_new_namespace_is_never_taken_over(self):
        with self.assertRaisesRegex(ValueError,'身份记录'):
            policy.choose_terminal(self.scope,{}, {},lambda name:name.startswith('dsh-vm-native-'))
