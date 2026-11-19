import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('native_peer', Path(__file__).parents[1] / 'native-peer.py')
peer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(peer)


class NativePeerTests(unittest.TestCase):
    def test_transcript_blocks_keep_distinct_ids_and_hide_thinking(self):
        first = {'type': 'assistant', 'uuid': 'block-a', 'message': {'id': 'same-message', 'content': [{'type': 'text', 'text': 'First'}]}}
        second = {'type': 'assistant', 'uuid': 'block-b', 'message': {'id': 'same-message', 'content': [{'type': 'text', 'text': 'Last'}, {'type': 'thinking', 'thinking': 'private'}]}}
        self.assertNotEqual(peer.normalize(first)['message']['id'], peer.normalize(second)['message']['id'])
        self.assertNotIn('private', json.dumps(peer.normalize(second)))

    def test_native_draft_and_permission_menu_block_left_input(self):
        self.assertTrue(peer.editor_empty('output\n❯ Try "edit file"\nstatus'))
        self.assertTrue(peer.editor_empty('output\n❯ \nstatus'))
        self.assertFalse(peer.editor_empty('output\n❯ my unfinished draft\nstatus'))
        self.assertFalse(peer.editor_empty('Allow tool?\n❯ 1. Yes\n2. No'))

    def test_existing_terminal_is_never_restarted(self):
        with patch.object(peer, 'existing_session', return_value=True), patch.object(peer, 'tmux') as tmux:
            self.assertEqual(peer.ensure(Path('unused'), 'a' * 32), 'dsh-native-' + 'a' * 32)
            tmux.assert_not_called()

    def test_native_start_resumes_saved_session_and_scopes_settings(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            sid = '298ae0d1-dc8b-59f7-4ee6-79d40a3b1e3a'
            (directory / 'session.json').write_text(json.dumps({'id': sid, 'started': True}))
            with patch.object(peer, 'existing_session', return_value=False), patch.object(peer.agent, 'workspace', return_value=directory), patch.object(peer, 'tmux') as tmux:
                peer.ensure(directory, 'b' * 32)
            command = tmux.call_args_list[0].args[-1]
            self.assertIn('--resume ' + sid, command)
            self.assertNotIn('--permission-prompt-tool', command)
            self.assertNotIn(' -p ', command)
            settings = json.loads((directory / 'native-settings.json').read_text())
            self.assertEqual(set(settings), {'hooks'})

    def test_artifacts_bind_to_current_native_turn(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.assertRegex(peer.artifact_turn(directory), '^[a-f0-9]{32}$')
            (directory / 'native-active-turn.json').write_text(json.dumps({'turn': 'c' * 32}))
            self.assertEqual(peer.artifact_turn(directory), 'c' * 32)

    def test_existing_terminal_cannot_silently_change_execution_mode(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary)
            (directory/'binding.json').write_text(json.dumps({'vmTools':True}))
            with patch.object(peer,'existing_session',return_value=True), patch.object(peer,'tmux') as tmux:
                with self.assertRaisesRegex(ValueError,'新聊天'):peer.ensure(directory,'d'*32)
                tmux.assert_not_called()

    def test_vm_terminal_loads_only_vm_tools_and_disables_cloud_builtins(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary)/'state';directory.mkdir()
            (directory/'binding.json').write_text(json.dumps({'vmTools':True}))
            home=Path(temporary)/'home'
            binding=home/'.local/state/dsh-remote/vm-bridge-v1/sessions'/('e'*32)/'binding.json'
            binding.parent.mkdir(parents=True);binding.write_text('{}')
            with patch.object(peer,'existing_session',return_value=False),patch.object(peer.agent,'workspace',return_value=directory),patch.object(Path,'home',return_value=home),patch.object(peer,'tmux') as tmux:
                peer.ensure(directory,'e'*32)
            self.assertIn("--tools ''",tmux.call_args_list[0].args[-1])
            self.assertIn('DISABLE_AUTOUPDATER=1',tmux.call_args_list[0].args[-1])
            self.assertEqual(set(json.loads((directory/'native-mcp.json').read_text())['mcpServers']),{'dsh_local_vm'})

    def test_native_vm_preserves_orchestration_and_routes_project_agent_to_mcp(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary)/'state';directory.mkdir()
            (directory/'binding.json').write_text(json.dumps({'vmTools':True,'vmEngine':'claude-mcp-v2'}))
            home=Path(temporary)/'home'
            binding=home/'.local/state/dsh-remote/vm-native-v2/sessions'/('f'*32)/'binding.json'
            binding.parent.mkdir(parents=True);binding.write_text('{}')
            with patch.object(peer,'existing_session',return_value=False),patch.object(peer.agent,'workspace',return_value=directory),patch.object(Path,'home',return_value=home),patch.object(peer,'tmux') as tmux:
                peer.ensure(directory,'f'*32)
            import shlex
            args=shlex.split(tmux.call_args_list[0].args[-1])
            tools=args[args.index('--tools')+1].split(',')
            self.assertTrue({'Agent','Skill','WebSearch','WebFetch'}<=set(tools))
            self.assertFalse({'Bash','Read','Write','Edit'}&set(tools))
            self.assertIn('Bash',args[args.index('--disallowedTools')+1].split(','))
            agents=json.loads(args[args.index('--agents')+1])
            self.assertIn('mcp__dsh_local_vm__*',agents['vm-project']['tools'])
            self.assertEqual(json.loads((directory/'native-mcp.json').read_text())['mcpServers']['dsh_local_vm']['command'],'python3')


if __name__ == '__main__':
    unittest.main()
