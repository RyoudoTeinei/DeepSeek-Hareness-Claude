import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

SOURCE = Path(__file__).resolve().parents[1] / 'desktop-remote.py'
spec = importlib.util.spec_from_file_location('desktop_remote', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DesktopMcpTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='dsh-mcp-test-')
        self.directory = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def call(self, name, arguments):
        return module.handle_rpc({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                                  'params': {'name': name, 'arguments': arguments}}, self.directory)['result']

    def test_requests_wait_for_confirmation_and_can_be_completed(self):
        result = self.call('desktop_request_artifact', {'action': 'download', 'path': 'report.pdf', 'reason': 'Read the result'})
        receipt = result['structuredContent']
        self.assertEqual(receipt['status'], 'pending')
        identifier = receipt['id']
        self.assertEqual(self.call('desktop_request_status', {'id': identifier})['structuredContent'], receipt)
        module.save(self.directory / 'responses' / (identifier + '.json'), {'id': identifier, 'status': 'completed'})
        self.assertEqual(self.call('desktop_request_status', {'id': identifier})['structuredContent']['status'], 'completed')

    def test_local_commands_and_paths_are_rejected(self):
        for path in ['../secret', '/etc/passwd', 'C:/secret', 'a\\b', 'NUL.txt']:
            with self.subTest(path=path):
                result = self.call('desktop_request_artifact', {'action': 'download', 'path': path, 'reason': ''})
                self.assertTrue(result['isError'])
        self.assertTrue(self.call('desktop_request_artifact', {'action': 'shell', 'path': 'x', 'reason': ''})['isError'])

    def test_stdio_initialize_list_and_ping(self):
        messages = [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-11-25'}},
            {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
            {'jsonrpc': '2.0', 'id': 3, 'method': 'ping'},
        ]
        completed = subprocess.run([sys.executable, str(SOURCE)], input='\n'.join(map(json.dumps,messages))+'\n', text=True, capture_output=True, check=True)
        replies = [json.loads(line) for line in completed.stdout.splitlines()]
        self.assertEqual([reply['id'] for reply in replies], [1,2,3])
        self.assertEqual(len(replies[1]['result']['tools']), 2)
        self.assertEqual(replies[0]['result']['protocolVersion'], '2025-11-25')

    @unittest.skipIf(sys.platform == 'win32', 'Descriptor-relative reads require Linux')
    def test_artifact_read_rejects_symlink_escape(self):
        project = self.directory / 'project'
        project.mkdir()
        outside = self.directory / 'secret.txt'
        outside.write_text('outside')
        (project / 'link.txt').symlink_to(outside)
        with self.assertRaises(OSError):
            module.artifact_stream(project, 'link.txt')


if __name__ == '__main__':
    unittest.main()
