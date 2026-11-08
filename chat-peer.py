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


def capture(pane):
    raw = tmux("capture-pane", "-e", "-p", "-t", pane)
    # Dim text after the input marker is the inline suggestion.
    clean = re.sub(r"(❯\s*)\x1b\[2m[^\n]*", r"\1", raw)
    return re.sub(r"\x1b\[[0-9;]*m", "", clean)


def editor_text(screen):
    return next((line.strip()[1:].strip() for line in reversed(screen.splitlines())
                 if line.strip().startswith("❯")), None)


def editor_empty(screen):
    text = editor_text(screen)
    return text is not None and (not text or text.startswith('Try "'))


def wait_for(pane, read, timeout=4):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = read(capture(pane))
        if result:
            return result
        time.sleep(.1)
    return None


def paste(pane, buffer_name, text):
    tmux("load-buffer", "-b", buffer_name, "-", data=text.encode())
    tmux("paste-buffer", "-d", "-p", "-b", buffer_name, "-t", pane)


def read_model_picker(screen):
    header = re.search(r"^\s*Select model\s*$", screen, re.MULTILINE)
    if not header:
        return None
    menu = screen[header.end():]
    if "s to use this session only" not in menu:
        return None
    rows = {}
    selected = None
    for line in menu.splitlines():
        match = re.match(r"^\s*([❯↑↓])?\s*(\d+)\.\s+(.+)$", line)
        if not match:
            continue
        marker, index, description = match.groups()
        label = re.split(r"\s{2,}", description.strip(), maxsplit=1)[0]
        current = label.endswith(("✔", "✓"))
        label = label.rstrip("✔✓ ").strip()
        rows[int(index)] = (label, current)
        if marker == "❯":
            selected = int(index)
    return (selected, rows) if selected in rows else None


def open_model_picker(pane, buffer_name):
    if not editor_empty(capture(pane)):
        raise ValueError("右侧输入框有草稿或正等待确认，请先处理。")
    paste(pane, buffer_name, "/model")
    if not wait_for(pane, lambda screen: editor_text(screen) == "/model"):
        raise ValueError("无法确认模型命令已填入，请检查右侧终端。")
    tmux("send-keys", "-t", pane, "Enter")
    picker = wait_for(pane, read_model_picker)
    if not picker:
        raise ValueError("无法读取 Claude 模型菜单，请检查右侧终端。")
    return picker


def move_picker(pane, selected, key):
    tmux("send-keys", "-t", pane, key)

    def changed(screen):
        picker = read_model_picker(screen)
        return picker if picker and picker[0] != selected else None

    return wait_for(pane, changed, timeout=1)


def close_model_picker(pane):
    if read_model_picker(capture(pane)):
        tmux("send-keys", "-t", pane, "Escape")
    if not wait_for(pane, editor_empty):
        raise ValueError("请处理右侧终端的提示后重试。")


def select_model(pane, buffer_name, model):
    match = re.fullmatch(r"claude-(opus|fable|sonnet|haiku)-(\d+)-(\d+)", model)
    if not match:
        raise ValueError("无效的 Claude 模型 ID。")
    family, major, minor = match.groups()
    wanted = f"{family.title()} {major}.{minor}"
    picker = open_model_picker(pane, buffer_name)
    # When the menu is scrolled, first locate the beginning, then walk down.
    searching_down = False
    for _ in range(24):
        index, rows = picker
        targets = [number for number, row in rows.items() if row[0] == wanted]
        if len(targets) > 1:
            break
        if targets and targets[0] == index:
            if rows[index][1]:
                close_model_picker(pane)
                return
            # The picker advertises this session-only action. Enter here would
            # save the model as the account-wide default.
            current = read_model_picker(capture(pane))
            if current != picker:
                raise ValueError("模型菜单已变化，请重试。")
            tmux("send-keys", "-t", pane, "s")
            if not wait_for(pane, editor_empty):
                screen = capture(pane)
                if "Switch to Fable" in screen and "You don't have usage credits yet" in screen:
                    raise ValueError("此账号尚无 Fable 所需的 usage credits，消息未发送。")
                raise ValueError(f"切换 {wanted} 需要确认，请处理右侧终端后重试。")
            _, verified = open_model_picker(pane, buffer_name)
            close_model_picker(pane)
            if any(label == wanted and active for label, active in verified.values()):
                return
            raise ValueError(f"远端未确认已切换到 {wanted}，消息未发送。")
        if min(rows) == 1:
            searching_down = True
        key = "Up" if (targets and targets[0] < index) or (not targets and not searching_down) else "Down"
        next_picker = move_picker(pane, index, key)
        if not next_picker:
            break
        picker = next_picker
    close_model_picker(pane)
    raise ValueError(f"远端 Claude Code 的模型菜单没有可用的 {wanted} 选项。")


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
    prompt=req["text"]
    if not prompt.strip() or any(ord(c)<32 and c not in "\n\t" for c in prompt): raise ValueError("仅支持普通文本")
    if prompt.lstrip().startswith(("/","!")): raise ValueError("斜杠命令和 Shell 命令请在右侧终端执行。")
    name="dshchat-"+pid
    if req.get("model"):
        select_model(pane, name, req["model"])
    if not editor_empty(capture(pane)):
        raise ValueError("右侧输入框有草稿或正等待确认，请先处理。")
    current = json.loads(statefile.read_text())
    if current.get("sessionId") != session or current.get("status") != "idle":
        raise ValueError("右侧 Claude 会话状态已变化，请检查终端后重试。")
    # Model-picker commands can write transcript entries of their own.
    offset=log.stat().st_size if log.exists() else 0
    paste(pane, name, prompt)
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
