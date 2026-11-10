import json
import os
from pathlib import Path
import socket
import sys
import threading
from tempfile import NamedTemporaryFile


def write_json(file, data):
    with NamedTemporaryFile(mode="w", encoding="utf-8", dir=file.parent, delete=False) as tmp:
        json.dump(data, tmp)
    os.replace(tmp.name, file)


def serve(state):
    connection = json.loads((state / "connection.json").read_text())
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.connect(connection["socket"])
        client.sendall(json.dumps({"token": connection["token"]}).encode() + b"\n")

        def send():
            try:
                for line in sys.stdin.buffer:
                    client.sendall(line)
                client.shutdown(socket.SHUT_WR)
            except OSError:
                pass

        threading.Thread(target=send, daemon=True).start()
        with client.makefile("rb") as reader:
            for line in reader:
                sys.stdout.buffer.write(line)
                sys.stdout.buffer.flush()


if __name__ == "__main__":
    action = sys.argv[1]
    state = Path(__file__).resolve().parent
    if action == "setup":
        write_json(state / "mcp.json", {"mcpServers": {
            "claude-code": {"type": "stdio", "command": "python3", "args": [str(Path(__file__).resolve()), "serve"]},
        }})
    elif action == "connect":
        write_json(state / "connection.json", {"socket": sys.argv[2], "token": sys.argv[3]})
    elif action == "disconnect":
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(3)
                client.connect(sys.argv[2])
                client.sendall(json.dumps({"token": sys.argv[3], "close": True}).encode() + b"\n")
                client.recv(1)
        except OSError:
            pass
    elif action == "serve":
        try:
            serve(state)
        except (OSError, ValueError, KeyError):
            print("本机 Claude Code 连接已关闭，请重新接入并在 /mcp 中重连。", file=sys.stderr)
            sys.exit(1)
