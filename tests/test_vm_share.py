import importlib.util
from pathlib import Path
import os
import tempfile
import unittest

try:import paramiko
except ImportError:paramiko=None
spec=importlib.util.spec_from_file_location('vm_share',Path(__file__).parents[1]/'vm-sftp.py')
module=importlib.util.module_from_spec(spec)
if paramiko:spec.loader.exec_module(module)


@unittest.skipUnless(paramiko,'Paramiko is required by the optional VM share')
class VMShareTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.root=Path(self.temporary.name)
        self.share=module.ProjectFiles(None,self.root)
    def tearDown(self):self.temporary.cleanup()
    def test_parent_and_device_paths_are_rejected(self):
        for path in ('../secret','/../secret','a\\b','/C:/secret','/CON','/COM1.txt','/CONIN$','/a:stream','/bad.','/bad '):
            with self.assertRaises(PermissionError):self.share.local(path)
    def test_readonly_rejects_mutations(self):
        share=module.ProjectFiles(None,self.root,True)
        self.assertNotEqual(share.mkdir('/new',None),paramiko.SFTP_OK)
        self.assertNotEqual(share.open('/new',os.O_WRONLY|os.O_CREAT,None),paramiko.SFTP_OK)
        self.assertFalse((self.root/'new').exists())
    def test_hidden_paths_are_preserved_and_root_cannot_be_removed(self):
        (self.root/'.git').mkdir()
        self.assertEqual(self.share.canonicalize('/.git'),'/.git')
        self.assertNotEqual(self.share.rmdir('/'),paramiko.SFTP_OK)
        self.assertEqual(self.share.list_folder('.')[0].filename,'.git')
    def test_link_cannot_escape_share(self):
        with tempfile.TemporaryDirectory() as outside:
            try:(self.root/'link').symlink_to(outside,target_is_directory=True)
            except OSError:self.skipTest('Host does not permit symbolic links')
            with self.assertRaises(PermissionError):self.share.local('/link/secret')
    def test_hardlink_to_other_directory_is_not_shared(self):
        with tempfile.TemporaryDirectory() as outside:
            source=Path(outside)/'private.txt';source.write_text('private')
            try:os.link(source,self.root/'linked.txt')
            except OSError:self.skipTest('Host does not permit hard links')
            with self.assertRaises(PermissionError):self.share.local('/linked.txt')
    def test_replaced_root_is_not_an_existing_grant(self):
        old=self.root.with_name(self.root.name+'-old')
        self.root.rename(old);self.root.mkdir()
        try:
            with self.assertRaises(PermissionError):self.share.local('/')
        finally:
            self.root.rmdir();old.rename(self.root)


if __name__=='__main__':unittest.main()
