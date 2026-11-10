import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("session_runtime", Path(__file__).resolve().parents[1] / "session-runtime.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class SessionRuntimeTests(unittest.TestCase):
    def test_latest_session_is_used_after_clear_and_resume(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(runtime, "state", Path(tmp)):
            runtime.save("launch.json", {"mode": "remote", "sessionId": "initial"})
            for session in ("cleared", "resumed"):
                log = Path(tmp) / (session + ".jsonl")
                log.write_text("{}\n")
                with patch("sys.stdin", io.StringIO(json.dumps({"session_id": session, "transcript_path": str(log)}))):
                    runtime.record()
                with patch.object(runtime.os, "execvpe") as execute:
                    runtime.launch()
                args = execute.call_args.args[1]
                self.assertEqual(args[:3], ["claude", "--resume", session])
                self.assertNotIn("--tools", args)

    def test_mode_change_stops_the_previous_process_and_keeps_its_session(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(runtime, "state", Path(tmp)):
            config = {"name": "fixture", "mode": "remote", "sessionId": "initial"}
            calls = []
            def tmux(*args):
                calls.append(args)
                if args[0] == "show-option":
                    return "1" if args[-1] == "@dsh-session-runtime" else "local"
                if args[0] == "display-message":
                    return "123"
                return ""
            current = {"status": "idle", "sessionId": "latest", "cwd": tmp}
            with patch.object(runtime.subprocess, "run") as exists, patch.object(runtime, "tmux", tmux), patch.object(runtime, "current", return_value=current):
                exists.return_value.returncode = 0
                runtime.prepare(config)
            self.assertIn(("kill-session", "-t", "fixture"), calls)
            self.assertEqual(json.loads((Path(tmp) / "current-session.json").read_text())["sessionId"], "latest")
            settings = json.loads((Path(tmp) / "session-settings.json").read_text())
            self.assertEqual(list(settings), ["hooks"])
            self.assertEqual(list(settings["hooks"]), ["SessionStart"])


if __name__ == "__main__":
    unittest.main()
