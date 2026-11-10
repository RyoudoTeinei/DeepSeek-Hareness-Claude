"""Small stdio MCP endpoint and SSH relay. Installed in one session-owned directory."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import stat
import sys
import time
import uuid

LIMIT = 100 * 1024 * 1024
ID = re.compile(r'^[a-f0-9]{32}$')
OPEN_TYPES = {'.pdf', '.docx', '.xlsx', '.pptx', '.png', '.jpg', '.jpeg', '.webp', '.txt', '.md', '.csv'}


def emit(value):
    prefix = 'DSH_DESKTOP:' if sys.argv[1:] in (['relay'], ['artifact']) else ''
    print(prefix + json.dumps(value, ensure_ascii=True), flush=True)


def validate_request(value):
    if not isinstance(value, dict) or set(value) != {'id', 'action', 'path', 'reason'}:
        raise ValueError('Invalid request fields')
    if not isinstance(value['id'], str) or not ID.fullmatch(value['id']) or value['action'] not in ('download', 'open_file'):
        raise ValueError('Invalid action')
    relative = value['path']
    if not isinstance(relative, str) or not relative or len(relative) > 400 or re.search(r'[\\:\x00-\x1f\x7f]', relative):
        raise ValueError('Use a project-relative path')
    for part in relative.split('/'):
        if (part in ('', '.', '..') or part.endswith(('.', ' ')) or re.search(r'[<>"|?*]', part)
                or re.match(r'^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)', part, re.I)):
            raise ValueError('Invalid relative path')
    if not isinstance(value['reason'], str) or len(value['reason']) > 400 or re.search(r'[\x00-\x1f\x7f]', value['reason']):
        raise ValueError('Invalid reason')
    if value['action'] == 'open_file' and Path(relative).suffix.lower() not in OPEN_TYPES:
        raise ValueError('Use download for this file type')
    return value


def save(file, value):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = file.with_name(file.name + '.' + uuid.uuid4().hex + '.tmp')
    temporary.write_text(json.dumps(value), encoding='utf-8')
    os.chmod(temporary, 0o600)
    temporary.replace(file)


def tool_result(value, error=False):
    return {'content': [{'type': 'text', 'text': json.dumps(value)}], 'structuredContent': value, 'isError': error}


TOOLS = [
    {'name': 'desktop_request_artifact',
     'description': 'Ask the user in DSH to download or open a file from this remote project on their desktop. Requires local confirmation. Returns a request ID, not a completed action. Use a project-relative path. For a website preview, render a screenshot remotely and request that image.',
     'inputSchema': {'type': 'object', 'properties': {'action': {'type': 'string', 'enum': ['download', 'open_file']}, 'path': {'type': 'string', 'minLength': 1, 'maxLength': 400}, 'reason': {'type': 'string', 'maxLength': 400}}, 'required': ['action', 'path', 'reason'], 'additionalProperties': False},
     'annotations': {'readOnlyHint': False, 'destructiveHint': False, 'idempotentHint': False, 'openWorldHint': False}},
    {'name': 'desktop_request_status',
     'description': 'Read a desktop request status. Pending means the user has not completed confirmation in DSH. Do not poll repeatedly while waiting for the user.',
     'inputSchema': {'type': 'object', 'properties': {'id': {'type': 'string', 'pattern': '^[a-f0-9]{32}$'}}, 'required': ['id'], 'additionalProperties': False},
     'annotations': {'readOnlyHint': True, 'destructiveHint': False, 'idempotentHint': True, 'openWorldHint': False}},
]


def handle_rpc(message, directory):
    if not isinstance(message, dict) or message.get('jsonrpc') != '2.0':
        return {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32600, 'message': 'Invalid request'}}
    if 'id' not in message:
        return None
    reply = {'jsonrpc': '2.0', 'id': message['id']}
    method = message.get('method')
    params = message.get('params') or {}
    if not isinstance(params, dict):
        reply['error'] = {'code': -32602, 'message': 'Invalid params'}
        return reply
    if method == 'initialize':
        version = params.get('protocolVersion')
        if version not in ('2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'):
            version = '2025-11-25'
        reply['result'] = {'protocolVersion': version, 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'dsh_desktop', 'version': '0.1.0'}}
    elif method == 'ping':
        reply['result'] = {}
    elif method == 'tools/list':
        reply['result'] = {'tools': TOOLS}
    elif method == 'tools/call':
        try:
            arguments = params.get('arguments') or {}
            if not isinstance(arguments, dict):
                raise ValueError('Invalid arguments')
            if params.get('name') == 'desktop_request_artifact':
                if set(arguments) != {'action', 'path', 'reason'}:
                    raise ValueError('Unexpected arguments')
                request = validate_request({**arguments, 'id': uuid.uuid4().hex})
                pending = directory / 'requests'
                pending.mkdir(exist_ok=True, mode=0o700)
                for existing in pending.glob('*.json'):
                    response = directory / 'responses' / existing.name
                    if response.exists() and time.time() - existing.stat().st_mtime > 86400:
                        existing.unlink()
                        response.unlink()
                if sum(not (directory / 'responses' / file.name).exists() for file in pending.glob('*.json')) >= 32:
                    raise ValueError('Review pending desktop requests first')
                save(pending / (request['id'] + '.json'), request)
                reply['result'] = tool_result({'id': request['id'], 'status': 'pending'})
            elif params.get('name') == 'desktop_request_status':
                identifier = arguments.get('id')
                if set(arguments) != {'id'} or not isinstance(identifier, str) or not ID.fullmatch(identifier):
                    raise ValueError('Invalid request ID')
                request_file = directory / 'requests' / (identifier + '.json')
                if not request_file.is_file():
                    raise ValueError('Unknown request ID')
                response = directory / 'responses' / (identifier + '.json')
                result = json.loads(response.read_text()) if response.exists() else {'id': identifier, 'status': 'pending'}
                reply['result'] = tool_result(result)
            else:
                raise ValueError('Unknown tool')
        except (ValueError, TypeError, OSError):
            reply['result'] = tool_result({'error': 'Request rejected. Check the tool arguments and desktop connection.'}, True)
    else:
        reply['error'] = {'code': -32601, 'message': 'Method not found'}
    return reply


def mcp(directory):
    for line in sys.stdin:
        try:
            if len(line) > 16384:
                raise ValueError('Message too large')
            response = handle_rpc(json.loads(line), directory)
        except (ValueError, TypeError):
            response = {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'Invalid JSON'}}
        if response is not None:
            emit(response)


def relay(directory):
    import fcntl
    lock = (directory / 'relay.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    selector = selectors.DefaultSelector()
    selector.register(sys.stdin, selectors.EVENT_READ)
    seen = set()
    buffered = b''
    emit({'type': 'ready'})
    while True:
        for file in sorted((directory / 'requests').glob('*.json')):
            if file.stem in seen:
                continue
            response_file = directory / 'responses' / file.name
            if response_file.exists():
                seen.add(file.stem)
                continue
            request = validate_request(json.loads(file.read_text()))
            emit({'type': 'request', 'request': request})
            seen.add(file.stem)
        for _key, _events in selector.select(timeout=0.5):
            data = os.read(sys.stdin.fileno(), 16384)
            if not data:
                return
            buffered += data
            if len(buffered) > 65536:
                raise ValueError('Response buffer limit')
            while b'\n' in buffered:
                line, buffered = buffered.split(b'\n', 1)
                value = json.loads(line)
                identifier = value.get('id')
                if not isinstance(identifier, str) or not ID.fullmatch(identifier) or identifier not in seen:
                    continue
                if value.get('status') not in ('completed', 'denied', 'failed', 'expired'):
                    continue
                result = {'id': identifier, 'status': value['status']}
                if value.get('code') in ('TRANSFER_FAILED', 'OPEN_FAILED', 'REQUEST_EXPIRED', 'LOCAL_UNAVAILABLE'):
                    result['code'] = value['code']
                save(directory / 'responses' / (identifier + '.json'), result)


def artifact_stream(root, relative):
    validate_request({'id': '0' * 32, 'action': 'download', 'path': relative, 'reason': ''})
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    current = root_fd
    try:
        parts = relative.split('/')
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            if current != root_fd:
                os.close(current)
            current = child
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=current)
        with os.fdopen(fd, 'rb') as file:
            before = os.fstat(file.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_size > LIMIT:
                raise ValueError('Unsupported file')
            digest = hashlib.sha256()
            count = 0
            emit({'type': 'file', 'size': before.st_size})
            while True:
                data = file.read(48 * 1024)
                if not data:
                    break
                count += len(data)
                if count > LIMIT:
                    raise ValueError('File too large')
                digest.update(data)
                emit({'type': 'data', 'base64': base64.b64encode(data).decode('ascii')})
            after = os.fstat(file.fileno())
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or count != before.st_size:
                raise ValueError('File changed')
            emit({'type': 'end', 'sha256': digest.hexdigest(), 'size': count})
    finally:
        if current != root_fd:
            os.close(current)
        os.close(root_fd)


if __name__ == '__main__':
    os.umask(0o077)
    directory = Path(__file__).resolve().parent
    try:
        if sys.argv[1:] == ['relay']:
            relay(directory)
        elif sys.argv[1:] == ['artifact']:
            cfg = json.loads((directory / 'config.json').read_text())
            request = json.load(sys.stdin)
            artifact_stream(Path.home() / 'projects' / cfg['project'], request['path'])
        else:
            mcp(directory)
    except Exception:
        print('Desktop bridge unavailable; reconnect from DSH.', file=sys.stderr)
        sys.exit(1)
