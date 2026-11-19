import importlib.util
from pathlib import Path
import tempfile
import unittest
import sys

spec=importlib.util.spec_from_file_location('vm_worker',Path(__file__).parents[1]/'vm-worker.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class VMWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory()
        self.root=Path(self.temporary.name)
        self.worker=module.Workspace(self.root)
    def tearDown(self):self.temporary.cleanup()
    def test_create_read_and_guarded_replace(self):
        created=self.worker.write('folder/中文.txt','hello')
        self.assertEqual(self.worker.read('folder/中文.txt')['content'],'hello')
        with self.assertRaises(ValueError):self.worker.write('folder/中文.txt','overwrite')
        self.worker.write('folder/中文.txt','changed',created['sha256'])
        with self.assertRaises(ValueError):self.worker.write('folder/中文.txt','stale',created['sha256'])
    def test_paths_and_inputs_are_bounded(self):
        for value in ('/etc/passwd','../private','a/../../private','C:/secret','a\\b','a/./b'):
            with self.assertRaises(ValueError):self.worker.read(value)
        with self.assertRaises(ValueError):self.worker.write('large','x'*(module.MAX_FILE+1))
        with self.assertRaises(ValueError):self.worker.execute(['python3'],timeout=121)
    def test_no_protocol_host_actions(self):
        with self.assertRaises(ValueError):self.worker.dispatch({'operation':'host_shell','arguments':{}})
        with self.assertRaises(ValueError):self.worker.dispatch({'operation':'execute','arguments':{},'host':'Windows'})
    @unittest.skipUnless(sys.platform=='linux','Guest execution requires Linux')
    def test_command_cwd_output_and_timeout(self):
        result=self.worker.execute(['python3','-c','import os;print(os.getcwd());print(os.environ.get("ANTHROPIC_API_KEY","absent"))'])
        self.assertEqual(result['exit_code'],0);self.assertIn('absent',result['stdout'])
        self.assertTrue(self.worker.execute(['sleep','5'],timeout=1)['timed_out'])


if __name__=='__main__':unittest.main()
