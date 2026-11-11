import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('server_watch',Path(__file__).resolve().parents[1]/'server-watch.py')
watch=importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)


class ServerWatchTests(unittest.TestCase):
    def test_stream_and_whole_message_do_not_duplicate_text(self):
        view=watch.EventView()
        events=[
            {'type':'stream_event','event':{'type':'message_start','message':{'id':'m'}}},
            {'type':'stream_event','event':{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':'Hello'}}},
            {'type':'assistant','message':{'id':'m','content':[{'type':'text','text':'Hello'}]}},
            {'type':'result','result':'Hello'},
        ]
        text=''.join(view.render({'type':'claude_event','event':event}) for event in events)
        self.assertEqual(text.count('Hello'),1)

    def test_actual_tool_output_and_approval_are_visible(self):
        view=watch.EventView()
        start=view.render({'type':'claude_event','event':{'type':'assistant','message':{'content':[{'type':'tool_use','id':'tool-1','name':'Bash','input':{'command':'printf fixture'}}]}}})
        waiting=view.render({'type':'claude_event','event':{'type':'control_request','request_id':'request-1','request':{'tool_name':'Bash'}}})
        approval=view.render({'type':'approval_result','request_id':'request-1','behavior':'allow'})
        result=view.render({'type':'claude_event','event':{'type':'user','message':{'content':[{'type':'tool_result','tool_use_id':'tool-1','content':'fixture output'}]}}})
        self.assertIn('printf fixture',start)
        self.assertIn('等待 DSH 审批',waiting)
        self.assertIn('允许',approval)
        self.assertIn('fixture output',result)

    def test_terminal_control_sequences_and_thinking_body_are_not_forwarded(self):
        view=watch.EventView()
        self.assertNotIn('\x1b',watch.safe_text('\x1b]52;c;abc\x07'))
        self.assertEqual(view.render({'type':'claude_event','event':{'type':'assistant','message':{'content':[{'type':'thinking','thinking':'internal text'}]}}}), '')

    def test_reader_waits_for_complete_jsonl_and_does_not_modify_log(self):
        with tempfile.TemporaryDirectory(prefix='watch-read-') as temporary:
            file=Path(temporary)/'events.jsonl'
            first=json.dumps({'type':'broker_done'})+'\n'
            file.write_bytes((first+'{"type":').encode())
            records,offset=watch.read_events(file,0)
            self.assertEqual(records,[{'type':'broker_done'}])
            self.assertEqual(offset,len(first.encode()))
            with file.open('a',encoding='utf-8') as stream:stream.write('"stderr","text":"test"}\n')
            before=file.read_bytes()
            records,_=watch.read_events(file,offset)
            self.assertEqual(records,[{'type':'stderr','text':'test'}])
            self.assertEqual(before,file.read_bytes())


if __name__=='__main__':unittest.main()
