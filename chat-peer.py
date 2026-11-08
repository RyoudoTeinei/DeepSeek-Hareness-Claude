import sys, json, subprocess, time, re
from pathlib import Path

def tmux(*args, data=None):
    return subprocess.check_output(["tmux", *args], input=data).decode().strip()

def emit(**event):
    print(json.dumps(event), flush=True)


class TurnReader:
    """Follow one manual turn; a thinking block never completes a reply."""

    terminal_reasons = {"end_turn", "stop_sequence", "max_tokens"}

    def __init__(self, prompt):
        self.prompt = prompt.strip()
        self.accepted = False
        self.seen = set()
        self.final_text_seen = False
        self.finished = False

    def consume(self, item):
        if item.get("isSidechain"):
            return []
        kind = item.get("type")
        message = item.get("message") or {}
        content = message.get("content", [])
        if kind == "user":
            # Tool results also use type=user; only actual prompt text counts.
            if isinstance(content, str):
                text = content
            elif isinstance(content, list) and content and all(
                isinstance(block, dict) and block.get("type") == "text"
                for block in content
            ):
                text = "\n".join(block.get("text", "") for block in content)
            else:
                return []
            if self.accepted:
                raise ValueError("检测到终端发起了另一轮，请在右侧查看。")
            if text.strip() == self.prompt:
                self.accepted = True
            return []
        if not self.accepted:
            return []
        if kind == "system" and item.get("subtype") == "turn_duration":
            if not self.final_text_seen:
                raise ValueError("Claude 本轮已结束，但没有读到最终正文，请查看右侧终端。")
            self.finished = True
            return []
        if kind != "assistant":
            return []
        uid = item.get("uuid")
        if uid and uid in self.seen:
            return []
        if uid:
            self.seen.add(uid)
        texts = [block["text"] for block in content
                 if isinstance(block, dict) and block.get("type") == "text"
                 and isinstance(block.get("text"), str) and block["text"]]
        reason = message.get("stop_reason")
        # Claude Code writes one JSONL record per block. The thinking record
        # can already carry end_turn several seconds before the text record.
        if texts and reason in self.terminal_reasons:
            self.final_text_seen = True
        elif reason == "tool_use":
            self.final_text_seen = False
        return texts


def run():
    import fcntl  # Only the remote Linux entry point needs the file lock.
    req=json.load(sys.stdin)
    target=req["session"]+":"
    pane,pid,cmd=tmux("display-message","-p","-t",target,"#{pane_id} #{pane_pid} #{pane_current_command}").split()
    if cmd!="claude": raise ValueError("请先在右侧接入 Claude Code。")
    home=Path.home()
    statefile=home/".claude/sessions"/(pid+".json")
    state=json.loads(statefile.read_text())
    cwd=Path(state["cwd"]).resolve()
    if cwd!=(home/"projects"/req["project"]).resolve(): raise ValueError("终端所在项目已切换，请重新接入。")
    lockdir=home/".local/state/dsh-remote"
    lockdir.mkdir(mode=0o700,parents=True,exist_ok=True)
    lock=(lockdir/(req["session"]+".lock")).open("a")
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    if state.get("status")!="idle": raise ValueError("Claude 正忙，请查看右侧终端后重试。")
    session=state["sessionId"]
    if not re.fullmatch(r"[a-fA-F0-9-]{36}",session): raise ValueError("无效会话标识")
    log=home/".claude/projects"/re.sub(r"[^a-zA-Z0-9]","-",str(cwd))/(session+".jsonl")
    if not log.exists():
        matches=list((home/".claude/projects").glob("*/"+session+".jsonl"))
        if matches: log=matches[0]
    offset=log.stat().st_size if log.exists() else 0
    prompt=req["text"]
    if not prompt.strip() or any(ord(c)<32 and c not in "\n\t" for c in prompt): raise ValueError("仅支持普通文本")
    if prompt.lstrip().startswith(("/","!")): raise ValueError("斜杠命令和 Shell 命令请在右侧终端执行。")
    raw_screen=tmux("capture-pane","-e","-p","-t",pane)
    # Dim text after the prompt is Claude's suggestion, not typed input.
    clean_screen=re.sub(r"(❯\s*)\x1b\[2m[^\n]*",r"\1",raw_screen)
    line=re.sub(r"\x1b\[[0-9;]*m","",clean_screen).splitlines()
    editor=next((s.strip()[1:].strip() for s in reversed(line) if s.strip().startswith("❯")),None)
    if editor is None or (editor and not editor.startswith('Try "')): raise ValueError("右侧输入框有草稿或正等待确认，请先处理。")
    name="dshchat-"+pid
    tmux("load-buffer","-b",name,"-",data=prompt.encode())
    tmux("paste-buffer","-d","-p","-b",name,"-t",pane)
    time.sleep(.25)
    tmux("send-keys","-t",pane,"Enter")
    reader=TurnReader(prompt)
    start=time.monotonic()
    last_data=start
    while time.monotonic()-start<1800:
        if not Path("/proc",pid).exists(): raise ValueError("右侧 Claude 进程已退出")
        if log.exists():
            with log.open("rb") as f:
                f.seek(offset)
                for raw in f:
                    if not raw.endswith(b"\n"): break
                    offset+=len(raw)
                    item=json.loads(raw)
                    last_data=time.monotonic()
                    for text in reader.consume(item):
                        emit(text=text)
                    if reader.finished:
                        emit(done=True);return
        # Older Claude versions may not write turn_duration. Finish only after
        # final text, an idle process, and a drained transcript; never on thinking.
        if reader.final_text_seen and time.monotonic()-last_data>=1:
            current=json.loads(statefile.read_text())
            if current.get("sessionId")!=session:
                raise ValueError("Claude 会话已切换，请查看右侧终端。")
            if current.get("status")=="idle":
                emit(done=True);return
        if not reader.accepted and time.monotonic()-start>25: raise ValueError("未能确认输入已被 Claude 接收，请看右侧终端，避免重复发送。")
        time.sleep(.18)
    raise ValueError("等待回复超时，请查看右侧终端")
if __name__ == "__main__":
    try: run()
    except Exception as e:
        emit(error=str(e));sys.exit(1)
