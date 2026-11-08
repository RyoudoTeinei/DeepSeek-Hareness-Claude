import importlib.util
import pathlib
import unittest

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'chat-peer.py'
SPEC = importlib.util.spec_from_file_location('chat_peer', SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
TurnReader = MODULE.TurnReader


def assistant(uid, kind, reason, text=''):
    block = {'type': kind}
    if text:
        block['text'] = text
    return {'type': 'assistant', 'uuid': uid,
            'message': {'stop_reason': reason, 'content': [block]}}


class ReplyReaderTests(unittest.TestCase):
    def accepted(self):
        reader = TurnReader('hello')
        reader.consume({'type': 'user', 'message': {'content': 'hello'}})
        return reader

    def test_end_turn_thinking_waits_for_final_text(self):
        reader = self.accepted()
        self.assertEqual(reader.consume(assistant('thinking', 'thinking', 'end_turn')), [])
        self.assertFalse(reader.final_text_seen)
        self.assertFalse(reader.finished)
        self.assertEqual(reader.consume(assistant('final', 'text', 'end_turn', 'Final answer')), ['Final answer'])
        self.assertFalse(reader.finished)
        reader.consume({'type': 'system', 'subtype': 'turn_duration'})
        self.assertTrue(reader.finished)

    def test_all_final_text_blocks_are_forwarded_before_completion(self):
        reader = self.accepted()
        texts = []
        for uid, text in [('first', 'Part one'), ('second', 'Part two')]:
            texts.extend(reader.consume(assistant(uid, 'text', 'end_turn', text)))
            self.assertFalse(reader.finished)
        reader.consume({'type': 'system', 'subtype': 'turn_duration'})
        self.assertEqual(texts, ['Part one', 'Part two'])
        self.assertTrue(reader.finished)

    def test_tool_results_duplicates_and_sidechains_are_not_final_answers(self):
        reader = self.accepted()
        progress = assistant('progress', 'text', 'tool_use', 'Checking files')
        self.assertEqual(reader.consume(progress), ['Checking files'])
        self.assertEqual(reader.consume(progress), [])
        reader.consume({'type': 'user', 'message': {'content': [{'type': 'tool_result'}]}})
        side = assistant('side', 'text', 'end_turn', 'Another conversation')
        side['isSidechain'] = True
        self.assertEqual(reader.consume(side), [])
        self.assertFalse(reader.final_text_seen)

    def test_manual_prompt_can_use_text_blocks(self):
        reader = TurnReader('hello\nworld')
        reader.consume({'type': 'user', 'message': {'content': [
            {'type': 'text', 'text': 'hello'}, {'type': 'text', 'text': 'world'}]}})
        self.assertTrue(reader.accepted)

    def test_overlapping_manual_turn_is_reported(self):
        reader = self.accepted()
        with self.assertRaisesRegex(ValueError, '另一轮'):
            reader.consume({'type': 'user', 'message': {'content': 'New prompt'}})

    def test_ended_turn_without_final_text_is_an_error(self):
        reader = self.accepted()
        reader.consume(assistant('thinking', 'thinking', 'end_turn'))
        with self.assertRaisesRegex(ValueError, '最终正文'):
            reader.consume({'type': 'system', 'subtype': 'turn_duration'})

    def test_other_terminal_stop_reasons_also_wait_for_text(self):
        for reason in ('stop_sequence', 'max_tokens'):
            with self.subTest(reason=reason):
                reader = self.accepted()
                reader.consume(assistant('thinking', 'thinking', reason))
                self.assertFalse(reader.final_text_seen)
                reader.consume(assistant('text', 'text', reason, 'Available answer'))
                self.assertTrue(reader.final_text_seen)
                self.assertFalse(reader.finished)

    def test_progress_then_delayed_final_answer_is_not_truncated(self):
        reader = self.accepted()
        records = [
            assistant('progress', 'text', 'tool_use', 'Working on the task'),
            assistant('tool', 'tool_use', 'tool_use'),
            {'type': 'user', 'message': {'content': [{'type': 'tool_result'}]}},
            assistant('thinking', 'thinking', 'end_turn'),
            assistant('answer', 'text', 'end_turn', 'The complete final answer'),
            {'type': 'system', 'subtype': 'turn_duration'},
        ]
        texts = []
        for item in records:
            texts.extend(reader.consume(item))
        self.assertEqual(texts, ['Working on the task', 'The complete final answer'])
        self.assertTrue(reader.finished)


if __name__ == '__main__':
    unittest.main()
