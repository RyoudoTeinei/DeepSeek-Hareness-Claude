import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

source=Path(__file__).resolve().parents[1]/'structured-peer.py'
spec=importlib.util.spec_from_file_location('structured_peer',source)
peer=importlib.util.module_from_spec(spec)
spec.loader.exec_module(peer)


class StructuredPeerTests(unittest.TestCase):
    def test_paths_reject_absolute_and_parent_traversal(self):
        for relative in ('../secret','/etc/passwd','a/../b','C:/secret','a\\b','a\nb'):
            with self.subTest(relative=relative),self.assertRaises(ValueError):
                peer.project_path(Path('/project'),relative)

    @unittest.skipIf(sys.platform=='win32','Descriptor-relative files require Linux')
    def test_artifact_snapshot_survives_changes_to_source(self):
        with tempfile.TemporaryDirectory(prefix='structured-files-') as temporary:
            root=Path(temporary)
            project=root/'project';project.mkdir()
            (project/'result.txt').write_bytes(b'first version\n')
            with patch.object(peer,'workspace',return_value=project):
                receipt=peer.publish(root,'a'*32,'result.txt')
            (project/'result.txt').write_bytes(b'new version\n')
            snapshot=root/'turns'/('a'*32)/'artifacts'/(receipt['id']+'.blob')
            self.assertEqual(snapshot.read_bytes(),b'first version\n')
            output=io.StringIO()
            with redirect_stdout(output):peer.download(root,'a'*32,receipt['id'])
            events=[json.loads(line[len(peer.PREFIX):]) for line in output.getvalue().splitlines()]
            self.assertEqual(events[-1]['sha256'],receipt['sha256'])

    @unittest.skipIf(sys.platform=='win32','Descriptor-relative files require Linux')
    def test_artifact_export_refuses_symlink_outside_project(self):
        with tempfile.TemporaryDirectory(prefix='structured-link-') as temporary:
            root=Path(temporary);project=root/'project';project.mkdir()
            (root/'outside.txt').write_text('outside')
            (project/'link.txt').symlink_to(root/'outside.txt')
            with patch.object(peer,'workspace',return_value=project),self.assertRaises(OSError):
                peer.publish(root,'b'*32,'link.txt')


if __name__=='__main__':unittest.main()
