import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest


@unittest.skipUnless(shutil.which('git'), 'Git is required')
class PushSafetyTests(unittest.TestCase):
    def git(self, cwd, *args, ok=True):
        result = subprocess.run([
            'git', '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=' + str(self.empty_hooks),
            '-c', 'user.name=DSH regression test', '-c', 'user.email=test@example.invalid',
            '-C', str(cwd), *args,
        ], capture_output=True, text=True, encoding='utf-8', env=self.env)
        if ok and result.returncode:
            self.fail(result.stdout + result.stderr)
        return result

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='dsh-push-test-')
        self.root = pathlib.Path(self.temporary.name).resolve()
        self.assertEqual(self.root.parent, pathlib.Path(tempfile.gettempdir()).resolve())
        self.addCleanup(self.temporary.cleanup)
        self.env = dict(os.environ, GIT_TERMINAL_PROMPT='0')
        self.empty_hooks = self.root / 'empty-hooks'
        self.empty_hooks.mkdir()
        self.local = self.root / 'local'
        self.remote = self.root / 'remote'
        self.local.mkdir()
        self.git(self.local, 'init', '-b', 'main')
        self.git(self.local, 'config', 'core.autocrlf', 'false')
        (self.local / 'tracked.txt').write_bytes(b'base\n')
        self.git(self.local, 'add', 'tracked.txt')
        self.git(self.local, 'commit', '-m', 'base')
        self.git(self.root, 'clone', str(self.local), str(self.remote))
        self.git(self.remote, 'config', 'core.autocrlf', 'false')
        self.git(self.remote, 'config', 'receive.denyCurrentBranch', 'updateInstead')

    def commit_upload(self):
        (self.local / 'upload.txt').write_bytes(b'selected local upload\n')
        self.git(self.local, 'add', 'upload.txt')
        self.git(self.local, 'commit', '-m', 'upload')

    def test_unrelated_untracked_server_output_survives_push(self):
        output = self.remote / 'server-output.txt'
        output.write_bytes(b'generated result\n')
        self.commit_upload()
        self.assertTrue(self.git(self.remote, 'status', '--porcelain').stdout.strip())
        self.assertFalse(self.git(self.remote, 'status', '--porcelain', '--untracked-files=no').stdout.strip())
        self.git(self.local, 'push', str(self.remote), 'HEAD:refs/heads/main')
        self.assertEqual(output.read_bytes(), b'generated result\n')
        self.assertEqual((self.remote / 'upload.txt').read_bytes(), b'selected local upload\n')

    def test_tracked_server_edits_still_block_push(self):
        (self.remote / 'tracked.txt').write_bytes(b'uncommitted server edits\n')
        self.commit_upload()
        self.assertTrue(self.git(self.remote, 'status', '--porcelain', '--untracked-files=no').stdout.strip())
        result = self.git(self.local, 'push', str(self.remote), 'HEAD:refs/heads/main', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.remote / 'tracked.txt').read_bytes(), b'uncommitted server edits\n')

    def test_colliding_untracked_server_file_is_not_overwritten(self):
        (self.remote / 'upload.txt').write_bytes(b'server-only contents\n')
        self.commit_upload()
        self.assertFalse(self.git(self.remote, 'status', '--porcelain', '--untracked-files=no').stdout.strip())
        result = self.git(self.local, 'push', str(self.remote), 'HEAD:refs/heads/main', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.remote / 'upload.txt').read_bytes(), b'server-only contents\n')


if __name__ == '__main__':
    unittest.main()
