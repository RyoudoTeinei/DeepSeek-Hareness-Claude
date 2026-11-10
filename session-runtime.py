import base64
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import time
import uuid

state = Path(__file__).resolve().parent
config_root = Path(os.environ.get("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude")))


def save(name, value):
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=state, delete=False) as f:
        json.dump(value, f)
    os.replace(f.name, state / name)


def transcript(cwd, session_id):
    return config_root / "projects" / re.sub(r"[^a-zA-Z0-9]", "-", cwd) / (session_id + ".jsonl")


def current(pane_pid):
    try:
        return json.loads((config_root / "sessions" / (pane_pid + ".json")).read_text())
    except FileNotFoundError:
        return None


def remember(value):
    save("current-session.json", {
        "sessionId": value["sessionId"],
        "transcript": str(transcript(value["cwd"], value["sessionId"])),
    })


def tmux(*args):
    return subprocess.check_output(["tmux", *args], text=True).strip()


def prepare(config):
    name = config["name"]
    alive = subprocess.run(["tmux", "has-session", "-t", "=" + name],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if alive:
        revision = tmux("show-option", "-qv", "-t", name, "@dsh-session-runtime")
        mode = tmux("show-option", "-qv", "-t", name, "@dsh-execution-mode")
        if revision != "1" or mode != config["mode"]:
            pid = tmux("display-message", "-p", "-t", name + ":", "#{pane_pid}")
            native = current(pid)
            if native and native.get("status") != "idle":
                tmux("send-keys", "-t", name + ":", "Escape")
                deadline = time.monotonic() + 30
                while native and native.get("status") != "idle" and time.monotonic() < deadline:
                    time.sleep(.1)
                    native = current(pid)
                if native and native.get("status") != "idle":
                    raise RuntimeError("Claude 尚未停止，执行位置切换未完成。")
            if native:
                remember(native)
            tmux("kill-session", "-t", name)
    save("launch.json", config)
    command = "python3 " + shlex.quote(str(Path(__file__).resolve())) + " record"
    save("session-settings.json", {"hooks": {"SessionStart": [{
        "matcher": "startup|resume|clear|compact",
        "hooks": [{"type": "command", "command": command}],
    }]}})


def record():
    event = json.load(sys.stdin)
    save("current-session.json", {
        "sessionId": event["session_id"],
        "transcript": event["transcript_path"],
    })


def launch():
    config = json.loads((state / "launch.json").read_text())
    try:
        last = json.loads((state / "current-session.json").read_text())
    except FileNotFoundError:
        session_id = config.get("sessionId") or str(uuid.uuid4())
        last = {"sessionId": session_id, "transcript": str(transcript(os.getcwd(), session_id))}
    session_id = last["sessionId"]
    history = Path(last["transcript"])
    args = ["claude", "--resume" if history.is_file() and history.stat().st_size else "--session-id", session_id]
    args += ["--settings", str(state / "session-settings.json")]
    if config["mode"] == "local":
        args += ["--tools", config["serverTools"], "--mcp-config", str(state / "mcp.json")]
    env = dict(os.environ, PATH=str(Path.home() / ".local/bin") + os.pathsep + os.environ["PATH"],
               CLAUDE_CODE_NO_FLICKER="1")
    os.execvpe("claude", args, env)


if __name__ == "__main__":
    action = sys.argv[1]
    if action == "prepare":
        prepare(json.loads(base64.b64decode(sys.argv[2])))
    elif action == "record":
        record()
    elif action == "launch":
        launch()
